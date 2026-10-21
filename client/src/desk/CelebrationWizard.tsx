import { useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '../lib/apiError';
import {
  celebrationAudience, createCelebration, previewCelebration, sendCelebration, testCelebration, updateCelebration,
} from '../lib/celebrationsApi';
import { useToast } from './toast';
import ConfirmDialog, { type ConfirmOptions } from './ConfirmDialog';
import { FlyerEditor, MessageFields, RecipientEditor, allTimeZones, type MessageValue } from './CelebrationEditors';
import type {
  AudiencePreviewResult, CelebrationDetail, CelebrationDraftInput, CelebrationOptions, CelebrationPreview, Flyer, RecipientSpec,
} from '../types/celebration';

const STEPS = ['Occasion', 'Recipients', 'Message & flyer', 'Preview', 'Send test', 'Send or schedule'];

const emptySpec = (): RecipientSpec => ({ mode: 'all', filters: { date_window: 'today', feb29_rule: 'feb28' }, lead_ids: [], excluded_lead_ids: [] });

const todayIn = (tz: string): string => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); }
};

/**
 * Create a celebration: Occasion → Recipients → Message & flyer → Preview → Send test → Send or schedule.
 *
 * Nothing sends until the final step's confirmed Send Now or Schedule. Save Draft is available from
 * every step; a test email saves the draft first because it is sent from the saved version.
 */
