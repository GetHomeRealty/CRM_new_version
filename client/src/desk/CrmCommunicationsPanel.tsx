import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from './toast';
import { crmPath } from './area';
import { apiErrorMessage } from '../lib/apiError';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import {
  createCrmTemplate, getCrmCommunications, previewCrmTemplate, setCrmBrokerage, setCrmPreference,
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
  const navigate = useNavigate();
  const [data, setData] = useState<CrmCommunicationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{ name: string; subject: string; html: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const { confirm, askDelete, closeConfirm } = useConfirm();

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

  /**
   * Save one brokerage control. Only the field that moved is sent — the server leaves the rest.
   *
   * Not optimistic, unlike the personal toggles above. These are brokerage-wide: one row, one
   * value, every colleague's sending. A switch that appears to move and then silently reverts is
   * survivable for your own preference and is not for a control an administrator reaches for during
   * a complaint, so this one waits for the server and re-seats from its answer.
   */
  const saveBrokerage = async (body: { auto_send_enabled?: boolean; defaults?: Record<string, boolean> }, id: string) => {
    setBusy(id);
    try {
      setData(await setCrmBrokerage(body));
      toast('Brokerage controls saved', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the brokerage controls'), 'bad');
    } finally {
      setBusy('');
    }
  };

  /**
   * Turning the master switch OFF is confirmed; turning it on is not.
   *
   * The blast radius is the reason. Off means no CRM email of any kind leaves for anybody —
   * colleagues included, whatever their own choices say — and the sending screen then refuses
   * without explaining why. Turning it back on restores the status quo and needs no ceremony, and a
   * confirmation people meet in both directions is one they learn to click through.
   */
  const toggleMaster = (next: boolean) => {
    if (next) { void saveBrokerage({ auto_send_enabled: true }, 'brokerage:master'); return; }
    askDelete({
      title: 'Switch off CRM email for the whole brokerage?',
      message: 'No CRM email will send for anybody — not yours, not any colleague’s — whatever their own preferences say. The sending screen will refuse without explaining why. Campaigns are not affected; those are stopped on the Campaigns screen.',
      note: 'You can turn it back on here at any time.',
      // Named, because this dialog's default affirmative is "Delete" and nothing is being deleted.
      // See `ConfirmOptions.confirmLabel`: a dialog whose only affirmative reads "Delete" over the
      // words "no CRM email will send for anybody" asks the reader to press the wrong verb.
      confirmLabel: 'Switch it off',
      onConfirm: () => { closeConfirm(); void saveBrokerage({ auto_send_enabled: false }, 'brokerage:master'); },
    });
  };

  /**
   * Open this communication's own template in the editor that already owns it.
   *
   * CRM → Settings → Templates, with the row's id, rather than an editor built here. Those are the
   * same `email_templates` rows behind the same `/api/email-templates` endpoints, so a second
   * editor would be a second copy of the subject, body, sender, attachment and Active/Off handling
   * — free to drift, and free to disagree about which row a communication means. Sending the id
   * instead means there is exactly one editor and exactly one row: nothing here creates a template,
   * and nothing here can create a duplicate of one.
   *
   * `id` comes from `template.id` on the row, which the server resolved from the registry's
   * `templateEventKey`, so the mapping is the registry's and is not restated in this file.
   */
  const editTemplate = (id: number) => {
    navigate(`${crmPath('settings')}?tab=crm&section=templates&template=${id}`);
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
        {/*
          What the brokerage would give you, for the rows that have a brokerage layer. The Triggers
          screen distinguished "I chose this" from "I am following the office", and losing that on
          the move would have made an inherited value look like a decision somebody had made.
          Stated as the default rather than as your status, because the server sends the effective
          answer and not whether a row exists — the honest thing to show is what it falls back to.
        */}
        {c.brokerage_default !== null && (
          <div className="muted" style={{ fontSize: 11 }}>
            Brokerage default: {c.brokerage_default ? 'on' : 'off'}
          </div>
        )}
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
                title={`Edit "${c.template.name}" in CRM Settings → Templates`}
                onClick={() => editTemplate(c.template!.id)}>
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

      {/*
        ------------------------------------------------ brokerage controls

        FIRST, BECAUSE THE MASTER SWITCH OVERRIDES EVERYTHING BELOW IT. A control that can make the
        rest of the screen inert should not sit underneath it.

        This is where the CRM Triggers screen's "Brokerage" card went, whole: the master switch and
        the per-communication defaults, on the same `crm_email_settings` row, behind the same
        `settings: edit` permission. It is a change of location, not a second copy — there is no
        other screen and no other endpoint offering these two values.
      */}
      <div className="card">
        <div className="modal-sub" style={{ marginTop: 0 }}>Brokerage Controls</div>
        <p className="help" style={{ marginTop: 0 }}>
          These apply to <strong>everybody</strong>, not just you.
        </p>

        <label className="crm-toggle">
          <span className="crm-toggle-text">
            <strong>Allow CRM per-lead emails</strong>
            <em>
              Brokerage-wide. When this is off, no CRM email sends for anybody, whatever their own
              preferences say. Email campaigns are not affected; those are stopped on the Campaigns
              screen.
            </em>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className={`pill ${data.brokerage.auto_send_enabled ? 'ok' : 'bad'}`}>
              {data.brokerage.auto_send_enabled ? 'Active' : 'Off'}
            </span>
            <input
              type="checkbox"
              checked={data.brokerage.auto_send_enabled}
              disabled={!data.brokerage.can_edit || busy === 'brokerage:master'}
              aria-label="Allow CRM per-lead emails — brokerage-wide"
              onChange={(e) => toggleMaster(e.target.checked)}
            />
          </span>
        </label>

        {/*
          The defaults. Shown only to somebody who may change them: to everyone else they are not a
          control but a fact about a value they cannot reach, and the row's own "Following the
          brokerage default" note already tells an agent what they inherit.
        */}
        {data.brokerage.can_edit && (
          <>
            <div className="modal-sub">Brokerage defaults</div>
            <p className="help" style={{ marginTop: 0 }}>
              What a colleague gets when they have not chosen for themselves. Changing one moves
              everybody who is still following it, and nobody who is not.
            </p>
            {data.brokerage.default_keys.map((key) => {
              const row = data.communications.find((c) => c.key === key);
              return (
                <label className="crm-toggle" key={key}>
                  <span className="crm-toggle-text">
                    <strong>{row?.name ?? key}</strong>
                    {row?.description && <em>{row.description}</em>}
                  </span>
                  <input
                    type="checkbox"
                    checked={data.brokerage.defaults[key] ?? false}
                    disabled={busy === `brokerage:${key}`}
                    aria-label={`Brokerage default for ${row?.name ?? key}`}
                    onChange={(e) => void saveBrokerage({ defaults: { [key]: e.target.checked } }, `brokerage:${key}`)}
                  />
                </label>
              );
            })}
            {(data.brokerage.updated_at || data.brokerage.updated_by) && (
              <p className="help" style={{ marginTop: 10 }}>
                Last changed by {data.brokerage.updated_by ?? 'an administrator'}
                {data.brokerage.updated_at ? ` on ${data.brokerage.updated_at.replace('T', ' ').slice(0, 16)}` : ''}.
              </p>
            )}
          </>
        )}

        {!data.brokerage.can_edit && (
          <p className="help" style={{ marginTop: 8 }}>
            <strong>Read-only.</strong> Changing this needs the Settings permission at <em>Edit</em>.
            It is shown here so you can see why a communication may not be sending.
          </p>
        )}

        {!data.brokerage.auto_send_enabled && (
          <div className="reminder-warn" style={{ marginTop: 8 }}>
            <strong>CRM email is switched off for the whole brokerage.</strong> The preferences below
            are saved, but nothing can send until{' '}
            {data.brokerage.can_edit ? 'you switch it back on above.' : 'an administrator switches it back on.'}
          </div>
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

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
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
