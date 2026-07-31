import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../ui/Icon';
import { useSearchParams } from 'react-router-dom';
import {
  campaignOptions, listCampaigns, getCampaign, deleteCampaign,
  previewAudience, sendCampaign, trackingHealth, previewSegment, tagSegment, sendTestEmail,
} from '../lib/campaignsApi';
import { apiErrorMessage } from '../lib/apiError';
import { runLeadImport, type ImportJob } from '../lib/leadImportApi';
import ImportProgress from '../components/ImportProgress';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from './ConfirmDialog';
import CampaignTemplates from './CampaignTemplates';
import type {
  AudienceFilter, AudiencePreview, CampaignDetail, CampaignOptions,
  CampaignRecipientRow, CampaignSummary, TrackingHealth,
} from '../types';

const ANY = 'any';
const emptyForm = { name: '', template_id: '', categoryFilter: 'all', leadStatus: ANY, leadType: ANY, leadSource: ANY, clientType: ANY, tag: ANY };
type Form = typeof emptyForm;

/** "any" is the UI's placeholder; the API expects an omitted filter. */
const toFilter = (f: Pick<Form, 'leadStatus' | 'leadType' | 'leadSource' | 'clientType' | 'tag'>): AudienceFilter => ({
  leadStatus: f.leadStatus === ANY ? '' : f.leadStatus,
  leadType: f.leadType === ANY ? '' : f.leadType,
  leadSource: f.leadSource === ANY ? '' : f.leadSource,
  clientType: f.clientType === ANY ? '' : f.clientType,
  tag: f.tag === ANY ? '' : f.tag,
});

