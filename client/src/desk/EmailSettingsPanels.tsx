import { useEffect, useRef, useState } from 'react';
import {
  getMailAccounts, createMailAccount, updateMailAccount, deleteMailAccount,
  setDefaultMailAccount, testMailAccount, getEmailTemplates, updateEmailTemplate,
  previewEmailTemplate,
} from '../lib/api';
import { type ToastFn } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { EmailTemplate, MailAccount, TemplateGroup, TemplatePreview } from '../types';
import RichTextEditor, { type RichTextHandle } from './RichTextEditor';
import { addEmailTemplateAttachment, deleteEmailTemplateAttachment, emailTemplateAttachmentUrl } from '../lib/api';
import type { EmailTemplateAttachment } from '../types/email';

/**
 * The SMTP-account and email-template panels.
 *
 * These were the whole of the standalone "Email Settings" screen. That screen is gone —
 * everything it did now lives inside Settings — so this file exports the two panels
 * unchanged and SettingsPage supplies the surrounding tab shell. The components
 * themselves, their API calls, validation and permissions are exactly as they were; only
 * where they are mounted has changed.
 */

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

/* ---------------------------------- SMTP Accounts ---------------------------------- */

export function AccountsTab({ toast }: { toast: ToastFn }) {
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
                      <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={() => onDelete(a)}>🗑️</button>
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

export function TemplatesTab({ toast }: { toast: ToastFn }) {
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
  const bodyRef = useRef<RichTextHandle>(null);
  // Attachments are managed on their own endpoints, not through the template body, so they
  // save the moment they are picked rather than waiting for Save. That keeps a large file out
  // of the template PUT, and means closing without saving does not silently discard an upload.
  const [files, setFiles] = useState<EmailTemplateAttachment[]>(template.attachments ?? []);
  const [busyFile, setBusyFile] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // The editor owns the caret in both of its views, so insertion is delegated to it.
  const insertVar = (v: string) => {
    const token = `{{ ${v} }}`;
    if (bodyRef.current) bodyRef.current.insert(token);
    else set('body_html', form.body_html + token);
  };

  const addFile = async (file: File | null) => {
    if (!file) return;
    setBusyFile('upload');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? '').split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Could not read that file'));
        r.readAsDataURL(file);
      });
      const added = await addEmailTemplateAttachment(template.id, file.name, file.type || 'application/octet-stream', base64);
      setFiles((f) => [...f, added]);
      toast(`${file.name} attached`, 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not attach that file'), 'bad');
    } finally {
      setBusyFile('');
      // Cleared so re-picking the same file fires change again.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeFile = async (a: EmailTemplateAttachment) => {
    if (!window.confirm(`Remove ${a.filename} from this template?`)) return;
    setBusyFile(String(a.id));
    try {
      await deleteEmailTemplateAttachment(template.id, a.id);
      setFiles((f) => f.filter((x) => x.id !== a.id));
      toast('Attachment removed', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not remove it'), 'bad');
    } finally { setBusyFile(''); }
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

        <div className="field" style={{ marginBottom: 4 }}><label>Message</label>
          {/* Written as it will be read. The HTML button on the toolbar still opens the source,
              because email HTML sometimes has to be adjusted by hand. */}
          <RichTextEditor ref={bodyRef} value={form.body_html} onChange={(v) => set('body_html', v)} rows={10} /></div>

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

        <div className="field" style={{ marginBottom: 12 }}>
          <label>Attachments</label>
          <span className="help" style={{ marginBottom: 6, display: 'block' }}>
            Sent with every email from this template — up to 5 files, 5 MB in total.
          </span>
          {files.length > 0 && (
            <ul className="tmpl-files">
              {files.map((a) => (
                <li key={a.id}>
                  <span className="tmpl-file-ico">📎</span>
                  <a href={emailTemplateAttachmentUrl(template.id, a.id)} target="_blank" rel="noreferrer">{a.filename}</a>
                  <span className="tmpl-file-size">{a.size < 1024 * 1024 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : `${(a.size / 1024 / 1024).toFixed(1)} MB`}</span>
                  <button type="button" className="btn ghost sm" disabled={busyFile !== ''} onClick={() => void removeFile(a)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <input ref={fileInput} type="file" style={{ display: 'none' }} onChange={(e) => void addFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="btn ghost sm" disabled={busyFile !== '' || files.length >= 5}
            onClick={() => fileInput.current?.click()}>
            {busyFile === 'upload' ? 'Attaching…' : files.length >= 5 ? 'Attachment limit reached' : '📎 Attach a file'}
          </button>
        </div>

        {preview && (
          <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
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