export default function CelebrationWizard({ options, initial, onClose, onSaved, onSent }: {
  options: CelebrationOptions;
  initial: CelebrationDetail | null;
  onClose: () => void;
  onSaved: (d: CelebrationDetail) => void;
  onSent: (d: CelebrationDetail) => void;
}) {
  const toast = useToast();
  const [id, setId] = useState<number | null>(initial?.id ?? null);
  const [step, setStep] = useState(0);
  const [d, setD] = useState<CelebrationDraftInput>(() => ({
    name: initial?.name ?? '',
    occasion: initial?.occasion ?? '',
    occasion_label: initial?.occasion_label ?? '',
    subject: initial?.subject ?? '',
    preview_text: initial?.preview_text ?? '',
    message: initial?.message ?? '',
    branding: initial?.branding ?? 'agent',
    sender_account_id: initial?.sender_account_id ?? null,
    reply_to: initial?.reply_to ?? '',
    flyer_id: initial?.flyer?.id ?? null,
    recipients: initial?.recipients_spec ?? emptySpec(),
    timezone: initial?.timezone ?? options.default_timezone,
    ai_assisted: initial?.ai_assisted ?? false,
  }));
  const [flyer, setFlyer] = useState<Flyer | null>(initial?.flyer ?? null);
  const [flyerSuggestion, setFlyerSuggestion] = useState<{ headline: string; greeting: string } | null>(null);
  const [audience, setAudience] = useState<AudiencePreviewResult | null>(null);
  const [audienceBusy, setAudienceBusy] = useState(false);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [preview, setPreview] = useState<CelebrationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sampleId, setSampleId] = useState<number | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [testTo, setTestTo] = useState(options.me.email);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; from?: string; diverted_to?: string | null; error?: string } | null>(null);
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [schedDate, setSchedDate] = useState(() => todayIn(options.default_timezone));
  const [schedTime, setSchedTime] = useState('09:00');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const zones = useMemo(() => allTimeZones(options.default_timezone), [options.default_timezone]);

  const set = <K extends keyof CelebrationDraftInput>(k: K, v: CelebrationDraftInput[K]) => setD((x) => ({ ...x, [k]: v }));
  const occasionOpt = options.occasions.find((o) => o.value === d.occasion);
  const needsLabel = d.occasion === 'custom-festival' || d.occasion === 'general';
  const occasionName = needsLabel ? d.occasion_label : occasionOpt?.label ?? '';
  const payload = (): CelebrationDraftInput => ({ ...d, flyer_id: flyer?.id ?? null });

  // ---- the audience, refreshed as the choices change (debounced). Sends nothing.
  useEffect(() => {
    if (!d.occasion || step < 1) return undefined;
    const t = setTimeout(() => {
      setAudienceBusy(true); setAudienceError(null);
      celebrationAudience({
        occasion: d.occasion, occasion_label: d.occasion_label, recipients: d.recipients, timezone: d.timezone,
        ...(sendMode === 'schedule' ? { schedule_date: schedDate, schedule_time: schedTime } : {}),
      })
        .then((a) => {
          setAudience(a);
          // The sample must be somebody who will actually receive it: keep the choice while they are
          // still in the audience, otherwise move to the first recipient (or none).
          setSampleId((cur) => (cur !== null && a.recipients.some((r) => r.lead_id === cur) ? cur : a.recipients[0]?.lead_id ?? null));
        })
        .catch((e) => setAudienceError(apiErrorMessage(e, 'Could not work out the recipients')))
        .finally(() => setAudienceBusy(false));
    }, 350);
    return () => clearTimeout(t);
  }, [d.occasion, d.occasion_label, d.recipients, d.timezone, step, sendMode, schedDate, schedTime]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the personalised preview, on the preview step.
  useEffect(() => {
    if (step !== 3) return;
    setPreviewBusy(true);
    previewCelebration({ ...payload(), sample_lead_id: sampleId })
      .then(setPreview)
      .catch((e) => toast(apiErrorMessage(e, 'Could not build the preview'), 'bad'))
      .finally(() => setPreviewBusy(false));
  }, [step, sampleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (quiet = false): Promise<CelebrationDetail | null> => {
    if (!d.occasion) { toast('Choose an occasion first.', 'bad'); return null; }
    setSaving(true);
    try {
      const saved = id ? await updateCelebration(id, payload()) : await createCelebration(payload());
      setId(saved.id);
      onSaved(saved);
      if (!quiet) toast('Draft saved. Nothing has been sent.', 'ok');
      return saved;
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the draft'), 'bad');
      return null;
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo)) { toast('Enter a valid email address for the test.', 'bad'); return; }
    const saved = await save(true);
    if (!saved) return;
    setTestBusy(true); setTestResult(null);
    try {
      setTestResult(await testCelebration(saved.id, testTo, sampleId));
    } catch (e) {
      setTestResult({ ok: false, error: apiErrorMessage(e, 'The test could not be sent') });
    } finally { setTestBusy(false); }
  };

  const doSend = async () => {
    setConfirm(null);
    const saved = await save(true);
    if (!saved) return;
    setSending(true);
    try {
      const done = await sendCelebration(saved.id, sendMode === 'schedule'
        ? { mode: 'schedule', schedule_date: schedDate, schedule_time: schedTime, timezone: d.timezone }
        : { mode: 'now', timezone: d.timezone });
      toast(sendMode === 'schedule' ? 'Celebration scheduled.' : 'Celebration is sending.', 'ok');
      onSent(done);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not send'), 'bad');
    } finally { setSending(false); }
  };

  const askSend = () => {
    if (!audience || audience.count === 0) { toast('Nobody is eligible to receive this yet.', 'bad'); return; }
    if (!d.subject.trim() || !d.message.trim()) { toast('Write the subject and message first.', 'bad'); setStep(2); return; }
    const sender = options.sender_accounts.find((a) => a.id === d.sender_account_id)?.from_email ?? options.default_sender ?? 'not connected';
    setConfirm({
      variant: 'primary',
      title: sendMode === 'schedule' ? 'Schedule this celebration?' : 'Send this celebration now?',
      message: 'Check the details before it goes.',
      body: (
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <div><strong>{audience.count}</strong> recipient{audience.count === 1 ? '' : 's'} · {audience.excluded_total} excluded</div>
          <div>Subject: <strong>{d.subject}</strong></div>
          <div>From: {sender}{d.reply_to ? ` · Reply-to: ${d.reply_to}` : ''}</div>
          <div>{sendMode === 'schedule' ? `Sends ${schedDate} at ${schedTime} (${d.timezone})` : 'Sends immediately'}</div>
          <div className="muted" style={{ fontSize: 12 }}>Each person gets their own email. Eligibility is checked again at send time.</div>
        </div>
      ),
      confirmLabel: sendMode === 'schedule' ? 'Schedule' : 'Send now',
      onConfirm: () => { void doSend(); },
    });
  };

  const canNext = step === 0 ? !!d.occasion && (!needsLabel || !!d.occasion_label.trim()) : true;
  const audienceList = (audience?.recipients ?? []).filter((r) => !recipientSearch
    || r.name.toLowerCase().includes(recipientSearch.toLowerCase()) || r.email.toLowerCase().includes(recipientSearch.toLowerCase()));
  const excludeLead = (leadId: number) => set('recipients', { ...d.recipients, excluded_lead_ids: [...new Set([...d.recipients.excluded_lead_ids, leadId])] });
  const includeLead = (leadId: number) => set('recipients', { ...d.recipients, excluded_lead_ids: d.recipients.excluded_lead_ids.filter((x) => x !== leadId) });
  const manualExcluded = audience?.exclusions.find((e) => e.reason === 'excluded_by_you');

  const audiencePanel = (compact = false) => (
    <div className="card" style={{ padding: 12, marginTop: 10 }} data-testid="audience-panel">
      {audienceError ? <div className="reminder-warn">{audienceError}</div> : !audience ? (
        <div className="muted">{audienceBusy ? 'Working out who receives it…' : 'Choose recipients.'}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div><span style={{ fontSize: 26, fontWeight: 700 }} data-testid="audience-count">{audience.count}</span> will receive it</div>
            <div className="muted" style={{ fontSize: 13 }}>{audience.matched} matched · {audience.excluded_total} excluded{audience.not_permitted ? ` · ${audience.not_permitted} not among your leads` : ''}</div>
            {audienceBusy && <span className="muted" style={{ fontSize: 12 }}>updating…</span>}
          </div>
          {audience.days.length > 0 && audience.days.length <= 7 && (
            <div className="muted" style={{ fontSize: 12 }}>Dates covered: {audience.days.join(', ')}</div>
          )}
          {audience.over_cap && <div className="reminder-warn" style={{ marginTop: 6 }}>Above the {audience.max_recipients}-recipient limit for one celebration — narrow the recipients and send in parts.</div>}
          {audience.scan_capped && <div className="reminder-warn" style={{ marginTop: 6 }}>More leads matched than one check reads; narrow the filters for an exact count.</div>}
          {audience.exclusions.length > 0 && (
            <details style={{ marginTop: 6 }} open={!compact}>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>Exclusions and reasons</summary>
              <table className="table" style={{ fontSize: 12.5, marginTop: 4 }} data-testid="exclusions">
                <tbody>
                  {audience.exclusions.map((e) => (
                    <tr key={e.reason}>
                      <td>{e.label}</td><td style={{ textAlign: 'right' }}><strong>{e.count}</strong></td>
                      <td className="muted">{(e.sample ?? []).slice(0, 3).map((s) => s.name || s.email).join(', ')}{(e.sample?.length ?? 0) > 3 ? '…' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {!compact && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>Recipient list ({audience.count})</summary>
              <input style={{ marginTop: 6 }} value={recipientSearch} onChange={(e) => setRecipientSearch(e.target.value)} placeholder="Search recipients" />
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
                {audienceList.slice(0, 300).map((r) => (
                  <div key={r.lead_id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
                    <span style={{ flex: 1 }}><strong>{r.name || '—'}</strong> <span className="muted">{r.email}</span></span>
                    <button type="button" className="btn ghost sm" onClick={() => excludeLead(r.lead_id)}>Exclude</button>
                  </div>
                ))}
                {audienceList.length > 300 && <div className="muted" style={{ fontSize: 12 }}>Showing 300 — search to find others.</div>}
              </div>
              {manualExcluded && (
                <div style={{ marginTop: 6, fontSize: 12.5 }}>
                  Excluded by you: {(manualExcluded.sample ?? []).map((s) => (
                    <button key={s.lead_id} type="button" className="btn ghost sm" onClick={() => includeLead(s.lead_id)}>{s.name || s.email} ↺</button>
                  ))}
                </div>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !sending && !saving) onClose(); }}>
      <div className="modal" style={{ maxWidth: 860 }} data-testid="celebration-wizard">
        <button className="close" onClick={onClose} disabled={sending}>✕</button>
        <div className="modal-h">{id ? 'Edit celebration' : 'New celebration'} {occasionName && <span className="pill info" style={{ marginLeft: 6, fontSize: 11 }}>{occasionName}</span>}</div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }} data-testid="wizard-steps">
          {STEPS.map((s, i) => (
            <button key={s} type="button" className={`btn sm ${i === step ? 'primary' : 'ghost'}`} disabled={i > 0 && !d.occasion} onClick={() => setStep(i)}>
              {i + 1}. {s}
            </button>
          ))}
        </div>

        {step === 0 && (
          <div>
            <div className="field"><label>Occasion</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8 }}>
                {(['birthday', 'anniversary'] as const).map((o) => (
                  <button key={o} type="button" className={`btn ${d.occasion === o ? 'primary' : ''}`} onClick={() => set('occasion', o)}>
                    {o === 'birthday' ? '🎂 Birthday' : '💍 Anniversary'}
                  </button>
                ))}
                <button type="button" className={`btn ${d.occasion === 'general' ? 'primary' : ''}`} onClick={() => set('occasion', 'general')}>✉️ General / custom</button>
              </div>
            </div>
            <div className="field"><label>…or a festival or holiday</label>
              <select value={occasionOpt?.group === 'festival' ? d.occasion : ''} onChange={(e) => set('occasion', e.target.value)} data-testid="festival-select">
                <option value="">Choose a festival or holiday</option>
                {options.occasions.filter((o) => o.group === 'festival').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {needsLabel && (
              <div className="field"><label>{d.occasion === 'general' ? 'What is the occasion?' : 'Name of the festival or holiday'}</label>
                <input value={d.occasion_label} maxLength={120} onChange={(e) => set('occasion_label', e.target.value)}
                  placeholder={d.occasion === 'general' ? 'e.g. Thank you, New home congratulations' : 'e.g. Baisakhi, Mid-Autumn Festival'} data-testid="occasion-label" /></div>
            )}
            <div className="field"><label>Campaign name (only you see this)</label>
              <input value={d.name} maxLength={255} onChange={(e) => set('name', e.target.value)} placeholder={occasionName ? `${occasionName} greetings ${new Date().getFullYear()}` : 'e.g. Diwali greetings 2026'} data-testid="cel-name" /></div>
            <div className="muted" style={{ fontSize: 12 }}>Choose the occasion yourself — the CRM never guesses anyone's religion or culture from their name.</div>
          </div>
        )}

        {step === 1 && (
          <div>
            <RecipientEditor spec={d.recipients} onChange={(s) => set('recipients', s)} options={options} occasion={d.occasion} />
            {audiencePanel()}
          </div>
        )}

        {step === 2 && (
          <div>
            <MessageFields
              value={{ subject: d.subject, preview_text: d.preview_text, message: d.message, ai_assisted: d.ai_assisted }}
              onChange={(v: MessageValue) => setD((x) => ({ ...x, ...v }))}
              options={options} occasion={d.occasion} occasionLabel={occasionName} branding={d.branding}
              onFlyerText={(headline, greeting) => setFlyerSuggestion({ headline, greeting })}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8 }}>
              <div className="field"><label>Signed as</label>
                <select value={d.branding} onChange={(e) => set('branding', e.target.value as 'agent' | 'brokerage')}>
                  <option value="agent">Me ({options.me.name}), Get Home Realty</option>
                  <option value="brokerage">Get Home Realty (brokerage)</option>
                </select></div>
              <div className="field"><label>Send from</label>
                <select value={d.sender_account_id ?? ''} onChange={(e) => set('sender_account_id', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Default ({options.default_sender ?? 'no mailbox connected'})</option>
                  {options.sender_accounts.map((a) => <option key={a.id} value={a.id}>{a.from_name ? `${a.from_name} <${a.from_email}>` : a.from_email}</option>)}
                </select></div>
              <div className="field"><label>Reply-to (optional)</label>
                <input type="email" value={d.reply_to} onChange={(e) => set('reply_to', e.target.value)} placeholder="Replies go to the sender if blank" /></div>
            </div>
            <FlyerEditor flyer={flyer} onChange={(f) => { setFlyer(f); set('flyer_id', f?.id ?? null); }}
              options={options} occasion={d.occasion} occasionLabel={occasionName} suggestion={flyerSuggestion} />
          </div>
        )}

        {step === 3 && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <label style={{ fontSize: 13 }}>Personalise for</label>
              <select value={sampleId ?? ''} onChange={(e) => setSampleId(e.target.value ? Number(e.target.value) : null)} style={{ width: 'auto', maxWidth: 320 }} data-testid="sample-select">
                <option value="">No lead (fallback values)</option>
                {(audience?.recipients ?? []).slice(0, 200).map((r) => <option key={r.lead_id} value={r.lead_id}>{r.name || r.email}</option>)}
              </select>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button type="button" className={`btn sm ${device === 'desktop' ? 'primary' : 'ghost'}`} onClick={() => setDevice('desktop')}>Desktop</button>
                <button type="button" className={`btn sm ${device === 'mobile' ? 'primary' : 'ghost'}`} onClick={() => setDevice('mobile')}>Mobile</button>
              </div>
            </div>
            {previewBusy && !preview && <div className="muted">Building the preview…</div>}
            {preview && (
              <>
                <div className="camp-meta" style={{ display: 'grid', gap: 2, fontSize: 13, marginBottom: 8 }} data-testid="preview-meta">
                  <div><span className="muted">From </span>{preview.from ? `${preview.from.name ? `${preview.from.name} ` : ''}<${preview.from.email}>` : 'No mailbox connected'}</div>
                  <div><span className="muted">Reply-to </span>{preview.reply_to ?? '—'}</div>
                  <div><span className="muted">Subject </span><strong data-testid="preview-subject">{preview.subject}</strong></div>
                  <div><span className="muted">Preview text </span>{preview.preview_text || '—'}</div>
                  <div><span className="muted">Personalised for </span>{preview.sample ? `${preview.sample.name} (${preview.sample.email})` : 'nobody — showing fallbacks (e.g. "Hi there,")'}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', background: '#e5e7eb', padding: 8, borderRadius: 8 }}>
                  <iframe title="Celebration preview" sandbox="" srcDoc={preview.html} data-testid="preview-frame"
                    style={{ width: device === 'mobile' ? 375 : '100%', maxWidth: '100%', height: 520, border: 0, background: '#fff', borderRadius: 6 }} />
                </div>
                {preview.send_problem && <div className="reminder-warn" style={{ marginTop: 8 }}>{preview.send_problem}</div>}
              </>
            )}
            {audiencePanel(true)}
          </div>
        )}

        {step === 4 && (
          <div>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              Sends one real copy of this message (marked [Test]) to the address below, personalised for
              {' '}{audience?.recipients.find((r) => r.lead_id === sampleId)?.name ?? 'nobody (fallback values)'}. No recipient receives anything.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} style={{ flex: 1, minWidth: 220 }} data-testid="test-to" />
              <button type="button" className="btn primary" disabled={testBusy || saving} onClick={sendTest} data-testid="send-test">
                {testBusy ? 'Sending test…' : 'Send Test Email'}
              </button>
            </div>
            {testResult && (
              <div className={testResult.ok ? 'card' : 'reminder-warn'} style={{ marginTop: 10, padding: 10 }} data-testid="test-result">
                {testResult.ok
                  ? testResult.diverted_to
                    ? <>The test was handed to the mail server from {testResult.from}, but this machine diverts all mail to <code>{testResult.diverted_to}</code> — it was <strong>not delivered</strong> to {testTo}.</>
                    : <>Test accepted by the mail server from {testResult.from}. Check {testTo}.</>
                  : <>Test failed: {testResult.error}</>}
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div>
            <div style={{ display: 'flex', gap: 14, fontSize: 13, marginBottom: 8 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" checked={sendMode === 'now'} onChange={() => setSendMode('now')} /> Send now</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" checked={sendMode === 'schedule'} onChange={() => setSendMode('schedule')} data-testid="mode-schedule" /> Schedule</label>
            </div>
            {sendMode === 'schedule' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8 }}>
                <div className="field"><label>Date</label><input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} data-testid="sched-date" /></div>
                <div className="field"><label>Time</label><input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} data-testid="sched-time" /></div>
                <div className="field"><label>Timezone</label>
                  <select value={d.timezone} onChange={(e) => set('timezone', e.target.value)} data-testid="sched-tz">
                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select></div>
              </div>
            )}
            {options.send_problem && <div className="reminder-warn" style={{ marginTop: 8 }}>{options.send_problem}</div>}
            {audiencePanel(true)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <button type="button" className="btn" disabled={saving || sending || !d.occasion} onClick={() => save()} data-testid="save-draft">
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="wizard-next">Next</button>
            ) : (
              <button type="button" className="btn primary" disabled={sending || saving || !audience || audience.count === 0 || audience.over_cap}
                onClick={askSend} data-testid="final-send">
                {sending ? 'Working…' : sendMode === 'schedule' ? 'Schedule' : 'Send Now'}
              </button>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
