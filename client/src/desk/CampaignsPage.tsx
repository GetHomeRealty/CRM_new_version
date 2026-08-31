import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../ui/Icon';
import { useSearchParams } from 'react-router-dom';
import {
  campaignOptions, listCampaigns, getCampaign, deleteCampaign, cancelScheduledCampaign,
  // `previewSegment` and `tagSegment` are no longer imported: the only caller was the Tag Leads
  // modal removed below. Both are still exported by `campaignsApi`, and the routes behind them
  // still exist — this screen simply no longer uses them.
  previewAudience, sendCampaign, trackingHealth, sendTestEmail,
} from '../lib/campaignsApi';
import { apiErrorMessage } from '../lib/apiError';
import { csvCell } from '../lib/csv';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from './ConfirmDialog';
import CampaignTemplates from './CampaignTemplates';
import SuppressionsPanel from './SuppressionsPanel';
import type {
  AudienceFilter, AudiencePreview, CampaignDetail, CampaignOptions,
  CampaignRecipientRow, CampaignSummary, TrackingHealth,
} from '../types';

const ANY = 'any';
const emptyForm = {
  name: '', template_id: '', categoryFilter: 'all', leadStatus: ANY, leadType: ANY, leadSource: ANY, clientType: ANY, tag: ANY,
  /** 'now' or 'later'. */
  sendMode: 'now',
  /** `datetime-local` value — local wall-clock, converted to an absolute instant on send. */
  sendAt: '',
};
type Form = typeof emptyForm;

/** The reader's own timezone, named. Shown next to every scheduled time so it is unambiguous. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A `datetime-local` value for `d`, in the browser's timezone.
 *
 * `toISOString` would give UTC, which the input reads as local — a Toronto user picking 9am would
 * see it come back as 5am. Subtracting the offset first makes the ISO text carry local wall-clock,
 * which is exactly what the input expects.
 */
const toLocalInput = (d: Date): string =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** The earliest time the picker will accept: a minute from now, since the send resolution is a minute. */
const earliestSend = () => toLocalInput(new Date(Date.now() + 60_000));

/** The three sections of this module, held in `?tab=`. */
type Tab = 'campaigns' | 'templates' | 'suppressions';

/**
 * Whether ANY axis has been narrowed.
 *
 * `ANY` on every filter resolves to an omitted filter, which the API correctly reads as "the whole
 * lead book" - so the composer's OPENING state was the entire brokerage, selected by nobody. This
 * is what tells "I have not chosen yet" apart from "I chose everyone", which the filters alone
 * cannot express.
 */
const hasNarrowed = (f: Pick<Form, 'leadStatus' | 'leadType' | 'leadSource' | 'clientType' | 'tag'>): boolean =>
  [f.leadStatus, f.leadType, f.leadSource, f.clientType, f.tag].some((v) => v !== ANY);

/**
 * The first readable words of a template body, for showing what is about to be sent.
 *
 * TAGS STRIPPED, because the point is the MESSAGE. A campaign body is styled HTML - header, panels,
 * a call-to-action, a footer - and the thing that went out to two real clients reading "Write your
 * message here." was surrounded by all of it. Rendering the markup would have shown a convincing
 * email; the text is what reveals an empty one.
 */
export const bodyExcerpt = (html: string | undefined, max = 220): string => {
  const text = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
};

/**
 * Whether a template still reads like the one it shipped as.
 *
 * NOT A BLOCK, A WARNING. A brokerage may have a legitimate reason to send something terse, and a
 * product that refuses to send what it was told to send is worse than one that asks. This only has
 * to be loud enough that nobody presses Send past it by accident, which is exactly what happened.
 */
export const looksUnwritten = (html: string | undefined): boolean =>
  /write your (message|content) here/i.test(bodyExcerpt(html, 400));

/** "any" is the UI's placeholder; the API expects an omitted filter. */
const toFilter = (f: Pick<Form, 'leadStatus' | 'leadType' | 'leadSource' | 'clientType' | 'tag'>): AudienceFilter => ({
  leadStatus: f.leadStatus === ANY ? '' : f.leadStatus,
  leadType: f.leadType === ANY ? '' : f.leadType,
  leadSource: f.leadSource === ANY ? '' : f.leadSource,
  clientType: f.clientType === ANY ? '' : f.clientType,
  tag: f.tag === ANY ? '' : f.tag,
});

const statusPill = (s: string) =>
  (s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'partial' ? 'warn' : s === 'sending' ? 'warn' : s === 'scheduled' ? 'info' : '');

/** Every timestamp from the API is an absolute instant; `toLocaleString` puts it in the reader's timezone. */
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

/** "in 3 hours" / "2 minutes ago" — the part of a scheduled time somebody actually reads. */
function relative(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(ms) / 60_000);
  const unit = mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'}`
    : mins < 1440 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}`
      : `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

