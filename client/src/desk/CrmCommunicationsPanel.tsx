import { useCallback, useEffect, useState } from 'react';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import {
  createCrmTemplate, getCrmCommunications, previewCrmTemplate, setCrmPreference,
  type CrmChannel, type CrmCommunicationRow, type CrmCommunicationsOverview,
} from '../lib/crmCommunicationsApi';

/**
 * CRM → Settings → Communications.
 *
 * One screen for every CRM communication: what the brokerage allows, what each person has chosen
 * for themselves, and — for an administrator — the wording that goes out. It replaces having to
 * visit Templates, Notification Preferences and Triggers to answer one question.
 *
 * DRIVEN BY THE SERVER'S REGISTRY. There is no list of communications in this file. Rows, channels,
 * names and whether a template may be edited all arrive from `/api/crm-communications`, so a
 * communication registered on the server appears here without this screen changing. That is the
 * whole reason the registry exists.
 *
 * WHAT IT DOES NOT DECIDE. `can_edit` comes from the server and the write endpoints are guarded
 * there too. Hiding a button is presentation; the refusal is at the API.
 */

const CHANNEL_LABEL: Record<CrmChannel, string> = { email: 'Email', in_app: 'In-app', push: 'Push' };

/**
 * `standalone` is the difference between the two doors into this screen, and nothing more.
 *
 * Administrators arrive through CRM → Settings → Communications, which has already drawn its own
 * title and tab strip. Agents arrive at /crm/communications directly, because they hold no
 * `settings` permission and never see that group — so there they need the page header the Settings
 * shell would otherwise have provided. Same component, same data, same permissions either way.
 */
