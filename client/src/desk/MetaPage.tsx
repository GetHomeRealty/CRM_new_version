import { crmPath } from './area';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  disconnectMeta, metaAuthUrl, metaDiagnostics, metaForms, metaLeads, metaPages, metaStatus,
  metaWebhookHealth, refreshMetaPages, setMetaDefaultPage, syncMetaLeads, toggleMetaForm,
} from '../lib/metaApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type {
  MetaDiagnostics, MetaForm, MetaLeadRow, MetaPage as MetaPageInfo, MetaStatus, MetaWebhookHealth,
} from '../types';

/** What each `meta_error` code from the OAuth callback means to a person. */
const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the Facebook sign-in, or declined a permission.',
  not_configured: 'Meta is not configured on this server yet.',
  missing_code: 'Facebook did not return an authorization code. Try again.',
  invalid_state: 'That sign-in link expired or was already used. Start the connection again.',
  account_unavailable: 'Your CRM account is no longer active, so the connection was not saved.',
  connect_failed: 'Facebook accepted the sign-in but the connection could not be completed. Open Diagnostics for the reason.',
};

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/**
 * The Page this brokerage wants first when nothing else has been chosen.
 *
 * MATCHED BY NAME, which is the weak part and is worth knowing: rename the Page on Facebook and
 * this stops matching, silently, and the first Page in the list is used instead. That is a
 * degradation rather than a failure — the screen still works and still lists every Page — but the
 * only signal is that the dropdown opens somewhere unexpected. Meta's own Page id would be stable,
 * and is the better key if this ever needs to be dependable.
 *
 * It is a FALLBACK, never an override: a Page the person actually chose wins, or remembering the
 * choice at all would be pointless.
 */
const DEFAULT_PAGE_NAME = 'BUY EASY Realty';

/**
 * The brokerage's own Pages, in the order they belong at the top of the dropdown. Everything else
 * follows in whatever order Meta returned it.
 *
 * MATCHED WHOLE, NOT BY PREFIX, and that is load-bearing here: this connection also carries
 * "Get Home Realty Telugu", which a `startsWith` would pull up alongside "Get Home Realty" and put
 * above Pages that were meant to rank higher. Names are compared trimmed and case-insensitively, so
 * a stray space or a capitalisation change on Facebook does not quietly drop a Page to the bottom.
 */
const PAGE_ORDER = ['BUY EASY Realty', 'Get Home Realty'];

/**
 * The form last looked at, for the length of this browser session.
 *
 * `sessionStorage`, NOT `localStorage` and not the database, and the difference is the point:
 *
 *   - The URL alone was not enough. It carries the filter through Back and a reload, but coming
 *     back through the sidebar lands on a bare /crm/meta with nothing to restore from — which is
 *     exactly the journey that was reported.
 *   - `localStorage` would outlive the session and follow the next person to sign in on a shared
 *     machine, which is what the Page preference had to be moved off.
 *   - The database would make a filter permanent, and the tiles above the list stay unfiltered
 *     totals; opening the screen next week still narrowed to one form invites reading the two as
 *     the same number.
 *
 * A working session is the span over which "the form I was looking at" is still true, so the value
 * dies with the tab. It is never trusted on its own: it seeds the URL only when the form is one
 * this Page actually returned.
 */
const FORM_KEY = 'meta_last_form';

const pageRank = (name: string): number => {
  const n = name.trim().toLowerCase();
  const i = PAGE_ORDER.findIndex((x) => x.trim().toLowerCase() === n);
  return i === -1 ? PAGE_ORDER.length : i;
};

