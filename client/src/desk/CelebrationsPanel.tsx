import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '../lib/apiError';
import {
  activateAutomation, cancelCelebration, celebrationOptions, deleteAutomation, deleteCelebration, dryRunAutomation,
  getCelebration, getFlyer, listAutomations, listCelebrations, pauseAutomation, retryCelebration, saveAutomation,
} from '../lib/celebrationsApi';
import { useToast } from './toast';
import ConfirmDialog, { type ConfirmOptions } from './ConfirmDialog';
import CelebrationWizard from './CelebrationWizard';
import { FlyerEditor, MessageFields, RecipientEditor, STATUS_PILL, allTimeZones } from './CelebrationEditors';
import type {
  CelebrationAutomation, CelebrationDetail, CelebrationOptions, CelebrationSummary, Flyer, RecipientSpec,
} from '../types/celebration';

const when = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

/**
 * Campaigns → Celebrations: festival, birthday, anniversary and general greetings, their results,
 * and the annual birthday/anniversary rules.
 */
export default function CelebrationsPanel({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [options, setOptions] = useState<CelebrationOptions | null>(null);
  const [list, setList] = useState<CelebrationSummary[] | null>(null);
  const [rules, setRules] = useState<CelebrationAutomation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ initial: CelebrationDetail | null } | null>(null);
  const [detail, setDetail] = useState<CelebrationDetail | null>(null);
  const [ruleEditor, setRuleEditor] = useState<{ rule: CelebrationAutomation | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, l, r] = await Promise.all([celebrationOptions(), listCelebrations(), listAutomations()]);
      setOptions(o); setList(l); setRules(r); setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load celebrations'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Keep a sending or scheduled celebration's figures moving while somebody watches.
  const live = (list ?? []).some((c) => c.status === 'sending') || detail?.status === 'sending' || detail?.status === 'scheduled';
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => {
      void listCelebrations().then(setList).catch(() => undefined);
      if (detail) void getCelebration(detail.id).then(setDetail).catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [live, detail]);

  const open = async (id: number) => {
    try { setDetail(await getCelebration(id)); } catch (e) { toast(apiErrorMessage(e, 'Could not load the celebration'), 'bad'); }
  };

  if (error) return <div className="card reminder-warn">{error}</div>;
  if (!options || !list) return <div className="centered">Loading celebrations…</div>;

  return (
    <div data-testid="celebrations-panel">
      <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Celebration &amp; Wishes</h3>
          <div className="muted" style={{ fontSize: 13 }}>Festival, birthday, anniversary and other greetings — one personal email per lead.</div>
        </div>
        {canEdit && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setRuleEditor({ rule: null })} data-testid="new-automation">+ Annual birthday/anniversary rule</button>
            <button className="btn primary" onClick={() => setWizard({ initial: null })} data-testid="new-celebration">+ New celebration</button>
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card centered" style={{ padding: 32 }}>
          <h3 style={{ margin: 0 }}>No celebrations yet</h3>
          <p className="muted" style={{ fontSize: 13 }}>Send Diwali, Christmas, Eid, Lunar New Year or birthday wishes to your leads.</p>
          {canEdit && <button className="btn primary" onClick={() => setWizard({ initial: null })}>+ New celebration</button>}
        </div>
      ) : (
        <div className="camp-grid" data-testid="celebration-list">
          {list.map((c) => (
            <div key={c.id} className="card camp-card">
              <div className="camp-card-top">
                <button className="camp-name" onClick={() => open(c.id)}>{c.name}</button>
                <span className={`pill ${STATUS_PILL[c.status] ?? ''}`}>{c.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {c.occasion_name}{c.automation_id ? ' · annual rule' : ''}{c.ai_assisted ? ' · AI-assisted' : ''}
                {c.status === 'scheduled' && c.scheduled_for ? ` · sends ${when(c.scheduled_for)}${c.timezone ? ` (${c.timezone})` : ''}` : ''}
              </div>
              <div className="camp-stats">
                <span><strong>{c.stats.total}</strong> recipients</span>
                <span className="good" title="Accepted by the mail server — not a delivery confirmation"><strong>{c.stats.sent}</strong> sent</span>
                {c.stats.diverted > 0 && <span className="info" title="Diverted by this machine's mail safety — not delivered"><strong>{c.stats.diverted}</strong> diverted</span>}
                {c.stats.pending > 0 && <span><strong>{c.stats.pending}</strong> pending</span>}
                <span><strong>{c.stats.skipped}</strong> skipped</span>
                <span className="bad"><strong>{c.stats.failed}</strong> failed</span>
              </div>
              <div className="camp-actions">
                <button className="btn ghost sm" onClick={() => open(c.id)}>View</button>
                {canEdit && (c.status === 'draft' || c.status === 'cancelled') && (
                  <button className="btn ghost sm" onClick={async () => { const d = await getCelebration(c.id); setWizard({ initial: d }); }}>Edit</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }} data-testid="automation-list">
        <h3 style={{ marginTop: 0 }}>Annual birthday &amp; anniversary rules</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Each rule is created paused. When switched on it sends its saved message once a year on each lead's
          date (month and day), at the time and timezone you choose, and never generates new AI content.
          It respects the same one-greeting-per-year record as the Settings birthday greetings.
        </p>
        {rules.length === 0 ? <div className="muted">No rules yet.</div> : (
          <table className="table" style={{ fontSize: 13 }}>
            <thead><tr><th>Rule</th><th>When</th><th>Status</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong><div className="muted" style={{ fontSize: 12 }}>{r.occasion} · {r.subject}</div></td>
                  <td>{r.send_time} {r.timezone}<div className="muted" style={{ fontSize: 12 }}>Feb 29: {r.feb29_rule}</div></td>
                  <td><span className={`pill ${r.status === 'active' ? 'ok' : ''}`}>{r.status === 'active' ? 'On' : 'Paused'}</span>
                    {r.next_run && <div className="muted" style={{ fontSize: 11.5 }}>Next: {r.next_run}</div>}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.last_run_summary ? (
                      <>
                        {r.last_run_summary.date}: {r.last_run_summary.error ? <span className="bad">{r.last_run_summary.error}</span>
                          : <>{r.last_run_summary.recipients ?? 0} sent to queue{r.last_run_summary.campaign_id ? <> (<button className="camp-name" style={{ fontSize: 12 }} onClick={() => open(r.last_run_summary!.campaign_id!)}>results</button>)</> : null}</>}
                        {(r.last_run_summary.exclusions ?? []).length > 0 && (
                          <div className="muted">{(r.last_run_summary.exclusions ?? []).map((e) => `${e.label}: ${e.count}`).join(' · ')}</div>
                        )}
                        {r.last_run_summary.note && <div className="muted">{r.last_run_summary.note}</div>}
                      </>
                    ) : <span className="muted">Never</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && <button className="btn ghost sm" onClick={() => setRuleEditor({ rule: r })}>Edit</button>}
                    {canEdit && r.status === 'paused' && (
                      <button className="btn sm" onClick={() => setConfirm({
                        variant: 'primary', title: 'Switch this rule on?',
                        message: `It will email every eligible lead whose ${r.occasion} falls on the day, every year, at ${r.send_time} ${r.timezone}, until you pause it.`,
                        confirmLabel: 'Switch on',
                        onConfirm: async () => { try { await activateAutomation(r.id); toast('Rule switched on.', 'ok'); void load(); } catch (e) { toast(apiErrorMessage(e, 'Could not switch it on'), 'bad'); } },
                      })} data-testid={`activate-${r.id}`}>Switch on</button>
                    )}
                    {canEdit && r.status === 'active' && (
                      <button className="btn sm" onClick={async () => { try { await pauseAutomation(r.id); toast('Rule paused.', 'ok'); void load(); } catch (e) { toast(apiErrorMessage(e, 'Could not pause'), 'bad'); } }}>Pause</button>
                    )}
                    {canEdit && <button className="btn ghost sm" onClick={() => setConfirm({
                      title: 'Delete this rule?', message: 'Past greetings and their results are kept.', confirmLabel: 'Delete',
                      onConfirm: async () => { try { await deleteAutomation(r.id); void load(); } catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); } },
                    })}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {wizard && (
        <CelebrationWizard options={options} initial={wizard.initial}
          onClose={() => { setWizard(null); void load(); }}
          onSaved={() => { void listCelebrations().then(setList).catch(() => undefined); }}
          onSent={(d) => { setWizard(null); setDetail(d); void load(); }} />
      )}
      {detail && (
        <CelebrationDetailView detail={detail} canEdit={canEdit} onClose={() => setDetail(null)} onChanged={(d) => { setDetail(d); void load(); }}
          onEdit={() => { setWizard({ initial: detail }); setDetail(null); }}
          onDeleted={() => { setDetail(null); void load(); }} />
      )}
      {ruleEditor && (
        <AutomationEditor options={options} rule={ruleEditor.rule} onClose={() => setRuleEditor(null)} onSaved={() => { setRuleEditor(null); void load(); }} />
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// --------------------------------------------------------------------------------- results

function CelebrationDetailView({ detail, canEdit, onClose, onChanged, onEdit, onDeleted }: {
  detail: CelebrationDetail; canEdit: boolean; onClose: () => void; onChanged: (d: CelebrationDetail) => void; onEdit: () => void; onDeleted: () => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const s = detail.stats;
  const rows = useMemo(() => detail.recipients.filter((r) => filter === 'all' || r.status === filter || (filter === 'opened' && r.opened)), [detail, filter]);
  const act = async (fn: () => Promise<CelebrationDetail>, ok: string) => {
    setBusy(true);
    try { onChanged(await fn()); toast(ok, 'ok'); } catch (e) { toast(apiErrorMessage(e, 'That did not work'), 'bad'); } finally { setBusy(false); }
  };
  const tiles: [string, number, string, string][] = [
    ['Recipients', s.total, '', 'Everyone this celebration was addressed to'],
    ['Sent', s.sent, 'good', 'Accepted by the mail server. This is not confirmation of delivery to the inbox.'],
    ['Diverted', s.diverted, 'info', 'Handed to a mail server that diverts everything on this machine — not delivered to the recipient'],
    ['Pending', s.pending, '', 'Not attempted yet, or waiting for a retry'],
    ['Skipped', s.skipped, '', 'No longer eligible at send time (opted out, reassigned, already greeted…)'],
    ['Failed', s.failed, 'bad', 'Could not be sent'],
    ['Bounced', s.bounced, 'bad', 'Rejected by the receiving server (from real bounce responses)'],
    ['Opened', s.opened, 'info', 'Recorded when the recipient’s mail client loads the tracking image — approximate, and blocked by many clients'],
    ['Clicked', s.clicked, 'info', 'Distinct people who clicked a link'],
    ['Unsubscribed', s.unsubscribed, 'warn', 'Opted out from this email'],
  ];

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 900 }} data-testid="celebration-detail">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{detail.name} <span className={`pill ${STATUS_PILL[detail.status] ?? ''}`} style={{ marginLeft: 6 }} data-testid="detail-status">{detail.status}</span></div>
        <div className="muted" style={{ fontSize: 13 }}>
          {detail.occasion_name} · “{detail.subject}” · from {detail.sender_email ?? 'not recorded yet'}
          {detail.scheduled_for && detail.status === 'scheduled' ? ` · sends ${when(detail.scheduled_for)} (${detail.timezone})` : ''}
          {detail.sent_at ? ` · started ${when(detail.sent_at)}` : ''}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 8, margin: '12px 0' }} data-testid="detail-tiles">
          {tiles.filter(([k, v]) => k !== 'Diverted' || v > 0).map(([k, v, cls, title]) => (
            <div key={k} className="card" style={{ padding: 8 }} title={title}>
              <div className="muted" style={{ fontSize: 11.5 }}>{k}</div>
              <div className={cls} style={{ fontSize: 20, fontWeight: 700 }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          “Sent” means the mail server accepted the message; inbox delivery is never assumed. Bounces come from real bounce
          responses; opens from a tracking image and are approximate.
        </div>
        {detail.unknown_outcome > 0 && (
          <div className="reminder-warn" style={{ marginTop: 8 }}>
            {detail.unknown_outcome} send{detail.unknown_outcome === 1 ? '' : 's'} had an unknown outcome — the mail server may have received
            {detail.unknown_outcome === 1 ? ' it' : ' them'}. These are never resent automatically.
          </div>
        )}
        {detail.audience_snapshot.exclusions.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>Excluded when it was built ({detail.audience_snapshot.exclusions.reduce((n, e) => n + e.count, 0)})</summary>
            <ul style={{ fontSize: 12.5 }}>{detail.audience_snapshot.exclusions.map((e) => <li key={e.reason}>{e.label}: {e.count}</li>)}</ul>
          </details>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
          {canEdit && detail.status === 'scheduled' && (
            <button className="btn" disabled={busy} data-testid="cancel-schedule" onClick={() => setConfirm({
              title: 'Cancel this scheduled celebration?', message: 'Nothing has been sent. You can edit and send or schedule it again.',
              confirmLabel: 'Cancel schedule', onConfirm: () => { void act(() => cancelCelebration(detail.id), 'Schedule cancelled — nothing was sent.'); },
            })}>Cancel schedule</button>
          )}
          {canEdit && detail.retryable > 0 && ['completed', 'partial', 'failed'].includes(detail.status) && (
            <button className="btn" disabled={busy} data-testid="retry-failed" onClick={() => setConfirm({
              variant: 'primary', title: `Retry ${detail.retryable} failed send${detail.retryable === 1 ? '' : 's'}?`,
              message: 'Only messages that certainly did not leave are retried. Anyone already sent, skipped, bounced or with an unknown outcome is not.',
              confirmLabel: 'Retry', onConfirm: () => { void act(() => retryCelebration(detail.id), 'Retrying failed sends.'); },
            })}>Retry {detail.retryable} failed</button>
          )}
          {canEdit && (detail.status === 'draft' || detail.status === 'cancelled') && <button className="btn" onClick={onEdit}>Edit</button>}
          {canEdit && !['sending', 'scheduled'].includes(detail.status) && (
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setConfirm({
              title: 'Delete this celebration?', message: 'Its results are removed. The record that these people were greeted this year is kept, so they are not greeted twice.',
              confirmLabel: 'Delete', onConfirm: async () => { try { await deleteCelebration(detail.id); onDeleted(); } catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); } },
            })}>Delete</button>
          )}
        </div>

        {detail.recipients.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {['all', 'sent', 'diverted', 'pending', 'skipped', 'failed', 'opened'].map((f) => (
                <button key={f} className={`btn sm ${filter === f ? 'primary' : 'ghost'}`} onClick={() => setFilter(f)}>
                  {f} {f === 'all' ? detail.recipients.length : f === 'opened' ? s.opened : detail.by_status[f] ?? 0}
                </button>
              ))}
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="table" style={{ fontSize: 12.5 }} data-testid="recipient-table">
                <thead><tr><th>Recipient</th><th>Status</th><th>Detail</th><th>Mail server reference</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.name || '—'}</strong><div className="muted">{r.email}</div></td>
                      <td><span className={`pill ${STATUS_PILL[r.status] ?? ''}`}>{r.status}</span>{r.opened && <span className="pill info" style={{ marginLeft: 4 }}>opened</span>}</td>
                      <td style={{ maxWidth: 320 }}>{r.error ?? (r.sent_at ? `Accepted ${when(r.sent_at)}` : '')}{r.failure_kind ? <div className="muted">{r.failure_kind.replace('_', ' ')}</div> : null}</td>
                      <td className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{r.provider_message_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ------------------------------------------------------------------------------ automation

function AutomationEditor({ options, rule, onClose, onSaved }: {
  options: CelebrationOptions; rule: CelebrationAutomation | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const zones = useMemo(() => allTimeZones(options.default_timezone), [options.default_timezone]);
  const [r, setR] = useState(() => ({
    name: rule?.name ?? '',
    occasion: (rule?.occasion ?? 'birthday') as 'birthday' | 'anniversary',
    subject: rule?.subject ?? '', preview_text: rule?.preview_text ?? '', message: rule?.message ?? '',
    branding: rule?.branding ?? 'agent', sender_account_id: rule?.sender_account_id ?? null as number | null,
    reply_to: rule?.reply_to ?? '', send_time: rule?.send_time ?? '09:00', timezone: rule?.timezone ?? options.default_timezone,
    feb29_rule: rule?.feb29_rule ?? 'feb28',
  }));
  const [spec, setSpec] = useState<RecipientSpec>(() => ({
    mode: rule?.recipients?.mode ?? 'all', filters: rule?.recipients?.filters ?? {}, lead_ids: [], excluded_lead_ids: rule?.recipients?.excluded_lead_ids ?? [],
  }));
  const [flyer, setFlyer] = useState<Flyer | null>(null);
  const [saving, setSaving] = useState(false);
  const [dry, setDry] = useState<{ date: string; result: Awaited<ReturnType<typeof dryRunAutomation>> | null }>({ date: '', result: null });
  useEffect(() => { if (rule?.flyer_id) void getFlyer(rule.flyer_id).then(setFlyer).catch(() => undefined); }, [rule?.flyer_id]);

  const save = async () => {
    setSaving(true);
    try {
      await saveAutomation(rule?.id ?? null, { ...r, flyer_id: flyer?.id ?? null, recipients: spec });
      toast(rule ? 'Rule saved.' : 'Rule created — it is paused until you switch it on.', 'ok');
      onSaved();
    } catch (e) { toast(apiErrorMessage(e, 'Could not save the rule'), 'bad'); } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal" style={{ maxWidth: 820 }} data-testid="automation-editor">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{rule ? 'Edit annual rule' : 'New annual rule'} {rule && <span className={`pill ${rule.status === 'active' ? 'ok' : ''}`}>{rule.status === 'active' ? 'On' : 'Paused'}</span>}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8 }}>
          <div className="field"><label>Occasion</label>
            <select value={r.occasion} onChange={(e) => setR({ ...r, occasion: e.target.value as 'birthday' | 'anniversary' })}>
              <option value="birthday">Birthday</option><option value="anniversary">Anniversary</option>
            </select></div>
          <div className="field"><label>Rule name</label><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Birthday greetings" /></div>
          <div className="field"><label>Send time</label><input type="time" value={r.send_time} onChange={(e) => setR({ ...r, send_time: e.target.value })} /></div>
          <div className="field"><label>Timezone</label>
            <select value={r.timezone} onChange={(e) => setR({ ...r, timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select></div>
          <div className="field"><label>Feb 29 dates in other years</label>
            <select value={r.feb29_rule} onChange={(e) => setR({ ...r, feb29_rule: e.target.value as 'feb28' })}>
              <option value="feb28">Greet on Feb 28</option><option value="mar1">Greet on Mar 1</option><option value="skip">Skip until a leap year</option>
            </select></div>
        </div>
        <div className="camp-section"><div className="camp-section-h"><strong>Who</strong></div>
          <RecipientEditor spec={spec} onChange={setSpec} options={options} occasion="general" allowPick={false} />
          <div className="muted" style={{ fontSize: 12 }}>Each day, only leads whose {r.occasion === 'birthday' ? 'date of birth' : 'anniversary date'} falls on that day are greeted. Leads with no date are skipped and counted in the run summary.</div>
        </div>
        <MessageFields value={{ subject: r.subject, preview_text: r.preview_text, message: r.message, ai_assisted: false }}
          onChange={(v) => setR({ ...r, subject: v.subject, preview_text: v.preview_text, message: v.message })}
          options={options} occasion={r.occasion} occasionLabel={r.occasion === 'birthday' ? 'Birthday' : 'Anniversary'} branding={r.branding} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8 }}>
          <div className="field"><label>Signed as</label>
            <select value={r.branding} onChange={(e) => setR({ ...r, branding: e.target.value as 'agent' })}>
              <option value="agent">Me ({options.me.name}), Get Home Realty</option><option value="brokerage">Get Home Realty (brokerage)</option>
            </select></div>
          <div className="field"><label>Send from</label>
            <select value={r.sender_account_id ?? ''} onChange={(e) => setR({ ...r, sender_account_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Default ({options.default_sender ?? 'no mailbox connected'})</option>
              {options.sender_accounts.map((a) => <option key={a.id} value={a.id}>{a.from_email}</option>)}
            </select></div>
          <div className="field"><label>Reply-to (optional)</label><input type="email" value={r.reply_to} onChange={(e) => setR({ ...r, reply_to: e.target.value })} /></div>
        </div>
        <FlyerEditor flyer={flyer} onChange={setFlyer} options={options} occasion={r.occasion} occasionLabel={r.occasion === 'birthday' ? 'Birthday' : 'Anniversary'} />

        {rule && (
          <div className="camp-section"><div className="camp-section-h"><strong>Dry run</strong></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="date" value={dry.date} onChange={(e) => setDry({ ...dry, date: e.target.value })} style={{ width: 'auto' }} />
              <button className="btn sm" onClick={async () => { try { setDry({ ...dry, result: await dryRunAutomation(rule.id, dry.date) }); } catch (e) { toast(apiErrorMessage(e, 'Dry run failed'), 'bad'); } }}>Who would be greeted?</button>
            </div>
            {dry.result && (
              <div style={{ fontSize: 13, marginTop: 6 }} data-testid="dry-run">
                {dry.result.date}: <strong>{dry.result.count}</strong> would be greeted (saved rule, nothing sent).
                {dry.result.exclusions.length > 0 && <span className="muted"> {dry.result.exclusions.map((e) => `${e.label}: ${e.count}`).join(' · ')}</span>}
                <div className="muted">{dry.result.recipients.slice(0, 10).map((x) => x.name || x.email).join(', ')}</div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={saving} onClick={save} data-testid="save-automation">
            {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule (paused)'}
          </button>
        </div>
      </div>
    </div>
  );
}