const statusPill = (s: string) => (s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'sending' ? 'warn' : '');
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

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
  const tab: 'campaigns' | 'templates' = params.get('tab') === 'templates' ? 'templates' : 'campaigns';
  const setTab = (next: 'campaigns' | 'templates') => {
    const p = new URLSearchParams(params);
    if (next === 'campaigns') p.delete('tab'); else p.set('tab', next);
    setParams(p, { replace: true });
  };
  const [tracking, setTracking] = useState<TrackingHealth | null>(null);
  const [checkingTracking, setCheckingTracking] = useState(false);
  const [loading, setLoading] = useState(true);

  const [builder, setBuilder] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [audience, setAudience] = useState<AudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailView, setDetailView] = useState<'all' | 'opened' | 'unsubscribed' | 'bounced'>('all');
  const [sentEmail, setSentEmail] = useState<CampaignDetail | null>(null);
  const [toDelete, setToDelete] = useState<CampaignSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);

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
  useEffect(() => {
    campaignOptions().then(setOptions).catch(() => { /* builder falls back */ });
    trackingHealth().then(setTracking).catch(() => { /* banner is informational */ });
  }, []);

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

  const openBuilder = () => { setForm(emptyForm); setAudience(null); setBuilder(true); refreshOptions(); };

  /** "Send" on a template card — jump to the campaign builder with that template preselected. */
  const useTemplate = (templateId: number) => {
    setTab('campaigns');
    setForm({ ...emptyForm, template_id: String(templateId) });
    setAudience(null);
    setBuilder(true);
    refreshOptions();
  };

  const send = async () => {
    if (!form.name.trim()) return toast('Name your campaign', 'bad');
    if (!form.template_id) return toast('Select a template', 'bad');
    if (!audience?.count) return toast('No recipients match this audience', 'bad');
    setSending(true);
    try {
      const c = await sendCampaign({
        name: form.name.trim(),
        template_id: Number(form.template_id),
        ...toFilter(form),
        tags: form.tag === ANY ? [] : [form.tag],
      });
      toast(`Campaign sent — ${c.stats.sent} delivered, ${c.stats.bounced} bounced`, c.stats.sent ? 'ok' : 'bad');
      setBuilder(false);
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'The campaign could not be sent'), 'bad');
    } finally { setSending(false); }
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
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rowStatus = (r: CampaignRecipientRow) =>
      r.bounced ? 'Bounced' : r.unsubscribed ? 'Unsubscribed' : r.opened ? 'Opened' : r.status === 'sent' ? 'Delivered' : r.status;
    const summary = [
      ['Campaign', c.name], ['Subject', c.subject], ['Status', c.status], ['Sent at', c.sent_at ?? ''],
      ['Recipients', c.stats.total], ['Delivered', c.stats.sent], ['Opened', c.stats.opened],
      ['Bounced', c.stats.bounced], ['Unsubscribed', c.stats.unsubscribed],
    ].map((p) => p.map(esc).join(','));
    const header = ['Name', 'Email', 'Status', 'Delivered', 'Opened', 'Bounced', 'Unsubscribed', 'Note'].map(esc).join(',');
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
              {canEdit && <button className="btn ghost" onClick={() => setImportOpen(true)}><Icon name="upload" size={14} /> Import Leads</button>}
              {canEdit && <button className="btn ghost" onClick={() => setTagOpen(true)}><Icon name="tag" size={14} /> Tag Leads</button>}
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

      {tab === 'campaigns' && (campaigns.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>No campaigns yet</h3>
          <p className="muted" style={{ fontSize: 13 }}>Create your first campaign to email a template to a group of leads.</p>
          {canEdit && <button className="btn primary" onClick={openBuilder}>+ Create Campaign</button>}
        </div>
      ) : (
        <div className="camp-grid">
          {campaigns.map((c) => (
            <div key={c.id} className="card camp-card">
              <div className="camp-card-top">
                <button className="camp-name" onClick={() => openDetail(c)}>{c.name}</button>
                <span className={`pill ${statusPill(c.status)}`}>{c.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {c.template_name ?? 'Template'}{c.tags[0] ? ` · ${c.tags[0]}` : ''}
              </div>
              <div className="camp-stats">
                <span title="sent to"><span className="camp-ico"><Icon name="users" size={12} /></span><strong>{c.stats.total}</strong> sent to</span>
                <span className="good" title="delivered"><span className="camp-ico"><Icon name="check" size={12} /></span><strong>{c.stats.sent}</strong> delivered</span>
                <span className="info" title="opened"><span className="camp-ico">✉️</span><strong>{c.stats.opened}</strong> opened</span>
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
              {template && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Subject: {template.subject}</div>}
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
                {filterSelect('Type', 'leadType', options.lead_type)}
                {filterSelect('Source', 'leadSource', options.lead_source)}
                {filterSelect('Client type', 'clientType', options.client_type)}
                {filterSelect('Tag', 'tag', [...new Set([...options.tag_options, ...options.tags])])}
              </div>
              <div className="camp-audience">
                {previewing ? <span className="muted">Counting recipients…</span> : (
                  <span>
                    <strong>{audience?.count ?? 0}</strong> recipient{(audience?.count ?? 0) === 1 ? '' : 's'} match this segment
                    {audience?.sample?.length ? <span className="muted"> — e.g. {audience.sample.slice(0, 3).map((s) => s.name || s.email).join(', ')}</span> : null}
                  </span>
                )}
              </div>
            </div>

            <div className="actions">
              <button className="btn ghost" onClick={() => setBuilder(false)} disabled={sending}>Cancel</button>
              <button className="btn primary" onClick={send} disabled={sending || !audience?.count}>
                {sending ? 'Sending…' : `Send to ${audience?.count ?? 0}`}
              </button>
            </div>
            {sending && <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Sending in sequence to respect mail limits — keep this open until it finishes.</p>}
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
                {tile('all', detail.stats.sent, 'Delivered', 'good')}
                {tile('opened', detail.stats.opened, 'Opened', 'info')}
                {tile('bounced', detail.stats.bounced, 'Bounced', 'bad')}
                {tile('unsubscribed', detail.stats.unsubscribed, 'Unsubscribed', 'warn')}
              </div>
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
                      <span className={`pill ${x.status === 'sent' && !x.bounced ? 'ok' : x.bounced ? 'bad' : ''}`}>
                        {x.bounced ? 'Bounced' : x.status === 'sent' ? 'Sent' : 'Pending'}
                      </span>
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

      {importOpen && <ImportLeadsModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); refreshOptions(); }} />}
      {tagOpen && options && <TagLeadsModal options={options} onClose={() => setTagOpen(false)} onDone={() => { setTagOpen(false); refreshOptions(); }} />}

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

      <ConfirmDialog
        confirm={toDelete ? {
          title: 'Delete this campaign?',
          message: `"${toDelete.name}" and its send results will be permanently removed. Emails already sent are not affected.`,
          onConfirm: remove,
        } : null}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}

/** Import leads from a pasted or uploaded CSV. */
function ImportLeadsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportJob | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Read by the poll loop, which outlives a render — a state flag would be captured stale.
  const closedRef = useRef(false);
  useEffect(() => () => { closedRef.current = true; }, []);

  const pick = (f: File | null) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('File too large (max 5MB)', 'bad');
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? '').trim()); toast(`Loaded ${f.name}`, 'ok'); };
    reader.onerror = () => toast('Could not read the file', 'bad');
    reader.readAsText(f);
  };

  const run = async () => {
    if (!csv.trim()) return toast('Paste CSV data or choose a file first', 'bad');
    setBusy(true);
    setProgress(null);
    try {
      // The same server-side queue the Leads screen uses, so a file imported from either place
      // behaves identically — these two screens previously had separate implementations.
      const job = await runLeadImport(csv, tag.trim(), {
        source: 'campaigns',
        onProgress: setProgress,
        cancelled: () => closedRef.current,
      });
      if (closedRef.current) return;
      if (job.status === 'Failed') { toast(job.message, 'bad'); setBusy(false); return; }
      toast(job.message, 'ok');
      onDone();
    } catch (e) { toast(apiErrorMessage(e, 'Import failed'), 'bad'); setBusy(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <button className="close" onClick={onClose} disabled={busy}><Icon name="close" size={15} /></button>
        <div className="modal-h">Import Leads</div>
        <div className="field">
          <label>Tag (optional)</label>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. Expo-2026, Website-Signup" />
          <div className="help">All imported leads get this tag so you can target them in a campaign.</div>
        </div>
        <div className="field">
          <label>CSV data</label>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          <button className="btn ghost sm" type="button" onClick={() => fileRef.current?.click()} style={{ marginBottom: 6 }}>Choose CSV file</button>
          <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }}
            placeholder={'name,email,phone,status,type,source,clienttype\nJohn Smith,john@example.com,4165551234,hot,buyer,meta,Investor'} />
          <div className="help">
            Include a header row with <strong>name</strong>, <strong>email</strong>, <strong>phone</strong> — and optionally
            status, type, source, clienttype. Rows without a valid email are skipped; existing addresses are tagged, not duplicated.
          </div>
        </div>
        {progress && <ImportProgress job={progress} />}
        <div className="actions">
          {/* Not disabled while importing: the work is on the server, so closing only stops this
              tab watching it rather than trapping somebody in a modal for minutes. */}
          <button className="btn ghost" onClick={onClose}>{busy ? 'Close — the import keeps running' : 'Cancel'}</button>
          <button className="btn primary" onClick={run} disabled={busy || !csv.trim()}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}