export default function CrmCommunicationsPanel({ standalone = false }: { standalone?: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<CrmCommunicationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{ name: string; subject: string; html: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getCrmCommunications()
      .then(setData)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load CRM communications'), 'bad'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  /*
   * Optimistic, and deliberately so: a toggle that waits for a round trip before moving feels
   * broken on a list this long. The value is put back if the server refuses, and the message says
   * why rather than leaving the switch lying about what is stored.
   */
  const toggle = async (row: CrmCommunicationRow, channel: CrmChannel, next: boolean) => {
    const id = `${row.key}:${channel}`;
    setBusy(id);
    setData((d) => d && {
      ...d,
      communications: d.communications.map((c) => (c.key === row.key
        ? { ...c, preferences: { ...c.preferences, [channel]: next } } : c)),
    });
    try {
      await setCrmPreference(row.key, channel, next);
    } catch (e) {
      setData((d) => d && {
        ...d,
        communications: d.communications.map((c) => (c.key === row.key
          ? { ...c, preferences: { ...c.preferences, [channel]: !next } } : c)),
      });
      toast(apiErrorMessage(e, 'Could not save that preference'), 'bad');
    } finally {
      setBusy('');
    }
  };

  const openPreview = async (id: number, name: string) => {
    try {
      const p = await previewCrmTemplate(id);
      setPreview({ name, ...p });
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not preview that template'), 'bad');
    }
  };

  if (loading) return <div className="card"><p className="help">Loading communications…</p></div>;
  if (!data) return <div className="card"><p className="help">Communications are unavailable.</p></div>;

  const automated = data.communications.filter((c) => c.kind === 'automated');
  const manual = data.communications.filter((c) => c.kind === 'manual');

  const row = (c: CrmCommunicationRow) => (
    <tr key={c.key}>
      <td>
        <strong>{c.name}</strong>
        <div className="muted" style={{ fontSize: 12 }}>{c.description}</div>
      </td>
      {(['email', 'in_app', 'push'] as CrmChannel[]).map((ch) => (
        <td key={ch} style={{ textAlign: 'center' }}>
          {/* A channel this communication does not have shows a dash, not an unchecked box —
              an empty checkbox would read as "off", which is a different statement. */}
          {!c.channels[ch] ? <span className="muted">—</span> : (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={c.preferences[ch] ?? false}
                disabled={busy === `${c.key}:${ch}`}
                aria-label={`${CHANNEL_LABEL[ch]} for ${c.name}`}
                onChange={(e) => void toggle(c, ch, e.target.checked)}
              />
              <span className={`pill ${c.preferences[ch] ? 'ok' : 'bad'}`}>{c.preferences[ch] ? 'Active' : 'Off'}</span>
            </label>
          )}
        </td>
      ))}
      <td style={{ whiteSpace: 'nowrap' }}>
        {c.template ? (
          <>
            <button className="btn ghost sm" type="button" onClick={() => void openPreview(c.template!.id, c.name)}>👁 Preview</button>
            {c.template.can_edit && (
              <button className="btn ghost sm" type="button" style={{ marginLeft: 6 }}
                onClick={() => toast('Edit the wording under the template editor on this screen.', 'ok')}>
                ✏️ Edit Template
              </button>
            )}
            {!c.template.is_active && <span className="pill bad" style={{ marginLeft: 6 }}>Template off</span>}
          </>
        ) : <span className="muted">No template</span>}
      </td>
    </tr>
  );

  return (
    <>
      {standalone && (
        <div className="toolbar">
          <div className="toolbar-row">
            <div>
              <h2 className="lead-title">Communications</h2>
              <div className="lead-subtitle">
                <span className="muted">
                  Every CRM message, what your brokerage allows, and how each one reaches you.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ brokerage controls */}
      <div className="card">
        <div className="modal-sub" style={{ marginTop: 0 }}>Brokerage Controls</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className={`pill ${data.brokerage.auto_send_enabled ? 'ok' : 'bad'}`}>
            {data.brokerage.auto_send_enabled ? 'Active' : 'Off'}
          </span>
          <div>
            <strong>Allow CRM per-lead emails</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              Brokerage-wide. When this is off, no CRM email sends for anybody, whatever their own
              preferences say.
            </div>
          </div>
        </div>
        {!data.brokerage.can_edit && (
          <p className="help" style={{ marginTop: 8 }}>
            Only an administrator can change this. It is shown here so you can see why a
            communication may not be sending.
          </p>
        )}
        {data.brokerage.can_edit && (
          <p className="help" style={{ marginTop: 8 }}>
            Changed under Triggers → CRM Triggers, which remains the one place this switch is set.
          </p>
        )}
      </div>

      {/* --------------------------------------------- automated + manual */}
      <div className="card">
        <div className="modal-sub" style={{ marginTop: 0 }}>Automated CRM Communications</div>
        <p className="help" style={{ marginTop: 0 }}>
          <strong>These preferences apply only to your account.</strong> Changing them here does not
          affect any colleague.
        </p>
        <div className="lead-scroll">
          <table className="list-table">
            <thead>
              <tr>
                <th>Communication</th><th style={{ textAlign: 'center' }}>Email</th>
                <th style={{ textAlign: 'center' }}>In-app</th><th style={{ textAlign: 'center' }}>Push</th>
                <th>Template</th>
              </tr>
            </thead>
            <tbody>{automated.map(row)}</tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="modal-sub" style={{ marginTop: 0 }}>Manual CRM Emails</div>
        <p className="help" style={{ marginTop: 0 }}>
          Emails you send by hand from CRM Settings. They need one switch each — there is no
          schedule to mute, and no in-app or push equivalent of an email you chose to write.
        </p>
        <div className="lead-scroll">
          <table className="list-table">
            <thead>
              <tr>
                <th>Email</th><th style={{ textAlign: 'center' }}>Email</th>
                <th style={{ textAlign: 'center' }}>In-app</th><th style={{ textAlign: 'center' }}>Push</th>
                <th>Template</th>
              </tr>
            </thead>
            <tbody>{manual.map(row)}</tbody>
          </table>
        </div>
      </div>

      {/* -------------------------------------------------- admin-only area */}
      {data.is_admin && (
        <div className="card">
          <div className="tpl-head">
            <div>
              <div className="modal-sub" style={{ margin: 0 }}>Template Library</div>
              <div className="muted tpl-sub">
                For future CRM communications. A template is only sent by the CRM when it is mapped to
                a supported CRM event.
              </div>
            </div>
            <button className="btn primary" type="button" onClick={() => setCreating(true)}>+ Create New Template</button>
          </div>

          {data.unmapped_templates.length > 0 && (
            <>
              <div className="tpl-warn" style={{ marginTop: 10 }}>
                ⚠ The templates below are not connected to a CRM event and will not send
                automatically. Map one to an event to bring it into use.
              </div>
              <div className="lead-scroll" style={{ marginTop: 8 }}>
                <table className="list-table">
                  <thead><tr><th>Template</th><th>Subject</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {data.unmapped_templates.map((t) => (
                      <tr key={t.id}>
                        <td><strong>{t.name}</strong><div className="muted" style={{ fontSize: 11 }}>{t.event_key}</div></td>
                        <td>{t.subject}</td>
                        <td><span className="pill bad">Not connected</span></td>
                        <td><button className="btn ghost sm" type="button" onClick={() => void openPreview(t.id, t.name)}>👁 Preview</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {preview && <PreviewModal {...preview} onClose={() => setPreview(null)} />}
      {creating && (
        <CreateTemplateModal
          mappable={data.mappable_events}
          onClose={() => setCreating(false)}
          onCreated={(notice) => { setCreating(false); if (notice) toast(notice, 'bad'); else toast('Template created.', 'ok'); load(); }}
        />
      )}
    </>
  );
}

function PreviewModal({ name, subject, html, onClose }: { name: string; subject: string; html: string; onClose: () => void }) {
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <button className="close" type="button" onClick={onClose}>✕</button>
        <div className="modal-h">{name}</div>
        <div className="field"><label>Subject</label><div>{subject}</div></div>
        <div className="field">
          <label>Message</label>
          {/* Sandboxed: template HTML is authored content and must not run in this page. */}
          <iframe className="tpl-preview" title={`Preview of ${name}`} sandbox="" srcDoc={html} style={{ height: 420 }} />
        </div>
        <div className="actions"><button className="btn ghost" type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function CreateTemplateModal({ mappable, onClose, onCreated }: {
  mappable: { key: string; name: string }[];
  onClose: () => void;
  onCreated: (notice: string | null) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', subject: '', body_html: '', event_key: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const out = await createCrmTemplate({ ...form, event_key: form.event_key || undefined });
      onCreated(out.notice);
    } catch (err) {
      toast(apiErrorMessage(err, 'Could not create the template'), 'bad');
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal" style={{ maxWidth: 640 }} onSubmit={(e) => void submit(e)}>
        <button className="close" type="button" onClick={onClose} disabled={busy}>✕</button>
        <div className="modal-h">Create New CRM Template</div>

        <div className="field">
          <label>Template name *</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
        </div>

        <div className="field">
          <label>CRM event</label>
          {/*
            CHOSEN, NEVER TYPED. A free-text key that happened to match a real event would silently
            take over that email — and one that matched a Transaction Desk event would take over a
            Desk email from inside the CRM screen. Only CRM events with no template yet are offered.
          */}
          <select value={form.event_key} onChange={(e) => set('event_key', e.target.value)}>
            <option value="">Not connected — create as a draft</option>
            {mappable.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
          </select>
          <div className="help">
            {form.event_key
              ? 'This template will be used the next time that CRM event happens.'
              : 'This template is not connected to a CRM event and will not send automatically. It is created inactive; connect it to an event later to bring it into use.'}
          </div>
        </div>

        <div className="field">
          <label>Subject *</label>
          <input value={form.subject} onChange={(e) => set('subject', e.target.value)} required />
        </div>

        <div className="field">
          <label>Message *</label>
          <textarea rows={8} value={form.body_html} onChange={(e) => set('body_html', e.target.value)} required
            style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder={'<p>Hello {{ user_name }},</p>'} />
        </div>

        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create Template'}</button>
        </div>
      </form>
    </div>
  );
}
