import { useEffect, useRef, useState } from 'react';
import { fetchOnboardingAttachment, fetchOnboardingDocument, getOnboardingPreview, sendOnboardingEmail, type OnboardingAttachment, type OnboardingKind, type OnboardingPreview } from '../lib/api';
import RichTextEditor, { type RichTextHandle } from './RichTextEditor';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';

/**
 * Review before sending — for each of the letters a new agent receives from the Users screen.
 *
 * The buttons open the message as it will actually arrive for this agent, with the variables
 * already filled in and the template's attachments listed, and it can be edited before it goes.
 *
 * The edit applies to this send only. Adjusting a sentence for one agent must not quietly rewrite
 * what every future agent receives — Settings → Templates is where the template itself changes,
 * and that is said on screen so the distinction is not a surprise.
 */

/**
 * The heading over the review.
 *
 * `onboard` is deliberately not named "Fresher" or "Experienced" here: which of the two it is comes
 * back with the preview, and a heading guessed on this side could contradict the message under it.
 */
const KIND_LABEL: Record<OnboardingKind, string> = {
  onboard: 'Onboarding Email',
  contract: 'Contract Agreement',
  accounting: 'Accounting Onboarding Email',
  training: 'Training Onboarding Email',
};

/** Said under the heading, so which of the two onboarding guides this is can be read at a glance. */
const EVENT_LABEL: Record<string, string> = {
  'user.onboard_email': 'experienced agent',
  'user.onboard_email_fresher': 'fresher',
};

/**
 * Why a file could not be opened.
 *
 * These requests ask for a Blob, so axios hands the error body back as a Blob as well — the usual
 * reader finds no `message` on it and every failure reads the same. Reading the blob back as text
 * is what turns "Could not open that file" into the reason it could not be opened.
 */
async function fileErrorMessage(e: unknown): Promise<string> {
  const body = (e as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (body instanceof Blob) {
    try {
      const parsed = JSON.parse(await body.text()) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch { /* not JSON — fall through to the generic message */ }
  }
  return apiErrorMessage(e, 'Could not open that file');
}

export default function OnboardingEmailModal({ userId, kind, onClose }: {
  userId: number;
  kind: OnboardingKind;
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
  /** The attachment being read right now, shown in place below the list. */
  const [viewing, setViewing] = useState<{ name: string; url: string; type: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  // The object URL outlives React's rendering, so it is released on the way out.
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

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

  /**
   * Show an attachment in place, under the list it was clicked in — not in another browser tab, so
   * the email being reviewed stays on screen next to the document it refers to.
   *
   * One object URL is alive at a time, revoked when it is replaced, closed, or the dialog goes away.
   * Held in a ref rather than state because it has to be released on the way out, when there is no
   * longer a render to read it from.
   */
  const show = (name: string, blob: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(blob);
    setViewing({ name, url: urlRef.current, type: blob.type || '' });
  };

  const closeViewer = () => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setViewing(null);
  };

  /** A file on the template is fetched back from the API — only its name and size were listed. */
  const viewStored = async (a: { id: number; filename: string }) => {
    setOpening(`t${a.id}`);
    try {
      show(a.filename, await fetchOnboardingAttachment(kind, a.id));
    } catch (e) {
      toast(await fileErrorMessage(e), 'bad');
    } finally {
      setOpening(null);
    }
  };

  /**
   * The generated agreement, rendered from the message as it stands right now — including an edit
   * made in this dialog, since that is the copy that will be attached.
   */
  const viewDocument = async (name: string) => {
    setOpening('doc');
    try {
      show(name, await fetchOnboardingDocument(userId, kind, html));
    } catch (e) {
      toast(await fileErrorMessage(e), 'bad');
    } finally {
      setOpening(null);
    }
  };

  /** One picked here is already in the browser, so it is shown from the bytes in hand. */
  const viewPicked = (file: OnboardingAttachment & { size: number }) => {
    try {
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      show(file.filename, new Blob([bytes], { type: file.content_type || 'application/octet-stream' }));
    } catch {
      toast('Could not open that file', 'bad');
    }
  };

  return (
    <div className="overlay open stacked" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ marginBottom: 2 }}>{KIND_LABEL[kind]}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          {loading ? 'Building the preview…' : (
            <>
              To <strong>{preview?.to || '—'}</strong>
              {preview?.sender ? <> · from {preview.sender}</> : null}
              {/* Which of the two guides was chosen from the agent's record, so a letter meant for a
                  transferring agent is not sent to a fresher without it being visible first. */}
              {preview && EVENT_LABEL[preview.event_key] ? <> · {EVENT_LABEL[preview.event_key]} version</> : null}
              {/* For the contract, which of the brokerage's five agreements these terms are — read
                  from the same splits the wording below is built from. */}
              {kind === 'contract' ? (
                preview?.contract_variant
                  ? <> · <strong>{preview.contract_variant}</strong> agreement</>
                  : <> · non-standard split</>
              ) : null}
            </>
          )}
        </div>

        {loading ? <div className="centered">Loading…</div> : preview && (
          <>
            {/* Said before the button is pressed, not after. */}
            {preview.warning && (
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
              {(preview.generated_document || preview.attachments.length > 0 || files.length > 0) && (
                <ul className="tmpl-files">
                  {/* Built from the message for this agent, not stored anywhere. Listed first
                      because it is the document the email is about. */}
                  {preview.generated_document && (
                    <li key="doc">
                      <span className="tmpl-file-ico">📄</span>
                      <span>{preview.generated_document}</span>
                      <span className="tmpl-file-size">generated from this message</span>
                      <button type="button" className="btn ghost sm" disabled={opening === 'doc'}
                        onClick={() => void viewDocument(preview.generated_document!)}>
                        {opening === 'doc' ? 'Building…' : '👁 Preview'}
                      </button>
                    </li>
                  )}
                  {/* From the template — the same files go to every agent. */}
                  {preview.attachments.map((a) => (
                    <li key={`t${a.id}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{a.filename}</span>
                      <span className="tmpl-file-size">{size(a.size)} · from template</span>
                      <button type="button" className="btn ghost sm" disabled={opening === `t${a.id}`}
                        onClick={() => void viewStored(a)}>
                        {opening === `t${a.id}` ? 'Opening…' : '👁 Preview'}
                      </button>
                    </li>
                  ))}
                  {/* Picked here — this email only. */}
                  {files.map((f, i) => (
                    <li key={`a${i}`}>
                      <span className="tmpl-file-ico">📎</span>
                      <span>{f.filename}</span>
                      <span className="tmpl-file-size">{size(f.size)}</span>
                      <button type="button" className="btn ghost sm" onClick={() => viewPicked(f)}>👁 Preview</button>
                      {/* Closed with it: a preview of a file that is no longer attached is a
                          document the agent will not receive. */}
                      <button type="button" className="btn ghost sm" disabled={sending}
                        onClick={() => {
                          if (viewing?.name === f.filename) closeViewer();
                          setFiles((list) => list.filter((_, n) => n !== i));
                        }}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {/* Shown here rather than in another tab, so the message and the document it refers
                  to can be read together. */}
              {viewing && (
                <div className="onb-viewer">
                  <div className="onb-viewer-h">
                    <span className="onb-viewer-name">{viewing.name}</span>
                    <button type="button" className="btn ghost sm" onClick={closeViewer}>Close preview</button>
                  </div>
                  {viewing.type.startsWith('image/')
                    ? <img src={viewing.url} alt={viewing.name} />
                    : <iframe src={viewing.url} title={viewing.name} />}
                </div>
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
