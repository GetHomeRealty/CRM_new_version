import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addTemplateAttachment, createCampaignTemplate, deleteCampaignTemplate, deleteTemplateAttachment,
  getCampaignTemplate, listCampaignTemplates, updateCampaignTemplate,
} from '../lib/campaignTemplatesApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { TemplateBuilder, renderBuilder, parseBuilder, starterDesign, DEFAULT_STYLES, type Block, type Styles } from './TemplateBuilder';

const BLANK_STYLES: Styles = DEFAULT_STYLES;
import type { CampaignOptions, CampaignTemplateDetail } from '../types';

const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Read a File into the base64 payload the API expects. */
const toBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(new Error('That file could not be read.'));
  reader.readAsDataURL(file);
});

/**
 * The Campaigns module's template library.
 *
 * These are marketing templates, entirely separate from the transactional templates under
 * Email Settings — editing one here never touches the mail the system sends automatically.
 */
export default function CampaignTemplates({ options, onChanged, onUse }: {
  options: CampaignOptions | null;
  onChanged: () => void;
  /** "Send" on a card — hand the template to the campaign builder. */
  onUse?: (templateId: number) => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('campaigns', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const [templates, setTemplates] = useState<CampaignTemplateDetail[]>([]);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CampaignTemplateDetail | 'new' | null>(null);
  const [previewing, setPreviewing] = useState<CampaignTemplateDetail | null>(null);
  const [busy, setBusy] = useState(0);

  /**
   * Only the first fetch shows a loading state; switching category or refreshing after a save
   * swaps the cards in place rather than emptying the list first.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      setTemplates(await listCampaignTemplates(category));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load templates'), 'bad');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [category, toast]);

  useEffect(() => { void load(); }, [load]);

  const remove = (t: CampaignTemplateDetail) => askDelete({
    title: `Delete "${t.name}"?`,
    message: 'It will no longer be selectable when building a campaign.',
    note: 'Campaigns already sent keep their own copy of the subject and body, so their history is unaffected.',
    onConfirm: async () => {
      try {
        const res = await deleteCampaignTemplate(t.id);
        toast(res.used_by > 0
          ? `Template deleted. ${res.used_by} past campaign(s) keep their sent copy.`
          : 'Template deleted.', 'ok');
        await load();
        onChanged();
      } catch (ex) {
        toast(apiErrorMessage(ex, 'Could not delete the template'), 'bad');
      } finally {
        closeConfirm();
      }
    },
  });

  /** Make a copy of a template — same content, "(Copy)" appended, so it can be tweaked freely. */
  const duplicate = async (t: CampaignTemplateDetail) => {
    setBusy(t.id);
    try {
      await createCampaignTemplate({ name: `${t.name} (Copy)`, subject: t.subject, content: t.content, category: t.category });
      toast('Template duplicated.', 'ok');
      await load();
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not duplicate the template'), 'bad');
    } finally {
      setBusy(0);
    }
  };

  const label = (value: string): string =>
    options?.categories.find((c) => c.value === value)?.label ?? value;

  // Search filters the loaded set in place (the category filter is applied server-side).
  const shown = templates.filter((t) => {
    const q = search.trim().toLowerCase();
    return !q || t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q);
  });

  return (
    <div className="card">
      <div className="tpl-head">
        <div>
          <div className="modal-h" style={{ margin: 0 }}>Email Templates</div>
          <div className="muted tpl-sub">
            Create and manage reusable email templates for your leads and clients.
          </div>
        </div>
        {canEdit && <button className="btn primary" type="button" onClick={() => setEditing('new')}>+ Create Template</button>}
      </div>

      <div className="tpl-toolbar">
        <input className="tpl-search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍  Search templates by name or subject…" />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {(options?.categories ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="help">Loading templates…</p>
      ) : shown.length === 0 ? (
        <p className="help">
          {search.trim() ? 'No templates match your search.'
            : category === 'all' ? 'No templates yet.' : 'No templates in this category.'}
          {canEdit && !search.trim() ? ' Create one to send a campaign.' : ''}
        </p>
      ) : (
        <div className="tpl-grid">
          {shown.map((t) => (
            <div key={t.id} className="tpl-card">
              {/* Rendered preview thumbnail — click (or the hover button) opens the full preview.
                  Sandboxed and non-interactive so the stored HTML can't run or be clicked into. */}
              <button className="tpl-thumb" type="button" onClick={() => setPreviewing(t)} title={`Preview ${t.name}`}>
                <iframe className="tpl-thumb-frame" title={`Preview of ${t.name}`} sandbox="" srcDoc={t.content} tabIndex={-1} />
                <span className="tpl-thumb-overlay"><span className="tpl-thumb-btn">👁 Preview</span></span>
              </button>

              <div className="tpl-card-body">
                <div className="tpl-card-top">
                  <strong className="tpl-card-name">{t.name}</strong>
                  <span className="pill type-res-buy">{label(t.category)}</span>
                </div>
                <div className="muted tpl-card-subject">{t.subject}</div>
                <div className="tpl-card-foot">
                  {t.created_by ? `By ${t.created_by}` : 'Built-in template'}
                  {t.attachments.length > 0 && <span className="pill warn" style={{ marginLeft: 6 }}>📎 {t.attachments.length}</span>}
                </div>
              </div>

              <div className="tpl-card-actions">
                {canEdit && <button className="btn ghost sm" type="button" onClick={() => setEditing(t)} title="Edit">✏️ Edit</button>}
                {canEdit && onUse && <button className="icon-btn" type="button" onClick={() => onUse(t.id)} title="Send as a campaign">📨</button>}
                {canEdit && <button className="icon-btn" type="button" disabled={busy === t.id} onClick={() => void duplicate(t)} title="Duplicate">📄</button>}
                {canEdit && <button className="icon-btn danger" type="button" onClick={() => remove(t)} title="Delete">🗑️</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {previewing && (
        <TemplatePreview template={previewing} options={options} canEdit={canEdit}
          onClose={() => setPreviewing(null)}
          onChanged={() => { void load(); onChanged(); }} />
      )}

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); onChanged(); }}
        />
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}

/**
 * Full-size preview of a template: the rendered email, the tokens it uses, and its attachments.
 * Opened from a card's thumbnail — the card grid stays clean, the detail lives here.
 */
function TemplatePreview({ template, options, canEdit, onClose, onChanged }: {
  template: CampaignTemplateDetail; options: CampaignOptions | null; canEdit: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 760 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h" style={{ marginBottom: 4 }}>{template.name}</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{template.subject}</div>

        {template.variables.length > 0 && (
          <div className="tpl-tokens">
            {template.variables.map((v) => {
              const fillable = (options?.fillable_tokens ?? []).includes(v);
              return (
                <span key={v} className={`pill ${fillable ? 'ok' : 'bad'}`}
                  title={fillable ? 'Filled automatically on send' : 'Cannot be filled — it will be removed from the email'}>
                  {`{{${v}}}`}
                </span>
              );
            })}
          </div>
        )}

        <TemplateAttachments template={template} canEdit={canEdit} onChanged={onChanged} />
        {/* Sandboxed: stored template HTML is rendered without scripts or same-origin access. */}
        <iframe className="tpl-preview" title={`Preview of ${template.name}`} sandbox="" srcDoc={template.content} />
      </div>
    </div>
  );
}

function TemplateAttachments({ template, canEdit, onChanged }: {
  template: CampaignTemplateDetail; canEdit: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const used = template.attachments.reduce((s, a) => s + a.size, 0);

  const upload = async (file: File) => {
    if (used + file.size > MAX_TOTAL_BYTES) {
      toast(`"${file.name}" would push the attachments past the 5 MB limit — most mail servers would reject the message.`, 'bad');
      return;
    }
    setBusy(true);
    try {
      await addTemplateAttachment(template.id, {
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        data: await toBase64(file),
      });
      toast(`"${file.name}" attached.`, 'ok');
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not attach that file'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (attachmentId: number, name: string) => {
    setBusy(true);
    try {
      await deleteTemplateAttachment(template.id, attachmentId);
      toast(`"${name}" removed.`, 'ok');
      onChanged();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not remove that file'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpl-attach">
      <div className="tpl-attach-h">
        Attachments ({template.attachments.length}) · {kb(used)} of 5 MB
      </div>
      {template.attachments.length > 0 && (
        <ul className="tpl-files">
          {template.attachments.map((a) => (
            <li key={a.id}>
              <span className="tpl-file-name" title={a.filename}>📎 {a.filename}</span>
              <span className="muted">{kb(a.size)}</span>
              {canEdit && (
                <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void drop(a.id, a.filename)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <label className="tpl-upload">
          <input type="file" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void upload(f); e.target.value = ''; } }} />
        </label>
      )}
      <span className="help">Every attachment is sent with every recipient's copy of this template.</span>
    </div>
  );
}

function TemplateEditor({ template, options, onClose, onSaved }: {
  template: CampaignTemplateDetail | null;
  options: CampaignOptions | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: template?.name ?? '',
    subject: template?.subject ?? '',
    category: template?.category ?? 'custom',
    content: '',
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!template);
  // Visual builder ("design") vs. raw HTML. New templates start in the builder.
  const [mode, setMode] = useState<'design' | 'html'>(template ? 'html' : 'design');
  /** Closed until asked for — see the toggle beside the builder/HTML switch. */
  const [showPreview, setShowPreview] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>(() => (template ? [] : starterDesign().blocks));
  const [styles, setStyles] = useState<Styles>(() => (template ? BLANK_STYLES : starterDesign().styles));

  // The list response omits the body to stay small; fetch it when the editor opens.
  useEffect(() => {
    if (!template) return;
    getCampaignTemplate(template.id)
      .then((full) => {
        setForm((f) => ({ ...f, content: full.content }));
        // If it was built with the visual builder, reopen it there; otherwise stay in HTML.
        const parsed = parseBuilder(full.content);
        if (parsed) { setBlocks(parsed.blocks); setStyles(parsed.styles); setMode('design'); }
      })
      .catch(() => toast('Could not load the template body', 'bad'))
      .finally(() => setLoading(false));
  }, [template, toast]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  // In design mode the body is generated from the blocks; in HTML mode it's the textarea.
  const content = mode === 'design' ? renderBuilder(blocks, styles) : form.content;

  const tokens = [...new Set(Array.from(`${form.subject} ${content}`.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g), (m) => m[1]))];
  const unfillable = tokens.filter((t) => !(options?.fillable_tokens ?? []).includes(t));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const payload = { name: form.name, subject: form.subject, category: form.category, content };
      if (template) await updateCampaignTemplate(template.id, payload);
      else await createCampaignTemplate(payload);
      toast(template ? 'Template updated.' : 'Template created.', 'ok');
      onSaved();
    } catch (ex) {
      const fields = apiFieldErrors(ex);
      if (fields) setErrors(fields);
      toast(apiErrorMessage(ex, 'Could not save the template'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">{template ? `Edit Template — ${template.name}` : 'New Email Template'}</div>

        <form onSubmit={submit}>
          <div className="g2">
            <div className="field">
              <label>Name *</label>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
              {err('name')}
            </div>
            <div className="field">
              <label>Category</label>
              <select value={form.category} onChange={(e) => set('category', e.target.value)}>
                {(options?.categories ?? [{ value: 'custom', label: 'Custom' }]).map((c) =>
                  <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {err('category')}
            </div>
          </div>

          <div className="field">
            <label>Subject *</label>
            <input value={form.subject} onChange={(e) => set('subject', e.target.value)} required
              placeholder="Hi {{LEAD_NAME}}, a home you might like" />
            {err('subject')}
          </div>

          <div className="field">
            <div className="tpl-body-head">
              <label style={{ margin: 0 }}>Body *</label>
              <div className="seg">
                <button type="button" className={`seg-btn${mode === 'design' ? ' on' : ''}`}
                  onClick={() => setMode('design')}>🎨 Visual builder</button>
                <button type="button" className={`seg-btn${mode === 'html' ? ' on' : ''}`}
                  onClick={() => { setForm((f) => ({ ...f, content })); setMode('html'); }}>{'</>'} HTML</button>
              </div>
              {/* The preview used to be a permanent second column, which left the blocks
                  themselves in a little over half the width. Off by default so building has the
                  room, on when you want to check the result. */}
              {mode === 'design' && (
                <button type="button" className={`btn ghost sm${showPreview ? ' primary' : ''}`}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? '✕ Hide preview' : '👁 Preview'}
                </button>
              )}
            </div>

            {loading ? (
              <p className="help">Loading…</p>
            ) : mode === 'design' ? (
              <div className={`tpl-build${showPreview ? '' : ' solo'}`}>
                <TemplateBuilder blocks={blocks} setBlocks={setBlocks} styles={styles} setStyles={setStyles} />
                {showPreview && (
                  <div className="tpl-build-preview">
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Live preview</div>
                    <iframe className="tpl-preview" title="Template preview" sandbox="" srcDoc={content} />
                  </div>
                )}
              </div>
            ) : (
              <textarea rows={12} className="tpl-code" value={form.content}
                required onChange={(e) => set('content', e.target.value)}
                placeholder={'<p>Hi {{LEAD_NAME}},</p>\n<p>…</p>\n<p>{{AGENT_NAME}}</p>'} />
            )}
            {err('content')}
          </div>

          <div className="field">
            <label>Available tokens</label>
            <div className="tpl-tokens">
              {(options?.fillable_tokens ?? []).map((t) => (
                <button key={t} type="button" className="tpl-token-btn"
                  title={mode === 'design' ? 'Copy — paste into a block' : 'Insert at the end of the body'}
                  onClick={() => {
                    if (mode === 'html') set('content', `${form.content}{{${t}}}`);
                    else if (navigator.clipboard) void navigator.clipboard.writeText(`{{${t}}}`).then(() => toast(`Copied {{${t}}}`, 'ok')).catch(() => {});
                  }}>
                  {`{{${t}}}`}
                </button>
              ))}
            </div>
            <span className="help">
              {mode === 'design'
                ? 'Type tokens like {{LEAD_NAME}} straight into any block, or click one above to copy it.'
                : 'Property tokens are filled from each lead’s own details and come out blank when that lead has none.'}
            </span>
          </div>

          {unfillable.length > 0 && (
            <div className="tpl-warn">
              ⚠ {unfillable.map((t) => `{{${t}}}`).join(', ')} cannot be filled automatically and will be
              removed from the sent email.
            </div>
          )}

          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn primary" type="submit" disabled={saving || loading}>
              {saving ? 'Saving…' : template ? 'Update Template' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