export default function MetaPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useAuth();
  const canEdit = can('meta', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [params, setParams] = useSearchParams();

  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [pages, setPages] = useState<MetaPageInfo[]>([]);
  /**
   * The list as the dropdown shows it. `Array.prototype.sort` is stable, so Pages outside
   * `PAGE_ORDER` keep the order Meta gave them rather than being shuffled among themselves.
   *
   * `pages` itself is left alone: it stays the answer to "what does this connection have", which is
   * what the validity checks ask, and only the presentation is ordered.
   */
  const orderedPages = useMemo(
    () => [...pages].sort((a, b) => pageRank(a.name) - pageRank(b.name)),
    [pages],
  );

  /** False only until the first `metaPages()` answers; a later Refresh does not reset it. */
  const [pagesReady, setPagesReady] = useState(false);
  /**
   * WHICH PAGE THIS SCREEN REOPENS ON.
   *
   * Empty until `status.default_meta_page_id` arrives — the person's own choice, stored on their
   * `meta_connections` row, so it follows them to another machine.
   *
   * THIS LIVED IN `localStorage` FIRST AND COULD NOT TELL ONE USER FROM ANOTHER. That is per
   * browser, and three people hold separate Meta connections here, so signing out and in on a
   * shared machine inherited somebody else's Page. Reading it at first render also meant the id
   * arrived before the Page list did, with nothing to check it against.
   *
   * NOTHING IS FETCHED WITH IT UNTIL THE CONNECTION CONFIRMS IT. A stored Page can be removed or
   * lose its permissions, and `metaForms(staleId)` against a Page this person cannot read is an
   * error toast on arrival, before they have touched anything. The effects below wait for the list
   * and check the id against it, so a stale preference costs nothing.
   */
  const [selectedPage, setSelectedPage] = useState('');
  const [forms, setForms] = useState<MetaForm[]>([]);
  const [leads, setLeads] = useState<MetaLeadRow[]>([]);
  const [leadStats, setLeadStats] = useState({ total: 0, today: 0, week: 0 });
  const [diagnostics, setDiagnostics] = useState<MetaDiagnostics | null>(null);
  /*
   * THE STATUS ENDPOINT CANNOT ANSWER THIS, which is why it is fetched separately.
   *
   * `/api/meta/status` reports the CONNECTION: token valid, permissions granted, pages readable.
   * All of that can be perfectly true while not one lead has ever been delivered - and it was, for
   * as long as this integration has existed. This screen showed Account, Pages, Connected, Last
   * sync and Leads synced, every one of them green, and never mentioned that the push had never
   * fired. `/api/meta/webhook-health` is the only endpoint that knows, and nothing consulted it.
   */
  const [webhook, setWebhook] = useState<MetaWebhookHealth | null>(null);
  /*
   * The lead form whose leads the list below is showing, or null for every Meta lead. Picked by
   * clicking a form. The tiles stay the whole module's counts either way — the API filters the list
   * only — so clicking a form never changes what "Meta leads" means.
   */
  /**
   * The form whose leads the list is showing, or null for all of them.
   *
   * DERIVED FROM THE URL, not set directly. `?form=<id>` is the source of truth, because this state
   * used to die with the component: open a lead, come back, and the screen was unfiltered again —
   * the selection existed only in memory and nothing outlived the unmount. In the URL it survives
   * leaving and returning, a reload, and Back, and the link can be handed to somebody else.
   *
   * The NAME is kept alongside the id because the heading reads "Leads from <name> (n)" and the row
   * needs it for its label and highlight; it is resolved from the loaded forms rather than stored,
   * so it can never disagree with what Meta currently calls that form.
   */
  const [formFilter, setFormFilter] = useState<{ id: string; name: string } | null>(null);
  const [formTotal, setFormTotal] = useState<number | null>(null);
  /*
   * WHY THE LIST NOW REMEMBERS THAT IT FAILED.
   *
   * `loadLeads` swallowed every error, so a request that never returned rows rendered exactly like
   * one that returned none: "No leads from this form are in the CRM yet. Only connected forms are
   * synced - connect it and press Sync Now to bring them in."
   *
   * Observed on a database missing a migration: `/api/meta/leads` answered 500 with
   * `The column leads.lead_estimation does not exist`, and the screen said there were no leads for a
   * form that had 32. Every clause of that sentence was false - the form WAS connected, the leads
   * WERE in the CRM, and Sync Now could not have helped - and it sent the reader to fix the one
   * thing that was not broken.
   *
   * Swallowing stays right for the connection panel, which is what the screen is for; what was wrong
   * was reporting the failure as an answer.
   */
  const [leadsError, setLeadsError] = useState('');
  /*
   * "NOT FETCHED YET" IS NOT "NONE", and the list must never say the second while it means the
   * first. Without this an empty `leads` renders "No Meta leads yet." on the way to the real
   * answer — a worse statement than the flicker it replaces, because it reads as a fact.
   */
  const [leadsLoaded, setLeadsLoaded] = useState(false);
  /*
   * Distinguishes "the form list has not come back yet" from "this Page has no forms". Both are an
   * empty `forms`, and only the second means a remembered form can never be restored.
   */
  const [formsLoaded, setFormsLoaded] = useState(false);
  /*
   * A form this visit is expected to restore — from the URL, or from what the session remembers.
   * Read once, at mount, because it decides whether the leads request must WAIT for the form list.
   */
  const [rememberedForm] = useState(() => {
    try { return sessionStorage.getItem(FORM_KEY) || ''; } catch { return ''; }
  });
  const leadsRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const loadStatus = useCallback(async () => {
    try { setStatus(await metaStatus()); } catch (ex) { toast(apiErrorMessage(ex, 'Could not read Meta status'), 'bad'); }
    // Silent on failure: this is a supplementary warning, and a screen that cannot reach one
    // endpoint should not lose the connection panel it came for.
    try { setWebhook(await metaWebhookHealth(5)); } catch { /* warning is supplementary */ }
  }, [toast]);

  const loadLeads = useCallback(async () => {
    try {
      // 200 for one form, the API's ceiling: that view is about the form's whole set, where the
      // unfiltered list is only the most recent arrivals.
      const res = await metaLeads(formFilter ? 200 : 50, formFilter?.id, selectedPage || undefined);
      setLeads(res.data);
      setLeadStats(res.stats);
      setFormTotal(res.form_total ?? null);
      setLeadsError('');
    } catch (ex) {
      // Still no toast: the connection panel is what this screen is for, and a toast on every
      // reload would be noise. The list says so itself, where the missing rows would have been.
      setLeads([]);
      setFormTotal(null);
      setLeadsError(apiErrorMessage(ex, 'Could not load Meta leads'));
    } finally {
      setLeadsLoaded(true);
    }
  }, [formFilter, selectedPage]);

  useEffect(() => {
    void (async () => {
      await loadStatus();
      setLoading(false);
    })();
    // Once on arrival. The leads follow below, once it is settled what they are meant to be OF.
  }, [loadStatus]);

  /**
   * RESTORE FIRST, THEN FETCH ONCE — the list is never shown for a scope that is about to change.
   *
   * Asking too early answered the wrong question and corrected itself in public: a request with no
   * Page returned every Meta lead, so 66 rows appeared and were replaced a moment later by that
   * Page's 32. Two requests, and a number somebody could read and act on before it moved.
   *
   * `pageKnown` — the Page is settled. A DISCONNECTED ACCOUNT IS SETTLED IMMEDIATELY, and that case
   * is why this is not simply `pagesReady`: `metaPages()` never runs without a connection, so
   * `pagesReady` would stay false for ever and the list would never load at all — for the people
   * whose historical Meta leads are the only reason they opened the screen.
   *
   * `formKnown` — nothing is waiting to be restored, or the form list has come back so the waiting
   * is over. Only a visit that HAS a form to restore pays for this; an ordinary one does not wait on
   * Graph. Bounded either way, because `formsLoaded` is set on failure as well as success.
   */
  const pageKnown = !!status && (!status.is_connected
    || (pagesReady && (orderedPages.length === 0 || selectedPage !== '')));
  const formKnown = !status?.is_connected || !rememberedForm || formsLoaded;
  const scopeReady = pageKnown && formKnown;

  useEffect(() => { if (scopeReady) void loadLeads(); }, [loadLeads, scopeReady]);

  /**
   * Remembering is deliberately tied to an EXPLICIT choice, not to `selectedPage` changing.
   *
   * Saving from an effect would also record the automatic fallback, so a load that could not honour
   * the stored Page would overwrite it — and the Page somebody actually wanted would be lost by the
   * very load that failed to restore it.
   *
   * THE SCREEN MOVES FIRST AND THE SAVE FOLLOWS. This is a view preference: waiting on a round trip
   * to change a dropdown would make the screen feel broken, and a save that fails costs nothing the
   * person needs right now. It is reported rather than swallowed, so "it keeps forgetting my Page"
   * has an answer.
   */
  const choosePage = (id: string) => {
    setSelectedPage(id);
    void setMetaDefaultPage(id)
      .catch((ex) => toast(apiErrorMessage(ex, 'Could not remember that Page'), 'bad'));
  };

  /**
   * Writes the chosen form to the URL. `replace` rather than push, so narrowing the list does not
   * fill the Back button with filter states somebody then has to press their way out of.
   *
   * Other params are preserved: the OAuth callback puts its own on this route, and clobbering them
   * would swallow the message it came back to show.
   */
  const setFormParam = useCallback((id: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('form', id); else next.delete('form');
      return next;
    }, { replace: true });
    // Written on the way past, so leaving by any route remembers it. Clearing the filter clears
    // this too — "Show all" must not be undone by the next visit.
    try {
      if (id) sessionStorage.setItem(FORM_KEY, id); else sessionStorage.removeItem(FORM_KEY);
    } catch { /* unavailable in private mode; the URL still carries it */ }
  }, [setParams]);

  /**
   * OPENING A LEAD SAYS WHERE IT WAS OPENED FROM, so Back can come back here rather than to the
   * Leads module. Without it the lead detail has no way to tell a lead reached from Meta from one
   * reached from the Leads list, and its Back button was written for the second.
   *
   * CARRIED IN THE URL, not in router state, for one reason: router state does not survive a
   * refresh. Somebody reading a lead, reloading, and pressing Back would be returned to the Leads
   * module — the exact failure this is meant to fix, appearing only sometimes, which is worse than
   * it never working.
   *
   * `location.search` goes along with the path, so the FORM FILTER comes back too. The Page needs
   * no carrying: it is stored against the person and restores itself.
   */
  const openLead = (leadId: number) => {
    const back = `${location.pathname}${location.search}`;
    navigate(`${crmPath(`lead/${leadId}`)}?returnTo=${encodeURIComponent(back)}`);
  };

  /** Clicking a form shows its leads; clicking the same form again goes back to all of them. */
  const showForm = (f: MetaForm) => {
    setFormParam(formFilter?.id === f.id ? null : f.id);
    leadsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The OAuth callback redirects back here with the outcome in the query string.
  useEffect(() => {
    const connected = params.get('meta_connected');
    const error = params.get('meta_error');
    const warning = params.get('meta_warning');
    if (!connected && !error) return;

    if (connected) {
      toast(warning === 'no_pages'
        ? 'Connected, but no Facebook Pages were found. Sign in with an account that administers a Page.'
        : 'Meta connected. Pick a Page and choose which lead forms to read.', warning ? 'info' : 'ok');
      void loadStatus();
    } else if (error) {
      toast(OAUTH_ERRORS[error] ?? `Connection failed (${error}).`, 'bad');
    }
    // Clear the params so a refresh doesn't replay the toast.
    setParams({}, { replace: true });
  }, [params, setParams, toast, loadStatus]);

  useEffect(() => {
    if (!status?.is_connected) return;
    metaPages().then((p) => {
      // Reporting the list is all this does; the effect below decides what is selected.
      setPages(p);
    }).catch(() => setPages([])).finally(() => setPagesReady(true));
  }, [status?.is_connected]);

  /**
   * WHICH PAGE IS SELECTED — decided in one place, reacting to the LIST rather than to one fetch.
   *
   * `pages` is set from three places: the first load, Refresh, and disconnect. Only the first used
   * to revisit the selection, so a REFRESH THAT DROPPED THE SELECTED PAGE left `selectedPage`
   * naming a Page no longer in the list: `<select>` matched no `<option>` and rendered blank, while
   * the forms effect below went on asking for a Page that was gone.
   *
   * Reacting here covers all three, and covers the Page stored on this person's connection by the
   * same rule — nothing has to know where the current value came from. A Page that was removed or
   * lost its permissions falls to the first, exactly as if nothing had been remembered.
   *
   * The stored value is deliberately NOT cleared when that happens: it costs nothing while it is
   * invalid, and it comes back by itself if the Page returns to the connection. Clearing it would
   * turn a Page temporarily missing from Graph into a preference silently thrown away.
   *
   * THE ORDER, and each step is the reason the next one exists:
   *
   *   1. What is already selected, if this connection still offers it — a choice made in this
   *      session, which must not be overridden by anything below it.
   *   1b. The Page stored against this person's connection, when it is still on offer.
   *   2. `DEFAULT_PAGE_NAME`, when it is on this connection. Not every connection has it; three
   *      people hold separate Meta connections here and they do not administer the same Pages.
   *   3. The first Page AS THE DROPDOWN ORDERS IT — `orderedPages`, not `pages`. Falling back to a
   *      Page the reader would have to scroll to find is a worse answer than the one at the top.
   *
   * Putting the brokerage default at 2 rather than 1 is the whole point: ahead of the chosen Page it
   * would reset the dropdown on every load and make remembering anything pointless.
   */
  useEffect(() => {
    if (!pagesReady || orderedPages.length === 0) return;
    const named = (n: string) => orderedPages.find((p) => p.name.trim().toLowerCase() === n.trim().toLowerCase());
    const stored = status?.default_meta_page_id ?? null;
    setSelectedPage((cur) => (
      cur && orderedPages.some((p) => p.id === cur)
        ? cur
        : (
          (stored ? orderedPages.find((p) => p.id === stored) : undefined)
          ?? named(DEFAULT_PAGE_NAME)
          ?? orderedPages[0]
        ).id
    ));
  }, [orderedPages, pagesReady, status?.default_meta_page_id]);

  /**
   * THE ONE PLACE THE FILTER IS DECIDED: the URL, checked against the forms this Page returned.
   *
   * It used to be cleared outright whenever the Page changed, which was right for the Page and
   * wrong for everything else — it also fired on the first load, before anything had been chosen.
   * Deriving it instead means a different Page drops a filter that does not belong to it, while a
   * filter that does belong survives the forms reloading underneath it.
   *
   * A `?form=` naming a form this Page does not have — an old link, a form disconnected since, a
   * Page switched under it — clears the parameter too, rather than leaving the URL claiming a
   * filter the screen is not applying.
   */
  /**
   * ONCE PER VISIT, and only when the URL says nothing: put back the form this session was last
   * looking at. `seeded` makes it once — without it, pressing "Show all" would clear the parameter
   * and this would immediately restore it, and the button would look broken.
   *
   * It seeds the URL rather than the state, so there is still one source of truth and the restored
   * filter is as linkable as a chosen one.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || forms.length === 0) return;
    seeded.current = true;
    if (params.get('form')) return;
    let last: string | null = null;
    try { last = sessionStorage.getItem(FORM_KEY); } catch { /* unavailable */ }
    if (last && forms.some((f) => f.id === last)) setFormParam(last);
  }, [forms, params, setFormParam]);

  useEffect(() => {
    const wanted = params.get('form');
    if (forms.length === 0) { setFormFilter(null); return; }
    const match = wanted ? forms.find((f) => f.id === wanted) : undefined;
    setFormFilter(match ? { id: match.id, name: match.name } : null);
    if (wanted && !match) setFormParam(null);
  }, [forms, params, setFormParam]);

  useEffect(() => {
    /*
     * WAIT FOR THE CONNECTION'S OWN LIST. `selectedPage` can now hold a remembered id at first
     * render, and asking for the forms of a Page this person cannot read answers with an error
     * toast before they have touched anything. `pagesReady` is false only until the first
     * `metaPages()` returns — pressing Refresh leaves it true, so a form filter already chosen is
     * not cleared out from under the person who chose it.
     */
    if (!selectedPage || !pagesReady) { setForms([]); return; }
    metaForms(selectedPage)
      .then((r) => setForms(r.forms))
      .catch((ex) => { setForms([]); toast(apiErrorMessage(ex, 'Could not load lead forms'), 'bad'); })
      // Success or failure, the waiting is over — a Graph error must not leave the leads list
      // hanging on a restore that is never coming.
      .finally(() => setFormsLoaded(true));
  }, [selectedPage, pagesReady, toast]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally {
      setBusy('');
    }
  };

  const connect = () => run('connect', async () => {
    const url = await metaAuthUrl();
    window.location.assign(url);
  });

  const sync = () => run('sync', async () => {
    const res = await syncMetaLeads();
    toast(res.message, res.errors.length && !res.imported ? 'info' : 'ok');
    await Promise.all([loadStatus(), loadLeads()]);
  });

  const disconnect = () => askDelete({
    title: 'Disconnect Meta?',
    confirmLabel: 'Disconnect',
    message: 'New leads will stop arriving. Leads already synced stay in the Lead module.',
    // Worth stating plainly: releasing the forms is what lets a successor pick them up, so it is
    // the desired behaviour when somebody leaves — and a surprise to anyone disconnecting briefly.
    note: 'The stored Facebook access tokens are erased immediately, and your connected lead forms '
      + 'are released — another agent can connect them while you are disconnected.',
    onConfirm: async () => {
      await run('disconnect', async () => {
        await disconnectMeta();
        setPages([]); setForms([]); setSelectedPage('');
        await loadStatus();
      }, 'Meta disconnected.');
      closeConfirm();
    },
  });

  const toggle = (form: MetaForm) => run(`form-${form.id}`, async () => {
    const res = await toggleMetaForm(selectedPage, form.id, form.name, !form.is_connected);
    setForms((f) => f.map((x) => (x.id === form.id ? { ...x, is_connected: !form.is_connected } : x)));
    toast(res.message, 'ok');
  });

  if (loading) return <div className="card"><p className="help">Loading Meta…</p></div>;

  const connectedForms = forms.filter((f) => f.is_connected).length;

  return (
    <>
      {status && !status.configured && (
        <div className="card meta-alert bad">
          <strong>Meta is not configured on this server.</strong>
          <p>
            Connecting requires a Meta app. Set <code>META_APP_ID</code>, <code>META_APP_SECRET</code>,
            {' '}<code>META_LOGIN_CONFIG_ID</code> and <code>META_PUBLIC_URL</code> in the API environment
            and restart it. Everything below stays read-only until then.
          </p>
        </div>
      )}
      {status && status.configured && !status.token_storage_secure && (
        <div className="card meta-alert warn">
          <strong>APP_KEY is not set.</strong>
          <p>Facebook access tokens would be stored without encryption. Set <code>APP_KEY</code> before connecting.</p>
        </div>
      )}
      {/*
        * DELIBERATELY NOT A PAGE BANNER, and the distinction is who the message is for.
        *
        * The reason the API writes names META_PUBLIC_URL and the Meta subscription - it is addressed
        * to whoever deploys this, not to the agent working leads, and there is nothing the latter
        * can do about it. Standing permanently across the top of the module, it read as "Meta is
        * broken" to every user on a deployment that simply runs on scheduled sync.
        *
        * So it moves one click away, into Diagnostics, where somebody has gone looking for exactly
        * this. It is NOT deleted: a webhook stops silently, "no deliveries" looks identical to a
        * quiet week, and this is still the only thing in the app that can tell them apart. The
        * admin-facing copy in CRM Settings (MetaConnectionPanel) also stays - that audience can act.
        */}

      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="meta-title">Meta</h2>
            <p className="help" style={{ marginTop: 2 }}>
              Facebook and Instagram lead ads. Synced leads land in <button className="prop-link" type="button" onClick={() => navigate(crmPath('lead'))}>Lead</button> with the source “Meta”.
            </p>
          </div>
          <div className="toolbar-row">
            {status?.is_connected && canEdit && (
              <button className="btn ghost" type="button" disabled={busy !== ''} onClick={sync}>
                {busy === 'sync' ? 'Syncing…' : '↻ Sync Now'}
              </button>
            )}
            {canEdit && (
              <button className="btn ghost" type="button" disabled={busy !== ''}
                onClick={() => void run('diag', async () => setDiagnostics(await metaDiagnostics()))}>
                Diagnostics
              </button>
            )}
            {status?.is_connected
              ? canEdit && <button className="btn ghost" type="button" disabled={busy !== ''} onClick={disconnect}>Disconnect</button>
              : canEdit && (
                <button className="btn primary" type="button" disabled={busy !== '' || !status?.configured} onClick={connect}>
                  {busy === 'connect' ? 'Opening Facebook…' : 'Connect Facebook'}
                </button>
              )}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Meta leads" value={leadStats.total} />
        <Stat label="Today" value={leadStats.today} />
        <Stat label="This week" value={leadStats.week} />
      </div>

      <div className="g2">
        <div className="card">
          <div className="modal-sub">Connection</div>
          {!status?.is_connected ? (
            <>
              <p className="help">Not connected.</p>
              <p className="help">
                Connect with a Facebook account that administers the Page running your lead ads.
                You'll then choose which lead forms to read — nothing is pulled until you opt a form in.
              </p>
            </>
          ) : (
            <dl className="lead-dl">
              <dt>Account</dt><dd>{status.facebook_user_name ?? '—'}</dd>
              <dt>Pages</dt><dd>{status.pages_count} {status.page_name ? `· ${status.page_name}` : ''}</dd>
              <dt>Connected</dt><dd>{stamp(status.connected_at)}</dd>
              <dt>Last sync</dt><dd>{stamp(status.last_sync)}</dd>
              <dt>Leads synced</dt><dd>{status.leads_count}</dd>
            </dl>
          )}

          {status?.is_connected && (
            <>
              <div className="modal-sub">Pages</div>
              <div className="toolbar-row">
                <select value={selectedPage} onChange={(e) => choosePage(e.target.value)}>
                  {pages.length === 0 && <option value="">No pages available</option>}
                  {orderedPages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {canEdit && (
                  <button className="btn ghost sm" type="button" disabled={busy !== ''}
                    onClick={() => void run('pages', async () => {
                      const r = await refreshMetaPages();
                      setPages(await metaPages());
                      toast(r.message, 'ok');
                    })}>
                    Refresh
                  </button>
                )}
              </div>
              {pages.length === 0 && (
                <p className="help">
                  No Pages came back from Facebook. The signed-in account must be a Page admin, and
                  <code> pages_show_list</code> must be granted.
                </p>
              )}
            </>
          )}
        </div>

        <div className="card">
          <div className="modal-sub">Lead Forms{status?.is_connected ? ` (${connectedForms} connected)` : ''}</div>
          {!status?.is_connected ? (
            <p className="help">Connect Meta to choose lead forms.</p>
          ) : forms.length === 0 ? (
            <p className="help">No lead forms found on this Page.</p>
          ) : (
            <ul className="meta-forms">
              {forms.map((f) => (
                <li key={f.id}
                  style={formFilter?.id === f.id ? { borderColor: 'var(--accent)', boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}>
                  {/* The name and counts are the button, not the whole row: Connect/Disconnect
                      beside it keeps its own job, so pressing it never also filters the list. */}
                  <button type="button" onClick={() => showForm(f)} aria-pressed={formFilter?.id === f.id}
                    title={formFilter?.id === f.id ? 'Show all Meta leads' : `Show leads from ${f.name}`}
                    style={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                    <strong>{f.name}</strong>
                    <div className="muted">
                      {f.leads_count} lead{f.leads_count === 1 ? '' : 's'} on Meta
                      {f.status ? ` · ${f.status.toLowerCase()}` : ''}
                    </div>
                  </button>
                  <div className="toolbar-row">
                    <span className={`pill ${f.is_connected ? 'ok' : ''}`}>{f.is_connected ? 'Connected' : 'Off'}</span>
                    {canEdit && (
                      <button className="btn ghost sm" type="button" disabled={busy !== ''} onClick={() => toggle(f)}>
                        {f.is_connected ? 'Disconnect' : 'Connect'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="help">
            Click a form to see its leads below. Only connected forms are read. Leads also arrive instantly by webhook once the
            subscription is configured in Meta.
          </p>
        </div>
      </div>

      <div className="card" ref={leadsRef}>
        <div className="modal-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {formFilter
            ? `Leads from ${formFilter.name}${formTotal !== null ? ` (${formTotal})` : ''}`
            : 'Recent Meta Leads'}
          {formFilter && (
            <button className="btn ghost sm" type="button" onClick={() => setFormParam(null)}>Show all</button>
          )}
        </div>
        {leadsError ? (
          <p className="help bad">
            {leadsError} — this is a failure to READ the leads, not a statement that there are none.
            Any leads already synced are unaffected.
          </p>
        ) : !leadsLoaded ? (
          <p className="help">Loading leads…</p>
        ) : leads.length === 0 ? (
          <p className="help">
            {formFilter
              ? 'No leads from this form are in the CRM yet. Only connected forms are synced — connect it and press Sync Now to bring them in.'
              : 'No Meta leads yet.'}
          </p>
        ) : (
          <div className="lead-scroll">
            <table className="list-table">
              <thead>
                <tr><th>Name</th><th>Contact</th><th>Enquiry</th><th>Status</th><th>Received</th><th></th></tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="muted">
                      <div>{l.email.endsWith('@meta.invalid') ? <em>No email provided</em> : l.email}</div>
                      <div>{l.phone || '—'}</div>
                    </td>
                    <td className="muted">{l.message || l.property || '—'}</td>
                    <td>{l.lead_status ? <span className="pill info">{l.lead_status}</span> : '—'}</td>
                    <td>{stamp(l.created_at)}</td>
                    <td><button className="btn ghost sm" type="button" onClick={() => openLead(l.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {diagnostics && <DiagnosticsModal d={diagnostics} webhook={webhook} onClose={() => setDiagnostics(null)} />}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card meta-stat">
      <div className="meta-stat-n">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}

function DiagnosticsModal(
  { d, webhook, onClose }: { d: MetaDiagnostics; webhook: MetaWebhookHealth | null; onClose: () => void },
) {
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">Meta Diagnostics</div>

        {d.blockers.length === 0
          ? <p className="help">No configuration problems found.</p>
          : (
            <>
              <div className="modal-sub">What's blocking a connection</div>
              <ul className="meta-list bad">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </>
          )}

        <div className="modal-sub">Server configuration</div>
        <dl className="lead-dl">
          <dt>App</dt><dd>{d.app_name ? `${d.app_name} (${d.app_id})` : d.app_id ?? 'Not set'}</dd>
          <dt>Redirect URI</dt><dd><code>{d.redirect_uri}</code></dd>
          <dt>OAuth strategy</dt><dd>{d.oauth_strategy}</dd>
          <dt>Login config ID</dt><dd>{d.login_config_id ?? 'Not set'}</dd>
          <dt>Token encryption</dt><dd>{d.token_storage_secure ? 'On (APP_KEY)' : 'Off — APP_KEY missing'}</dd>
          <dt>Live permissions</dt><dd>{d.live_permissions.length ? d.live_permissions.join(', ') : 'None reported'}</dd>
          <dt>Required</dt><dd>{d.required_permissions.join(', ')}</dd>
        </dl>

        {/*
          * Lead delivery, reported separately from the connection above it, because the two are
          * genuinely independent: every line in "Server configuration" can be correct while not one
          * lead has ever been pushed. This is where that shows up now.
          */}
        {webhook && (
          <>
            <div className="modal-sub">Lead delivery</div>
            {webhook.stalled && webhook.stalled_reason
              ? (
                <>
                  <ul className="meta-list bad"><li>{webhook.stalled_reason}</li></ul>
                  <p className="help">
                    Leads are still collected by the scheduled sync, so nothing is lost - but they
                    arrive on that cadence rather than within seconds of the form being submitted.
                  </p>
                </>
              )
              : (
                <p className="help">
                  {webhook.total} webhook delivery(ies) received
                  {webhook.failed > 0 ? `, ${webhook.failed} failed` : ''}
                  {webhook.last_received_at ? ` · last ${stamp(webhook.last_received_at)}` : ''}
                </p>
              )}
          </>
        )}

        <div className="modal-sub">Setup checklist</div>
        <ol className="meta-list">{d.fix_steps.map((s) => <li key={s}>{s}</li>)}</ol>

        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