export default function CampaignsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('campaigns', 'edit');

  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  /**
   * Which section is showing, held in the URL rather than local state.
   *
   * The sidebar lists Campaigns and Templates as sections of this module, and it can only point
   * at something addressable. Keeping it here also means the section survives a reload and can
   * be linked to; `replace` is used so switching does not stack history entries.
   */
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: Tab = rawTab === 'templates' || rawTab === 'suppressions' ? rawTab : 'campaigns';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'campaigns') p.delete('tab'); else p.set('tab', next);
    setParams(p, { replace: true });
  };
  const [tracking, setTracking] = useState<TrackingHealth | null>(null);
  const [checkingTracking, setCheckingTracking] = useState(false);
  /*
   * WHETHER THE OPEN FIGURES BELOW MEAN ANYTHING.
   *
   * The banner already says when tracking is broken, but it only renders on the campaigns tab -
   * and the detail modal opens straight from a notification link, so somebody can reach a
   * campaign's numbers having never passed the warning. Every place that prints an open count
   * therefore has to carry its own caveat, or a zero reads as "nobody opened it" when it means
   * "we did not measure". Those two lead to opposite decisions about a template.
   *
   * ONLY WHEN WE POSITIVELY KNOW. `tracking` is null while the check is in flight and if the
   * request failed, and "we could not ask" is not "it is broken" - claiming the figures are
   * unmeasured on a network blip would be its own kind of wrong.
   *
   * THE ERROR ONLY RUNS ONE WAY, which is what the wording has to respect. A pixel that cannot
   * load can only UNDERCOUNT: an open that IS recorded really did happen. So these figures are a
   * floor, not a fiction, and the caveat says 'at least' rather than 'unreliable'.
   */
  const opensUnmeasured = !!tracking && !tracking.ok;
  const [loading, setLoading] = useState(true);

  const [builder, setBuilder] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [audience, setAudience] = useState<AudiencePreview | null>(null);
  /*
   * DELIBERATELY SENDING TO EVERYBODY, as against arriving at it by opening the window.
   *
   * The composer opened pre-armed: every filter at "any", the count showing the whole lead table
   * and the primary button live and reading "Send to 10". Nobody had chosen that audience - it was
   * simply where the screen started, one careless click from mailing the entire database on a
   * screen whose only purpose is sending.
   *
   * Narrowing any axis is itself a choice, so it arms on its own. An unfiltered send is still
   * perfectly legitimate - a seasonal mailing to the whole book is the point of the feature - and
   * it stays available behind this one deliberate tick rather than being removed.
   */
  const [sendToEveryone, setSendToEveryone] = useState(false);
  /*
   * THE LAST THING BETWEEN THE BUTTON AND A HUNDRED CLIENTS.
   *
   * Every other irreversible act in this module asks first - deleting a campaign, cancelling a
   * schedule - while the one that actually mails people went straight out on a single click. This
   * holds what is about to happen so it can be read back: how many, whose leads, from which address
   * and under what subject.
   *
   * Null means no send is pending. Set only after every validation below has passed, so the dialog
   * cannot appear and then be refused for a missing name.
   */
  const [toSend, setToSend] = useState<null | {
    count: number; audience: string; sender: string; subject: string; opening: string; at: Date | null;
  }>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  /*
   * NAMES ONE COMMIT ATTEMPT, so a repeat cannot become a second campaign.
   *
   * `disabled={sending}` on the button below is still there and still worth having — it is what the
   * person watching the screen experiences. It is not, however, protection: a network retry, a
   * replayed request, a second tab or a direct call to the API all defeat it, and a duplicate
   * campaign means every recipient is emailed twice. So the server is authoritative, and this is
   * the handle it de-duplicates on.
   *
   * Minted when the builder OPENS, not per click: every retry of the same commit must send the same
   * key, while a genuinely new campaign gets a new one. That is what keeps two deliberately
   * identical campaigns a week apart from being collapsed into a single send.
   */
  const [commitKey, setCommitKey] = useState('');

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailView, setDetailView] = useState<'all' | 'opened' | 'unsubscribed' | 'bounced'>('all');
  const [sentEmail, setSentEmail] = useState<CampaignDetail | null>(null);
  const [toDelete, setToDelete] = useState<CampaignSummary | null>(null);
  const [toCancel, setToCancel] = useState<CampaignSummary | null>(null);

  // Pre-flight SMTP check — send one test email through the account a campaign would use.
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; from?: string; account?: string; error?: string } | null>(null);

  const runTestSend = () => {
    const to = testTo.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('Enter a valid email address.', 'bad'); return; }
    setTestBusy(true);
    setTestResult(null);
    sendTestEmail(to)
      .then((r) => {
        setTestResult(r);
        toast(r.ok ? 'Test email sent — your SMTP account works.' : 'Test send failed — see the details.', r.ok ? 'ok' : 'bad');
      })
      .catch((e) => { setTestResult({ ok: false, error: apiErrorMessage(e, 'Could not run the test send') }); })
      .finally(() => setTestBusy(false));
  };

  /**
   * Only the first fetch shows a loading screen. Refreshing after sending or deleting a campaign
   * updates the list in place, so the page does not appear to reload.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(() => {
    if (!loadedOnce.current) setLoading(true);
    listCampaigns().then(setCampaigns)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load campaigns'), 'bad'))
      .finally(() => { loadedOnce.current = true; setLoading(false); });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  /**
   * `?open=<id>` — where a Campaign Completed or Campaign Failed notification lands.
   *
   * A single campaign has no route of its own; the detail is this modal, opened from the list. So
   * the notification links here and names the campaign, and this opens it once the rows have
   * arrived — `campaigns` is the dependency because the id has to be matched against something.
   *
   * The parameter is consumed once and removed with `replace`, so the modal does not reopen every
   * time the list refreshes, and the Back button does not walk the user through reopening it.
   * `openedFromLink` guards against a second run while the same id is still in the URL.
   */
  const openedFromLink = useRef<number | null>(null);
  useEffect(() => {
    const raw = params.get('open');
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id <= 0 || !campaigns.length) return;
    if (openedFromLink.current === id) return;
    openedFromLink.current = id;

    const match = campaigns.find((c) => c.id === id);
    // A campaign that is not in the list is one this person cannot see, or one that has been
    // deleted since the notification was written. Say so plainly rather than opening nothing.
    if (match) void openDetail(match);
    else toast('That campaign is no longer available.', 'info');

    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [params, campaigns, setParams, toast]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    campaignOptions().then(setOptions).catch(() => { /* builder falls back */ });
    trackingHealth().then(setTracking).catch(() => { /* banner is informational */ });
  }, []);

  /*
   * Keep the list moving while something is in flight.
   *
   * A scheduled campaign becomes due, and a sending one works through its recipients (and its
   * bounce retries), entirely on the server — without this the screen would still be showing
   * "scheduled, in 2 minutes" an hour after it went out. Only armed when there is actually
   * something to watch, so an idle screen makes no requests.
   */
  const watching = campaigns.some((c) => c.status === 'scheduled' || c.status === 'sending');
  useEffect(() => {
    if (!watching || tab !== 'campaigns') return undefined;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [watching, tab, load]);

  const refreshOptions = () => { campaignOptions().then(setOptions).catch(() => {}); };

  // live audience count as the filters change
  useEffect(() => {
    if (!builder) return undefined;
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      previewAudience(toFilter(form))
        .then((a) => { if (!cancelled) setAudience(a); })
        .catch(() => { /* keep the last count */ })
        .finally(() => { if (!cancelled) setPreviewing(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [builder, form.leadStatus, form.leadType, form.leadSource, form.clientType, form.tag]); // eslint-disable-line react-hooks/exhaustive-deps

  const template = options?.templates.find((t) => String(t.id) === form.template_id);
  const fillable = useMemo(() => new Set(options?.fillable_tokens ?? []), [options]);
  const leadSourced = useMemo(() => new Set(options?.lead_sourced_tokens ?? []), [options]);
  const unfillable = (template?.variables ?? []).filter((v) => !fillable.has(v));
  const perLead = (template?.variables ?? []).filter((v) => leadSourced.has(v));
  const visibleTemplates = (options?.templates ?? []).filter((t) => form.categoryFilter === 'all' || t.category === form.categoryFilter);

  /**
   * Queued sends and everything else, kept apart.
   *
   * A scheduled campaign has no results yet — the card's delivered/opened/bounced counts would all
   * read zero, which looks like a campaign that failed rather than one that has not run. It gets
   * its own section above, showing the one fact that matters: when it goes.
   */
  const scheduled = useMemo(() => campaigns.filter((c) => c.status === 'scheduled'), [campaigns]);
  const history = useMemo(() => campaigns.filter((c) => c.status !== 'scheduled'), [campaigns]);

  const newCommitKey = () => (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const openBuilder = () => {
    // `setSendToEveryone(false)` on BOTH open paths: a tick left over from the last campaign would
    // re-arm this one before anybody had looked at it, which is the defect wearing a hat.
    setSendToEveryone(false);
    setForm(emptyForm); setAudience(null); setCommitKey(newCommitKey()); setBuilder(true); refreshOptions();
  };

  /** "Send" on a template card — jump to the campaign builder with that template preselected. */
  const useTemplate = (templateId: number) => {
    setTab('campaigns');
    setSendToEveryone(false);
    setForm({ ...emptyForm, template_id: String(templateId) });
    setAudience(null);
    setCommitKey(newCommitKey());
    setBuilder(true);
    refreshOptions();
  };

  /**
   * Check everything, then ASK - the send itself is `send()` below, unchanged.
   *
   * The validations are repeated rather than moved so that `send()` stays exactly what it was: a
   * confirmation step must not become a place where the rules quietly changed. They are cheap, and
   * running them here means a dialog never opens on a campaign that could not go anyway.
   */
  const requestSend = () => {
    if (!form.name.trim()) return toast('Name your campaign', 'bad');
    if (!form.template_id) return toast('Select a template', 'bad');
    if (!audience?.count) return toast('No recipients match this audience', 'bad');
    if (!hasNarrowed(form) && !sendToEveryone) {
      return toast('Choose an audience first, or tick the box to send to everyone', 'bad');
    }
    const scheduling = form.sendMode === 'later';
    if (scheduling && !form.sendAt) return toast('Pick the date and time to send at', 'bad');
    const at = scheduling ? new Date(form.sendAt) : null;
    if (at && Number.isNaN(at.getTime())) return toast('That send time could not be read', 'bad');
    if (at && at.getTime() < Date.now() - 60_000) return toast('Pick a time in the future', 'bad');

    return setToSend({
      // The server's count, not a local tally: `audience.count` is what `previewAudience` returned
      // for these exact filters, and it is the same query the send resolves against.
      count: audience.count,
      // The server's answer too - `brokerage_audience` is the capability the send path consults.
      audience: options?.brokerage_audience ? 'Brokerage-wide' : 'Your leads only',
      sender: options?.sender_email ?? 'the brokerage account',
      subject: template?.subject ?? '(the template subject)',
      // The opening words, so somebody who skipped the pane still sees the message at the moment
      // they commit to sending it.
      opening: bodyExcerpt(template?.content, 160),
      at,
    });
  };

  const send = async () => {
    if (!form.name.trim()) return toast('Name your campaign', 'bad');
    if (!form.template_id) return toast('Select a template', 'bad');
    if (!audience?.count) return toast('No recipients match this audience', 'bad');
    // Belt as well as braces: the button is disabled, but a keyboard submit or a stale render must
    // not be the only thing standing between an unchosen audience and the whole lead book.
    if (!hasNarrowed(form) && !sendToEveryone) {
      return toast('Choose an audience first, or tick the box to send to everyone', 'bad');
    }

    const scheduling = form.sendMode === 'later';
    if (scheduling && !form.sendAt) return toast('Pick the date and time to send at', 'bad');
    /*
     * `datetime-local` gives local wall-clock with no zone; `new Date` reads it in the browser's
     * timezone, and `toISOString` turns that into the absolute instant the server stores. The
     * round trip is what keeps "9am Tuesday" meaning 9am here rather than 9am UTC.
     */
    const at = scheduling ? new Date(form.sendAt) : null;
    if (at && Number.isNaN(at.getTime())) return toast('That send time could not be read', 'bad');
    // A minute of slack: the server treats a time that has just passed as "now", so this only
    // catches somebody genuinely picking yesterday.
    if (at && at.getTime() < Date.now() - 60_000) return toast('Pick a time in the future', 'bad');

    setSending(true);
    try {
      const c = await sendCampaign({
        name: form.name.trim(),
        template_id: Number(form.template_id),
        ...toFilter(form),
        tags: form.tag === ANY ? [] : [form.tag],
        scheduled_for: at ? at.toISOString() : null,
        idempotency_key: commitKey,
      });
      if (c.status === 'scheduled') {
        toast(`Campaign scheduled for ${when(c.scheduled_for)} — ${c.stats.total} recipient${c.stats.total === 1 ? '' : 's'}`, 'ok');
      } else {
        toast(`Campaign sent — ${c.stats.sent} delivered, ${c.stats.bounced} bounced`, c.stats.sent ? 'ok' : 'bad');
      }
      setBuilder(false);
      load();
    } catch (e) {
      toast(apiErrorMessage(e, scheduling ? 'The campaign could not be scheduled' : 'The campaign could not be sent'), 'bad');
    } finally { setSending(false); }
  };

  /**
   * Call off a campaign before it goes out.
   *
   * Only offered while it is still `scheduled` — once delivery starts some recipients already have
   * it, and the server refuses for the same reason. Cancelling leaves the campaign as a draft with
   * its audience and copy intact rather than deleting it.
   */
  const cancelSchedule = async () => {
    if (!toCancel) return;
    try {
      await cancelScheduledCampaign(toCancel.id);
      toast(`"${toCancel.name}" cancelled — it will not be sent.`, 'ok');
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not cancel the campaign'), 'bad');
    }
  };

  const openDetail = async (c: CampaignSummary, view: typeof detailView = 'all') => {
    try { setDetailView(view); setDetail(await getCampaign(c.id)); }
    catch (e) { toast(apiErrorMessage(e, 'Could not load the campaign'), 'bad'); }
  };

  const remove = async () => {
    if (!toDelete) return;
    try { await deleteCampaign(toDelete.id); toast('Campaign deleted', 'ok'); load(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not delete the campaign'), 'bad'); }
  };

  /** CSV report: campaign summary followed by every recipient's outcome. */
  const downloadReport = (c: CampaignDetail) => {
    // `csvCell`, not a local quoter. Recipient names and addresses in this report come from the same
    // untrusted intake as the lead list — Meta forms and CSV imports — and a cell beginning with `=`
    // is a formula to every spreadsheet. See `lib/csv`.
    const esc = csvCell;
    // Hard and soft are separate columns' worth of meaning in one field: one address is dead and
    // suppressed, the other is still being tried. A compliance export that says only "Bounced"
    // cannot tell them apart afterwards.
    const rowStatus = (r: CampaignRecipientRow) =>
      r.bounce_type === 'hard' ? 'Hard bounce (suppressed)'
        : r.bounce_type === 'soft' ? (r.status === 'pending' ? 'Soft bounce — retrying' : 'Soft bounce — gave up')
          : r.bounce_type === 'unknown' ? 'Send error (our mail account)'
            : r.unsubscribed ? 'Unsubscribed' : r.opened ? 'Opened' : r.status === 'sent' ? 'Sent' : r.status;
    const summary = [
      ['Campaign', c.name], ['Subject', c.subject], ['Status', c.status], ['Sent at', c.sent_at ?? ''],
      // "Sent", not "Delivered": SMTP accepts a message, it does not confirm it arrived. Bounces are
      // tracked separately, so the pair is honest — but on its own "Delivered" claims a receipt this
      // system has never had.
      ['Recipients', c.stats.total], ['Sent', c.stats.sent],
      // The caveat travels WITH the number, on the row above it. A spreadsheet outlives the screen
      // it was exported from, and this one gets mailed on to people who never saw the banner.
      ...(opensUnmeasured
        ? [['Open tracking', 'NOT WORKING when this report was produced - the Opened figures below are a minimum, not a count']]
        : []),
      [opensUnmeasured ? 'Opened (not measured)' : 'Opened', c.stats.opened],
      ['Bounced', c.stats.bounced], ['Unsubscribed', c.stats.unsubscribed],
    ].map((p) => p.map(esc).join(','));
    const header = ['Name', 'Email', 'Status', 'Sent', 'Opened', 'Bounced', 'Unsubscribed', 'Note'].map(esc).join(',');
    const rows = c.recipients.map((r) => [
      r.name, r.email, rowStatus(r),
      r.status === 'sent' && !r.bounced ? 'Yes' : 'No',
      r.opened ? 'Yes' : 'No', r.bounced ? 'Yes' : 'No', r.unsubscribed ? 'Yes' : 'No', r.error ?? '',
    ].map(esc).join(','));
    const blob = new Blob(['﻿' + [...summary, '', header, ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign-report-${(c.name || 'campaign').replace(/[^\w.-]+/g, '_').slice(0, 60)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const setF = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const filterSelect = (label: string, key: keyof Form, opts: string[]) => (
    <label className="report-field"><span>{label}</span>
      <select value={form[key]} onChange={(e) => setF(key, e.target.value)}>
        <option value={ANY}>Any</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  if (loading) return <div className="centered">Loading campaigns…</div>;

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Campaigns</h2>
            <div className="muted" style={{ fontSize: 13 }}>Send an email template to a segment of your leads.</div>
          </div>
          {/* Actions belong to the campaigns view; the template library has its own. */}
          {tab === 'campaigns' && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* Import Leads removed from Campaigns by request. Importing still lives on the Leads
                  screen, which is untouched — this only stops the same action being offered from a
                  screen about sending to an audience.

                  Tag Leads removed by request for the same reason. Tagging by SELECTION is still on
                  the Leads screen and is untouched; what has gone is tagging a whole segment from
                  here. The endpoint behind it is left in place — see the note at TagLeadsModal's
                  old position — so nothing that already calls it breaks. */}
              {canEdit && <button className="btn primary" onClick={openBuilder}>+ Create Campaign</button>}
            </div>
          )}
        </div>
      </div>

      {/* Two views, one at a time — the same tab pattern Email Settings uses. */}
      {/* The two section buttons that used to open this row have moved to the sidebar, which now
          lists Campaigns and Templates under this module. What is left here is an action, not
          navigation, so the row stays. */}
      <div className="toolbar"><div className="toolbar-row">
        {canEdit && (
          <button className="btn sm ghost" type="button"
            onClick={() => { setTestResult(null); setTestOpen(true); }} title="Verify your SMTP credentials before sending a campaign">
            ✉️ Send test email
          </button>
        )}
      </div></div>

      {tab === 'templates' && <CampaignTemplates options={options} onChanged={refreshOptions} onUse={useTemplate} />}
      {tab === 'suppressions' && <SuppressionsPanel />}

      {/* Open tracking dies silently when the public URL is unreachable — surface it, and let
          the result be re-checked on demand rather than only at page load. */}
      {tab === 'campaigns' && tracking && (
        <div
          className={tracking.ok && !tracking.ephemeral && !tracking.insecure ? 'reminder-ok'
            : tracking.ok ? 'reminder-warn' : 'import-error'}
          style={{ marginBottom: 12 }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <strong>
                {!tracking.ok ? 'Open tracking is not working'
                  : tracking.ephemeral ? 'Open tracking is using a temporary URL'
                  : tracking.insecure ? 'Open tracking is using an insecure address'
                  : 'Open tracking is live'}
              </strong>
              <div style={{ marginTop: 2 }}>{tracking.reason}</div>
              {tracking.url && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Pixel address: <code>{tracking.url}/api/campaigns/track/open</code>
                  {tracking.status ? ` · HTTP ${tracking.status}` : ''}
                </div>
              )}
              {!tracking.ok && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Set <code>CAMPAIGN_PUBLIC_URL</code> to a publicly reachable address and restart the API.
                  Emails already sent keep their old URL and cannot be fixed.
                </div>
              )}
            </div>
            <button
              className="btn ghost sm"
              type="button"
              disabled={checkingTracking}
              onClick={() => {
                setCheckingTracking(true);
                trackingHealth()
                  .then((h) => { setTracking(h); toast(h.ok ? 'Tracking pixel loaded successfully.' : 'The tracking pixel still could not be loaded.', h.ok ? 'ok' : 'bad'); })
                  .catch(() => toast('Could not run the tracking check', 'bad'))
                  .finally(() => setCheckingTracking(false));
              }}
            >
              {checkingTracking ? 'Checking…' : 'Re-check'}
            </button>
          </div>
        </div>
      )}

      {/*
        Scheduled campaigns, above the rest.
        A queued send is the one thing on this screen that is about to happen without anybody
        touching it, so it belongs where it is seen — not sorted in among months of history where
        the window to call it off would be missed. Times are rendered in the reader's own
        timezone and the zone is named, because "9:00" is only unambiguous once it says whose.
      */}
      {tab === 'campaigns' && scheduled.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <strong><Icon name="clock" size={14} /> Scheduled</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {scheduled.length} campaign{scheduled.length === 1 ? '' : 's'} waiting to go out · times shown in {LOCAL_TZ}
            </span>
          </div>
          <div className="camp-list" style={{ marginTop: 8 }}>
            {scheduled.map((c) => (
              <div key={c.id} className="camp-row">
                <div style={{ minWidth: 0 }}>
                  <button className="camp-name" onClick={() => openDetail(c)}>{c.name}</button>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.template_name ?? 'Template'} · {c.stats.total} recipient{c.stats.total === 1 ? '' : 's'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{when(c.scheduled_for)}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{relative(c.scheduled_for)}</div>
                  </div>
                  {canEdit && <button className="btn ghost sm" onClick={() => setToCancel(c)}>Cancel</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'campaigns' && (campaigns.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>No campaigns yet</h3>
          <p className="muted" style={{ fontSize: 13 }}>Create your first campaign to email a template to a group of leads.</p>
          {canEdit && <button className="btn primary" onClick={openBuilder}>+ Create Campaign</button>}
        </div>
      ) : history.length === 0 ? null : (
        <div className="camp-grid">
          {history.map((c) => (
            <div key={c.id} className="card camp-card">
              <div className="camp-card-top">
                <button className="camp-name" onClick={() => openDetail(c)}>{c.name}</button>
                <span className={`pill ${statusPill(c.status)}`}>{c.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {c.template_name ?? 'Template'}{c.tags[0] ? ` · ${c.tags[0]}` : ''}
              </div>
              <div className="camp-stats">
                {/*
                  EACH FIGURE UNDER ITS OWN NAME.
                  `stats.total` is the AUDIENCE and `stats.sent` is what actually went, and the card
                  used to label the first of them "sent to" — so a cancelled draft read "2 sent to ·
                  0 delivered" for a mailing that reached nobody, and a half-failed send of a hundred
                  read "100 sent to · 60 delivered" when forty never left.
                  Both readings mislead, and in opposite directions: one sends somebody chasing a
                  delivery problem that does not exist, the other persuades them a mailing went out
                  when it did not — and the natural response to that is to send it again, to real
                  clients.
                  An earlier pass made "sent to" conditional on `sent_at`, which fixed the draft and
                  left the partial-failure case wrong. Naming the audience an audience fixes both,
                  and needs no condition at all.
                */}
                <span title="how many people this campaign is addressed to">
                  <span className="camp-ico"><Icon name="users" size={12} /></span>
                  <strong>{c.stats.total}</strong> recipient{c.stats.total === 1 ? '' : 's'}
                </span>
                {/* "Sent", not "Delivered": SMTP accepts a message, it does not confirm arrival. */}
                <span className="good" title="accepted for delivery — bounces are counted separately">
                  <span className="camp-ico"><Icon name="check" size={12} /></span><strong>{c.stats.sent}</strong> sent
                </span>
                <span className={opensUnmeasured ? 'muted' : 'info'}
                  title={opensUnmeasured
                    ? 'Open tracking is not working, so this is the number of opens that happened to be recorded - the real figure is higher and cannot be measured until tracking is fixed.'
                    : 'opened'}>
                  <span className="camp-ico">✉️</span><strong>{c.stats.opened}</strong> opened
                  {opensUnmeasured && ' (not measured)'}
                </span>
                <span className="bad" title="bounced"><span className="camp-ico"><Icon name="alert" size={12} /></span><strong>{c.stats.bounced}</strong> bounced</span>
                <span className="warn" title="unsubscribed"><span className="camp-ico"><Icon name="close" size={12} /></span><strong>{c.stats.unsubscribed}</strong> unsub</span>
              </div>
              <div className="camp-actions">
                <button className="btn ghost sm" onClick={() => openDetail(c)}>View results</button>
                <button className="btn ghost sm" onClick={async () => { try { setSentEmail(await getCampaign(c.id)); } catch { toast('Could not load the sent email', 'bad'); } }}>View email</button>
                {canEdit && <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setToDelete(c)}><Icon name="trash" size={13} /></button>}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* ---- builder ---- */}
      {builder && options && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) setBuilder(false); }}>
          <div className="modal" style={{ maxWidth: 720 }}>
            <button className="close" onClick={() => setBuilder(false)} disabled={sending}>✕</button>
            <div className="modal-h">Create Campaign</div>

            <div className="field">
              <label>Campaign Name</label>
              <input value={form.name} onChange={(e) => setF('name', e.target.value)} placeholder="e.g. July market update — hot buyers" />
            </div>

            <div className="camp-section">
              <div className="camp-section-h">
                <strong>Template</strong>
                <select value={form.categoryFilter} onChange={(e) => setF('categoryFilter', e.target.value)} style={{ width: 'auto' }}>
                  <option value="all">All categories</option>
                  {[...new Set(options.templates.map((t) => t.category))].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <select value={form.template_id} onChange={(e) => setF('template_id', e.target.value)}>
                <option value="">Choose a template to send</option>
                {visibleTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {/*
                An empty picker has to say why. This library now offers only templates somebody
                created for a campaign — the shipped built-ins are no longer among them — so a
                brokerage that had never written one meets a dropdown with nothing in it. Left
                unexplained that reads as a broken screen rather than as a step they have not taken
                yet, and the step is one click away on the tab beside this one.
              */}
              {options.templates.length === 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  You have no campaign templates yet. Create one under{' '}
                  <strong>Campaigns → Templates → + Create Template</strong>.
                </div>
              )}
              {template && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Subject: {template.subject}</div>}
              {/*
                WHAT IS ACTUALLY GOING OUT.
                The composer named a message and offered a Send button without ever showing the
                message - which is how a template still holding its shipped placeholder reached two
                real clients, who both opened it. Shown as TEXT rather than rendered markup: the
                styling around that placeholder was perfect, and it was the styling that made it
                look like a finished email.
              */}
              {template && (
                <div style={{ marginTop: 8 }}>
                  {looksUnwritten(template.content) && (
                    <div className="import-error" style={{ marginBottom: 6 }}>
                      <strong>This template still has its placeholder text.</strong>
                      <p>
                        It reads like the message was never written. Sending it now would deliver
                        that text to every recipient — edit it under Campaigns → Templates first.
                      </p>
                    </div>
                  )}
                  <div className="help" style={{ marginBottom: 4 }}>Message preview</div>
                  <div
                    className="camp-preview"
                    style={{
                      fontSize: 12.5, lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
                      border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px',
                      background: 'var(--surface-2, #fafafa)', whiteSpace: 'pre-wrap',
                    }}
                  >
                    {template.content === undefined
                      ? 'The message could not be loaded — open the template to check it before sending.'
                      : bodyExcerpt(template.content, 600) || '(this template has no message body at all)'}
                  </div>
                </div>
              )}
              {unfillable.length > 0 && (
                <div className="reminder-warn" style={{ marginTop: 8 }}>
                  This template uses variables that can’t be auto-filled and will send blank:{' '}
                  {unfillable.map((v) => `{{${v}}}`).join(', ')}.
                </div>
              )}
              {perLead.length > 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Property variables ({perLead.map((v) => `{{${v}}}`).join(', ')}) are filled from each lead’s own
                  record — any lead missing a value gets a blank there.
                </div>
              )}
            </div>

            <div className="camp-section">
              <strong>Audience (lead segment)</strong>
              <div className="report-filters" style={{ marginTop: 8 }}>
                {filterSelect('Status', 'leadStatus', options.lead_status)}
                {/*
                  Lead type — buyer, seller, tenant, landlord and the rest. The form state, the
                  `toFilter` mapping and the server's `buildAudienceWhere` all handled `leadType`
                  already; the only thing missing was the control, so the filter existed everywhere
                  except where somebody could set it.
                */}
                {filterSelect('Lead type', 'leadType', options.lead_type)}
                {filterSelect('Source', 'leadSource', options.lead_source)}
                {filterSelect('Client type', 'clientType', options.client_type)}
                {/*
                  REAL TAGS ONLY. This used to union `tag_options` in, which is not tag data at all:
                  it is a hard-coded literal on the server — 'Pre Construction', 'Resale', 'Seller',
                  'Buyer', 'Tenant', 'Lease', 'Landlord', 'Realtor' — so the dropdown offered eight
                  values that no lead necessarily carried, and selecting one silently produced an
                  audience of nobody. `options.tags` is the CRM's own tag data: the Tags-screen
                  registry plus the tags actually in use, so a tag created but not yet applied can
                  still be audienced by. Already de-duplicated by the server.
                */}
                {filterSelect('Tag', 'tag', options.tags)}
              </div>
              <div className="camp-audience">
                {previewing ? <span className="muted">Counting recipients…</span> : (
                  <span>
                    {/* The verb agrees too: "1 recipient match" was written only in the plural. */}
                    <strong>{audience?.count ?? 0}</strong> recipient{(audience?.count ?? 0) === 1 ? ' matches' : 's match'} this segment
                    {audience?.sample?.length ? <span className="muted"> — e.g. {audience.sample.slice(0, 3).map((s) => s.name || s.email).join(', ')}</span> : null}
                  </span>
                )}
              </div>
              {/*
                WHOSE LEADS THESE ARE, said plainly to the people it limits.
                An agent's campaigns reach their own book and no further, which is deliberate - but
                the screen was identical to the broker's and never mentioned it, so a recipient count
                with no stated scope read as though it might be the whole database. Only shown to
                those it actually constrains; telling a broker their reach is brokerage-wide is
                noise.
              */}
              {options.brokerage_audience === false && (
                <p className="help" style={{ marginTop: 6 }}>
                  Your campaigns reach <strong>your own leads only</strong> — the count above is from
                  your book, not the brokerage's.
                </p>
              )}
              {/*
                Shown only while nothing has been narrowed, which is the state that used to be armed
                by default. The count is still displayed above - knowing how large the book is is
                useful - but it is not a SELECTION until somebody says so here.
              */}
              {!hasNarrowed(form) && (
                <label className="camp-audience-all" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8 }}>
                  <input
                    type="checkbox" checked={sendToEveryone}
                    onChange={(e) => setSendToEveryone(e.target.checked)}
                  />
                  <span>
                    <strong>No audience filter is set.</strong>{' '}
                    Tick to send to all {audience?.count ?? 0} lead{(audience?.count ?? 0) === 1 ? '' : 's'} you can reach,
                    or narrow the segment above.
                  </span>
                </label>
              )}
            </div>

            {/*
              When to send.
              Copy gets written when the agent has time, which is rarely when it should go out —
              Tuesday morning beats Friday evening, and nobody is at their desk for either.
              The picker is local wall-clock and the timezone is named beneath it, because a send
              time that does not say whose clock it is on is a send time nobody can trust.
            */}
            <div className="camp-section">
              <strong>When to send</strong>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="radio" name="sendMode" checked={form.sendMode === 'now'}
                    onChange={() => setForm((f) => ({ ...f, sendMode: 'now' }))} />
                  Send now
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="radio" name="sendMode" checked={form.sendMode === 'later'}
                    onChange={() => setForm((f) => ({ ...f, sendMode: 'later', sendAt: f.sendAt || earliestSend() }))} />
                  Schedule for later
                </label>
              </div>
              {form.sendMode === 'later' && (
                <div style={{ marginTop: 8 }}>
                  <input
                    type="datetime-local"
                    value={form.sendAt}
                    min={earliestSend()}
                    onChange={(e) => setF('sendAt', e.target.value)}
                    style={{ maxWidth: 260 }}
                  />
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Your local time ({LOCAL_TZ}){form.sendAt && !Number.isNaN(new Date(form.sendAt).getTime())
                      ? ` — goes out ${relative(new Date(form.sendAt).toISOString())}` : ''}.
                    {' '}The audience is fixed now, and the message is sent exactly as written here even if the
                    template changes before then. Checked every minute, so the send may be up to a minute late.
                  </div>
                </div>
              )}
            </div>

            <div className="actions">
              <button className="btn ghost" onClick={() => setBuilder(false)} disabled={sending}>Cancel</button>
              <button
                className="btn primary" onClick={requestSend}
                disabled={sending || !audience?.count || (!hasNarrowed(form) && !sendToEveryone)}
              >
                {sending ? (form.sendMode === 'later' ? 'Scheduling…' : 'Sending…')
                  : form.sendMode === 'later' ? `Schedule for ${audience?.count ?? 0}` : `Send to ${audience?.count ?? 0}`}
              </button>
            </div>
            {sending && form.sendMode === 'now' && <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Sending in sequence to respect mail limits — keep this open until it finishes.</p>}
          </div>
        </div>
      )}

      {/* ---- results ---- */}
      {detail && (() => {
        const r = detail.recipients;
        const list = detailView === 'opened' ? r.filter((x) => x.opened)
          : detailView === 'unsubscribed' ? r.filter((x) => x.unsubscribed)
            : detailView === 'bounced' ? r.filter((x) => x.bounced || x.status === 'failed') : r;
        const tile = (key: typeof detailView, value: number, label: string, cls: string) => (
          <button type="button" className={`camp-tile ${cls}${detailView === key ? ' on' : ''}`} onClick={() => setDetailView(key)}>
            <strong>{value}</strong><span>{label}</span>
          </button>
        );
        return (
          <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
            <div className="modal" style={{ maxWidth: 720 }}>
              <button className="close" onClick={() => setDetail(null)}>✕</button>
              <div className="modal-h">
                {detail.name} <span className={`pill ${statusPill(detail.status)}`}>{detail.status}</span>
                <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => downloadReport(detail)}>Download report</button>
              </div>
              <div className="camp-tiles">
                {tile('all', detail.stats.total, 'Recipients', '')}
                {tile('all', detail.stats.sent, 'Sent', 'good')}
                {tile('opened', detail.stats.opened, opensUnmeasured ? 'Opened (not measured)' : 'Opened', opensUnmeasured ? '' : 'info')}
                {tile('bounced', detail.stats.bounced, 'Bounced', 'bad')}
                {tile('unsubscribed', detail.stats.unsubscribed, 'Unsubscribed', 'warn')}
              </div>
              {opensUnmeasured && (
                /* Said here as well as on the tile, because this modal is reachable from a
                   notification link without passing the banner on the page behind it. */
                <div className="help" style={{ color: 'var(--warn-ink-alt)' }}>
                  ⚠ Open tracking is not working, so the Opened figure counts only what happened to
                  be recorded. Treat it as a minimum, not a result - and do not compare it with a
                  campaign sent while tracking was working.
                </div>
              )}
              <div className="muted" style={{ fontSize: 13 }}><strong>Subject:</strong> {detail.subject}</div>
              <div className="camp-list">
                {list.length === 0 ? <div className="help">No one in this group yet.</div> : list.map((x) => (
                  <div key={x.id} className="camp-row">
                    <div style={{ minWidth: 0 }}>
                      <strong>{x.name || x.email}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>{x.email}</div>
                      {x.error && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{x.error}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {x.opened && <span className="pill info">Opened</span>}
                      {x.unsubscribed && <span className="pill warn">Unsub</span>}
                      {/*
                        The three failures read very differently and must not share one label.
                        A hard bounce is a dead mailbox and the address is now suppressed; a soft
                        one is queued for another attempt; "unknown" is our own mail server and
                        says nothing about the recipient. Calling all three "Bounced" is what once
                        made an expired SMTP password look like a dead list.
                      */}
                      {x.bounce_type === 'hard' ? <span className="pill bad" title="The mailbox does not exist. This address has been added to the suppression list.">Hard bounce</span>
                        : x.bounce_type === 'soft' && x.status === 'pending' ? (
                          <span className="pill warn" title={x.next_retry_at ? `Next attempt ${when(x.next_retry_at)}` : 'Queued for another attempt'}>
                            Retrying{x.retry_count ? ` (${x.retry_count})` : ''}
                          </span>
                        )
                          : x.bounce_type === 'soft' ? <span className="pill bad" title="The receiving server kept deferring us. The address is not suppressed.">Deferred — gave up</span>
                            : x.bounce_type === 'unknown' ? <span className="pill bad" title="A problem with our mail account or connection, not with this address.">Send error</span>
                              : (
                                <span className={`pill ${x.status === 'sent' ? 'ok' : ''}`}>
                                  {x.status === 'sent' ? 'Sent' : x.status === 'failed' ? 'Failed' : 'Pending'}
                                </span>
                              )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---- sent email preview ---- */}
      {sentEmail && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setSentEmail(null); }}>
          <div className="modal" style={{ maxWidth: 760 }}>
            <button className="close" onClick={() => setSentEmail(null)}>✕</button>
            <div className="modal-h">Email sent — {sentEmail.name}</div>
            <div className="camp-meta">
              <div><span className="muted">Subject</span><strong>{sentEmail.subject}</strong></div>
              <div><span className="muted">Template</span>{sentEmail.template_name ?? '—'}</div>
              <div><span className="muted">Sent to</span>{sentEmail.stats.total} recipient{sentEmail.stats.total === 1 ? '' : 's'}</div>
              <div><span className="muted">Sent on</span>{when(sentEmail.sent_at)}</div>
            </div>
            {/* Locked-down iframe: `sandbox` with no tokens blocks scripts, forms and
                same-origin access, so stored template HTML can't execute against the app. */}
            <iframe title="Sent email preview" sandbox="" srcDoc={sentEmail.content} className="camp-preview" />
            <p className="muted" style={{ fontSize: 12 }}>
              Personalisation tokens such as {'{{LEAD_NAME}}'} are shown unresolved — each recipient received their own filled-in version.
            </p>
          </div>
        </div>
      )}


      {testOpen && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !testBusy) setTestOpen(false); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <button className="close" onClick={() => setTestOpen(false)} disabled={testBusy}>✕</button>
            <div className="modal-h">Send test email</div>
            <div className="field">
              <label>Send a test to</label>
              <input type="email" value={testTo} autoFocus placeholder="you@example.com"
                onChange={(e) => setTestTo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !testBusy) runTestSend(); }} />
              <div className="help">
                Sends one message through the exact SMTP account your campaigns use, so you can confirm the
                credentials work <strong>before</strong> sending to real leads. Nothing is saved and no lead is contacted.
              </div>
            </div>
            {testResult && (
              <div className={testResult.ok ? 'reminder-ok' : 'import-error'} style={{ marginTop: 4 }}>
                {testResult.ok ? (
                  <div>
                    <strong><Icon name="check" size={13} /> Sent successfully.</strong>
                    <div style={{ marginTop: 2, fontSize: 13 }}>
                      From <strong>{testResult.from}</strong>{testResult.account ? ` (account: ${testResult.account})` : ''}. Check the inbox — your SMTP credentials are valid.
                    </div>
                  </div>
                ) : (
                  <div>
                    <strong><Icon name="alert" size={13} /> Could not send.</strong>
                    <div style={{ marginTop: 2, fontSize: 13, wordBreak: 'break-word' }}>{testResult.error}</div>
                    {/535|BadCredentials|Username and Password/i.test(testResult.error ?? '') && (
                      <div style={{ marginTop: 4, fontSize: 12 }}>
                        Gmail rejected the login. Generate a fresh <strong>App Password</strong> (Google Account → Security →
                        2-Step Verification → App passwords) and update it on your mail account in Settings.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="actions">
              <button className="btn ghost" onClick={() => setTestOpen(false)} disabled={testBusy}>Close</button>
              <button className="btn primary" onClick={runTestSend} disabled={testBusy || !testTo.trim()}>{testBusy ? 'Sending…' : 'Send test'}</button>
            </div>
          </div>
        </div>
      )}

      {/*
        WHAT IS ABOUT TO LEAVE THE BUILDING, in the four terms somebody would want to check.
        Every figure here comes from the server: the count from `previewAudience`, the scope from
        the capability the send path consults, the sender from the mailer's own resolution. A dialog
        that described the send from the browser's assumptions could reassure somebody about a
        campaign that was going somewhere else.
      */}
      <ConfirmDialog
        confirm={toSend ? {
          title: toSend.at ? 'Schedule this campaign?' : 'Send this campaign?',
          message: `You are sending this campaign to ${toSend.count} lead${toSend.count === 1 ? '' : 's'}.`,
          body: (
            <dl className="camp-confirm" style={{ margin: '10px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px' }}>
              <dt className="muted">Audience</dt><dd style={{ margin: 0 }}>{toSend.audience}</dd>
              <dt className="muted">Sender</dt><dd style={{ margin: 0 }}>{toSend.sender}</dd>
              <dt className="muted">Subject</dt><dd style={{ margin: 0 }}>{toSend.subject}</dd>
              {toSend.opening && (
                <>
                  <dt className="muted">Opens with</dt>
                  <dd style={{ margin: 0 }}>{toSend.opening}</dd>
                </>
              )}
              {toSend.at && (<><dt className="muted">Goes out</dt><dd style={{ margin: 0 }}>{toSend.at.toLocaleString()}</dd></>)}
            </dl>
          ),
          confirmLabel: toSend.at ? 'Confirm schedule' : 'Confirm Send',
          // Sending a campaign is a normal action, not a destruction. Painting it in the same red
          // as Delete Forever teaches people that red simply means "press this to continue".
          variant: 'primary',
          onConfirm: () => {
            // `sending` is re-checked because the dialog is not the only guard: the server also
            // de-duplicates on `idempotency_key`, and both matter. Nothing here re-implements the
            // send - it calls the same function the button used to.
            if (!sending) void send();
          },
        } : null}
        onClose={() => setToSend(null)}
      />

      <ConfirmDialog
        confirm={toDelete ? {
          title: 'Delete this campaign?',
          message: `"${toDelete.name}" and its send results will be permanently removed. Emails already sent are not affected.`,
          onConfirm: remove,
        } : null}
        onClose={() => setToDelete(null)}
      />

      <ConfirmDialog
        confirm={toCancel ? {
          title: 'Cancel this scheduled campaign?',
          message: `"${toCancel.name}" was due to go out ${when(toCancel.scheduled_for)} to ${toCancel.stats.total} recipient${toCancel.stats.total === 1 ? '' : 's'}. It will not be sent. The campaign is kept as a draft, so nothing you wrote is lost.`,
          onConfirm: cancelSchedule,
        } : null}
        onClose={() => setToCancel(null)}
      />
    </>
  );
}

/*
 * `TagLeadsModal` — "Tag Leads by Segment" — was removed from this screen by request.
 *
 * WHAT WENT: only the control. The route it called (`POST /campaigns/segment/tag`, reached through
 * `tagSegment` in `lib/campaignsApi.ts`) is deliberately LEFT IN PLACE. Deleting a working endpoint
 * because the button in front of it went away is a larger change than was asked for, and it is the
 * kind that breaks a caller nobody remembered.
 *
 * WHAT DID NOT GO: tagging leads by SELECTION on the Leads screen, which is a different feature in
 * a different module and is untouched. What is gone is applying a tag to a whole segment from the
 * Campaigns screen.
 */
