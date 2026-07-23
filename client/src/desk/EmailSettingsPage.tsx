import { useEffect, useRef, useState } from 'react';
import CrmSettingsPanel from './CrmSettingsPanel';
import {
  getMailAccounts, createMailAccount, updateMailAccount, deleteMailAccount,
  setDefaultMailAccount, testMailAccount, getEmailTemplates, updateEmailTemplate,
  previewEmailTemplate,
} from '../lib/api';
import { useToast, type ToastFn } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { EmailTemplate, MailAccount, TemplateGroup, TemplatePreview } from '../types';

interface AccountForm {
  name: string;
  from_name: string;
  from_email: string;
  host: string;
  port: number | string;
  username: string;
  password: string;
  encryption: string;
  is_active: boolean;
  is_default: boolean;
}

const EMPTY_ACCOUNT: AccountForm = {
  name: '', from_name: '', from_email: '', host: '', port: 587,
  username: '', password: '', encryption: 'tls', is_active: true, is_default: false,
};

export default function EmailSettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState('accounts');

  return (
    <>
      <div className="toolbar"><div className="toolbar-row">
        <button className={`btn sm ${tab === 'accounts' ? 'primary' : 'ghost'}`} onClick={() => setTab('accounts')}>📮 SMTP Accounts</button>
        <button className={`btn sm ${tab === 'templates' ? 'primary' : 'ghost'}`} onClick={() => setTab('templates')}>📝 Templates</button>
        {/* Migrated CRM Settings — its own tab, so the two tabs above are untouched. */}
        <button className={`btn sm ${tab === 'crm' ? 'primary' : 'ghost'}`} onClick={() => setTab('crm')}>⚙️ CRM Settings</button>
      </div></div>

      {tab === 'accounts' && <AccountsTab toast={toast} />}
      {tab === 'templates' && <TemplatesTab toast={toast} />}
      {tab === 'crm' && <CrmSettingsPanel />}
    </>
  );
}

/* ---------------------------------- SMTP Accounts ---------------------------------- */

function AccountsTab({ toast }: { toast: ToastFn }) {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<MailAccount> | null>(null); // account object or {} for new

  const load = () => getMailAccounts().then(setAccounts).catch(() => toast('Could not load accounts', 'bad')).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSetDefault = async (a: MailAccount) => {
    try { await setDefaultMailAccount(a.id); toast(`${a.name} is now the default sender`, 'ok'); load(); }
    catch { toast('Could not set default', 'bad'); }
  };
  const onTest = async (a: MailAccount) => {
    const to = window.prompt(`Send a test email from "${a.name}" to:`);
    if (!to) return;
    try { const r = await testMailAccount(a.id, to); toast(r.message || 'Test sent', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Test failed'), 'bad'); }
  };
  const onDelete = async (a: MailAccount) => {
    if (!window.confirm(`Delete SMTP account "${a.name}"?`)) return;
    try { await deleteMailAccount(a.id); toast('Account deleted', 'ok'); load(); }
    catch { toast('Could not delete', 'bad'); }
  };

  return (
    <>
      <div className="toolbar"><div className="toolbar-row">
        <strong>SMTP Sender Accounts</strong>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={() => setEditing({ ...EMPTY_ACCOUNT })}>+ Add Account</button>
      </div></div>

      <table className="list-table">
        <thead><tr><th>Name</th><th>From</th><th>Host</th><th>Active</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={6} className="centered">Loading…</td></tr>
            : accounts.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No SMTP accounts yet. Add one to start sending email.</td></tr>
              : accounts.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td>{a.from_name ? `${a.from_name} <${a.from_email}>` : a.from_email}</td>
                  <td>{a.host}:{a.port}{a.encryption ? ` (${a.encryption})` : ''}</td>
                  <td><span className={`pill ${a.is_active ? 'ok' : 'bad'}`}>{a.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td>{a.is_default ? <span className="pill info">★ Default</span> : <button className="btn ghost sm" onClick={() => onSetDefault(a)}>Set default</button>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => setEditing(a)}>Edit</button>
                      <button className="btn ghost sm" onClick={() => onTest(a)}>✉ Test</button>
                      <button className="btn ghost sm" style={{ color: '#dc2626' }} onClick={() => onDelete(a)}>🗑️</button>
                    </div>
                  </td>
                </tr>
              ))}
        </tbody>
      </table>

      {editing && <AccountModal account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} toast={toast} />}
    </>
  );
}

