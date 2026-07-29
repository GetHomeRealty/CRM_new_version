import { useEffect, useRef, useState } from 'react';
import { getOnboardingPreview, sendOnboardingEmail, type OnboardingAttachment, type OnboardingPreview } from '../lib/api';
import RichTextEditor, { type RichTextHandle } from './RichTextEditor';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';

/**
 * Review before sending — for the onboarding guide and the contract agreement.
 *
 * Both buttons used to raise a toast and send nothing. They now open the message as it will
 * actually arrive for this agent, with the variables already filled in and the template's
 * attachments listed, and it can be edited before it goes.
 *
 * The edit applies to this send only. Adjusting a sentence for one agent must not quietly rewrite
 * what every future agent receives — Settings → Templates is where the template itself changes,
 * and that is said on screen so the distinction is not a surprise.
 */

const KIND_LABEL: Record<string, string> = {
  onboard: 'Onboarding Email',
  contract: 'Contract Agreement',
};

export default function OnboardingEmailModal({ userId, kind, onClose }: {
  userId: number;
  kind: 'onboard' | 'contract';
  onClose: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<RichTextHandle>(null);
  /**
   * Files picked here go with this email only and are never stored on the template.
   *
   * That is the point for a contract agreement: it is filled in for one agent, so keeping it on
   * the template would attach that agent's copy to every future send.
   */
  const [files, setFiles] = useState<(OnboardingAttachment & { size: number })[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getOnboardingPreview(userId, kind)
      .then((p) => { setPreview(p); setSubject(p.subject); setHtml(p.html); })
      .catch((e) => { toast(apiErrorMessage(e, 'Could not build the preview'), 'bad'); onClose(); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, kind]);

  const pick = async (file: File | null) => {
    if (!file) return;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? '').split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Could not read that file'));
        r.readAsDataURL(file);
      });
      setFiles((f) => [...f, { filename: file.name, content_type: file.type || 'application/octet-stream', data, size: file.size }]);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not read that file'), 'bad');
    } finally {
      // Cleared so picking the same file again still fires change.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const send = async () => {
    setSending(true);
    try {
      const r = await sendOnboardingEmail(userId, kind, {
        subject,
        html,
        attachments: files.map(({ filename, content_type, data }) => ({ filename, content_type, data })),
      });
      toast(r.message, 'ok');
      onClose();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not send'), 'bad');
    } finally { setSending(false); }
  };

  const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  return (
    <div className="overlay open stacked" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ marginBottom: 2 }}>{KIND_LABEL[kind]}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          {loading ? 'Building the preview…' : <>To <strong>{preview?.to || '—'}</strong>{preview?.sender ? <> · from {preview.sender}</> : null}</>}
        </div>

        {loading ? <div className="centered">Loading…</div> : preview && (
          <>
            {/* Said before the button is pressed, not after — but "no contract attached" stops
                being true the moment one is attached here, and a warning that contradicts what is
                on screen teaches people to ignore warnings. */}
            {preview.warning && !(preview.warning_kind === 'no_attachment' && files.length > 0) && (
              <div className="import-error" style={{ marginBottom: 12 }}>{preview.warning}</div>
            )}

            <div className="field"><label>Subject</label>
              {editing
                ? <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                : <div className="onb-static">{subject}</div>}
            </div>

            <div className="field" style={{ marginBottom: 10 }}>
              <label>Message</label>
              {editing ? (
                <RichTextEditor ref={bodyRef} value={html} onChange={setHtml} rows={12} />
              ) : (
                // Read-only rendering of exactly what will be sent.
                <div className="onb-preview" dangerouslySetInnerHTML={{ __html: html }} />
              )}
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label>Attachments</label>
              {(preview.attachments.length > 0 || files.length > 0) && (
                <ul className="tmpl-files">
                  {/* From the template — the same files go to every agent. */}
                  {preview.attachments.map((a) => (
                    <li key={`t${a.id}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{a.filename}</span>
                      <span className="tmpl-file-size">{size(a.size)} · from template</span>
                    </li>
                  ))}
                  {/* Picked here — this email only. */}
                  {files.map((f, i) => (
                    <li key={`a${i}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{f.filename}</span>
                      <span className="tmpl-file-size">{size(f.size)}</span>
                      <button type="button" className="btn ghost sm" disabled={sending}
                        onClick={() => setFiles((list) => list.filter((_, n) => n !== i))}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              <input ref={fileInput} type="file" style={{ display: 'none' }}
                onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
              <button type="button" className="btn ghost sm" disabled={sending || files.length >= 5}
                onClick={() => fileInput.current?.click()}>
                {files.length >= 5 ? 'Attachment limit reached' : '📎 Attach a file'}
              </button>
              <span className="help" style={{ display: 'block', marginTop: 4 }}>
                Files added here are sent with this email only. Files that should go to every agent
                belong on the template, in Settings → Templates.
              </span>
            </div>

            <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? '👁 Preview' : '✎ Edit'}
              </button>
              <button className="btn primary" disabled={sending || !preview.to} onClick={() => void send()}>
                {sending ? 'Sending…' : `Send to ${preview.to || '—'}`}
              </button>
            </div>
            {editing && (
              <p className="help" style={{ marginTop: 6 }}>
                Edits apply to this email only. To change it for every agent, edit the template in
                Settings → Templates.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