/** Apply or remove a tag across every lead in a segment. */
function TagLeadsModal({ options, onClose, onDone }: { options: CampaignOptions; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ leadStatus: ANY, leadType: ANY, leadSource: ANY, clientType: ANY, tag: ANY });
  const [tagToApply, setTag] = useState('');
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const anyFilter = Object.values(f).some((v) => v !== ANY);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      previewSegment(toFilter(f)).then((r) => { if (!cancelled) setCount(r.count); }).catch(() => {});
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f]);

  const sel = (label: string, key: keyof typeof f, opts: string[]) => (
    <label className="report-field"><span>{label}</span>
      <select value={f[key]} onChange={(e) => setF((p) => ({ ...p, [key]: e.target.value }))}>
        <option value={ANY}>Any</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  const apply = async () => {
    if (!anyFilter) return toast('Select at least one filter', 'bad');
    if (!tagToApply.trim()) return toast('Enter a tag to apply', 'bad');
    setBusy(true);
    try { const r = await tagSegment(toFilter(f), tagToApply.trim(), mode); toast(r.message, 'ok'); onDone(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not tag leads'), 'bad'); setBusy(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" style={{ maxWidth: 620 }}>
        <button className="close" onClick={onClose} disabled={busy}><Icon name="close" size={15} /></button>
        <div className="modal-h">Tag Leads by Segment</div>
        <p className="muted" style={{ fontSize: 13 }}>Pick a segment, then apply a tag to every matching lead so you can target them later.</p>
        <div className="report-filters">
          {sel('Status', 'leadStatus', options.lead_status)}
          {sel('Type', 'leadType', options.lead_type)}
          {sel('Source', 'leadSource', options.lead_source)}
          {sel('Client type', 'clientType', options.client_type)}
          {sel('Existing tag', 'tag', options.tags)}
        </div>
        <div className="camp-audience">
          {!anyFilter ? <span className="muted">Select at least one filter above.</span>
            : <span><strong>{count ?? 0}</strong> lead{(count ?? 0) === 1 ? '' : 's'} match this segment</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Tag</label>
            <input value={tagToApply} onChange={(e) => setTag(e.target.value)} placeholder="e.g. Priority, Q3-Newsletter" />
          </div>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'remove')} style={{ width: 'auto' }}>
            <option value="add">Add</option>
            <option value="remove">Remove</option>
          </select>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={apply} disabled={busy || !anyFilter || !tagToApply.trim()}>
            {busy ? 'Working…' : mode === 'remove' ? 'Remove tag' : `Tag ${count ?? 0} lead(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