interface AccountModalProps {
  account: Partial<MailAccount>;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastFn;
}

function AccountModal({ account, onClose, onSaved, toast }: AccountModalProps) {
  const isEdit = !!account.id;
  const [form, setForm] = useState<AccountForm>(() => ({
    name: account.name || '', from_name: account.from_name || '', from_email: account.from_email || '',
    host: account.host || '', port: account.port ?? 587, username: account.username || '', password: '',
    encryption: account.encryption || 'tls', is_active: account.is_active ?? true, is_default: account.is_default ?? false,
  }));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim() || !form.from_email.trim() || !form.host.trim()) {
      toast('Name, From Email and Host are required', 'bad'); return;
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(), from_name: form.from_name || null, from_email: form.from_email.trim(),
      host: form.host.trim(), port: Number(form.port) || 587, username: form.username || null,
      encryption: form.encryption || null, is_active: !!form.is_active, is_default: !!form.is_default,
    };
    if (form.password) payload.password = form.password; // blank keeps the stored one
    setSaving(true);
    try {
      if (isEdit && account.id != null) await updateMailAccount(account.id, payload); else await createMailAccount(payload);
      toast(isEdit ? 'Account updated' : 'Account created', 'ok');
      onSaved();
    } catch (e) { toast(apiErrorMessage(e, 'Could not save'), 'bad'); }
    finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{isEdit ? 'Edit SMTP Account' : 'Add SMTP Account'}</div>

        <div className="g2">
          <div className="field"><label>Name <span className="req">*</span></label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Accounts / Invoicing" /></div>
          <div className="field"><label>From Name</label>
            <input value={form.from_name || ''} onChange={(e) => set('from_name', e.target.value)} placeholder="Get Home Realty" /></div>
        </div>
        <div className="field"><label>From Email <span className="req">*</span></label>
          <input type="email" value={form.from_email} onChange={(e) => set('from_email', e.target.value)} placeholder="accounts@gethomerealty.ca" /></div>
        <div className="g3">
          <div className="field"><label>Host <span className="req">*</span></label>
            <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.gmail.com" /></div>
          <div className="field"><label>Port</label>
            <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="587" /></div>
          <div className="field"><label>Encryption</label>
            <select value={form.encryption || ''} onChange={(e) => set('encryption', e.target.value)}>
              <option value="">None</option><option value="tls">TLS</option><option value="ssl">SSL</option>
            </select></div>
        </div>
        <div className="g2">
          <div className="field"><label>Username</label>
            <input value={form.username || ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></div>
          <div className="field"><label>Password</label>
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password"
              placeholder={isEdit && account.has_password ? 'leave blank to keep current' : ''} /></div>
        </div>
        <div className="g2">
          <div className="field"><label>Status</label>
            <select value={form.is_active ? 'Active' : 'Inactive'} onChange={(e) => set('is_active', e.target.value === 'Active')}>
              <option>Active</option><option>Inactive</option></select></div>
          <div className="field"><label>Default sender</label>
            <select value={form.is_default ? 'Yes' : 'No'} onChange={(e) => set('is_default', e.target.value === 'Yes')}>
              <option>No</option><option>Yes</option></select>
            <span className="help">Used when a template doesn't pick its own sender.</span></div>
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Templates ---------------------------------- */

function TemplatesTab({ toast }: { toast: ToastFn }) {
  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EmailTemplate | null>(null); // template object

  const load = () => getEmailTemplates()
    .then((d) => {
      setGroups(d.groups || []);
      const ma = d.mail_accounts;
      setAccounts(Array.isArray(ma) ? ma : (ma?.data ?? []));
    })
    .catch(() => toast('Could not load templates', 'bad')).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="centered">Loading templates…</div>;

  return (
    <>
      {groups.map((g) => (
        <div className="card" key={g.module} style={{ marginBottom: 14 }}>
          <div className="modal-sub" style={{ marginTop: 0 }}>{g.module}</div>
          <table className="list-table">
            <thead><tr><th>Template</th><th>Subject</th><th>Sender</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>
              {g.templates.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong><div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.event_key}</div></td>
                  <td style={{ maxWidth: 320, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</td>
                  <td>{accounts.find((a) => a.id === t.mail_account_id)?.name || <span style={{ color: 'var(--muted)' }}>Default sender</span>}</td>
                  <td><span className={`pill ${t.is_active ? 'ok' : 'bad'}`}>{t.is_active ? 'Active' : 'Off'}</span></td>
                  <td><button className="btn ghost sm" onClick={() => setEditing(t)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {editing && <TemplateEditor template={editing} accounts={accounts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} toast={toast} />}
    </>
  );
}

interface TemplateForm {
  subject: string;
  body_html: string;
  mail_account_id: number | string;
  is_active: boolean;
}

interface TemplateEditorProps {
  template: EmailTemplate;
  accounts: MailAccount[];
  onClose: () => void;
  onSaved: () => void;
  toast: ToastFn;
}

function TemplateEditor({ template, accounts, onClose, onSaved, toast }: TemplateEditorProps) {
  const [form, setForm] = useState<TemplateForm>({
    subject: template.subject, body_html: template.body_html,
    mail_account_id: template.mail_account_id || '', is_active: template.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const insertVar = (v: string) => {
    const token = `{{ ${v} }}`;
    const el = bodyRef.current;
    if (!el) { set('body_html', form.body_html + token); return; }
    const start = el.selectionStart ?? form.body_html.length;
    const end = el.selectionEnd ?? form.body_html.length;
    const next = form.body_html.slice(0, start) + token + form.body_html.slice(end);
    set('body_html', next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; });
  };

  const doSave = async () => {
    const payload = {
      subject: form.subject, body_html: form.body_html,
      mail_account_id: form.mail_account_id || null, is_active: !!form.is_active,
    };
    await updateEmailTemplate(template.id, payload);
  };

  const save = async () => {
    if (!form.subject.trim() || !form.body_html.trim()) { toast('Subject and body are required', 'bad'); return; }
    setSaving(true);
    try { await doSave(); toast('Template saved', 'ok'); onSaved(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not save'), 'bad'); }
    finally { setSaving(false); }
  };

  // Save first so the preview reflects the current edits, then render server-side.
  const doPreview = async () => {
    try { await doSave(); const r = await previewEmailTemplate(template.id); setPreview(r); }
    catch { toast('Could not preview', 'bad'); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ marginBottom: 2 }}>{template.name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>{template.module} · {template.event_key}</div>

        <div className="field"><label>Subject</label>
          <input value={form.subject} onChange={(e) => set('subject', e.target.value)} /></div>

        <div className="g2">
          <div className="field"><label>Sender account</label>
            <select value={form.mail_account_id} onChange={(e) => set('mail_account_id', e.target.value)}>
              <option value="">Use default sender</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.from_email})</option>)}
            </select>
            <span className="help">Which SMTP account this email is sent from.</span></div>
          <div className="field"><label>Status</label>
            <select value={form.is_active ? 'Active' : 'Off'} onChange={(e) => set('is_active', e.target.value === 'Active')}>
              <option>Active</option><option>Off</option></select>
            <span className="help">When Off, this email is not sent.</span></div>
        </div>

        <div className="field" style={{ marginBottom: 4 }}><label>HTML Body</label>
          <textarea ref={bodyRef} rows={10} value={form.body_html} onChange={(e) => set('body_html', e.target.value)} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12.5 }} /></div>

        {template.variables && template.variables.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Insert variable:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {template.variables.map((v) => (
                <button key={v} type="button" className="btn ghost sm" onClick={() => insertVar(v)} title={`Insert {{ ${v} }}`}>{`{{ ${v} }}`}</button>
              ))}
            </div>
          </div>
        )}

        {preview && (
          <div className="card" style={{ background: '#f8fafc', marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>PREVIEW (sample values)</div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Subject: {preview.subject}</div>
            <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }} dangerouslySetInnerHTML={{ __html: preview.html || '' }} />
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn ghost" onClick={doPreview}>👁 Preview</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
