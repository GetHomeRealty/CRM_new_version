import { useState } from 'react';
import {
  saveMailboxDraft, sendMailboxMessage, deleteMailboxDraft, downloadMailboxAttachment,
  type ComposeBody, type MailboxAttachment,
} from '../lib/accountApi';
import type { Area } from './area';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * The compose window — new messages, replies, reply-alls and forwards.
 *
 * ONE COMPONENT FOR ALL FOUR, because they differ only in what they open with. The recipients, the
 * subject prefix and the quoted body of a reply are built ON THE SERVER (`getComposePrefill`) and
 * arrive here as ordinary field values: working out who a reply-all goes to means reading the
 * original message, and the original must be confirmed to belong to this user before any of its
 * addresses are handed back. Doing it in the browser would mean shipping those addresses first.
 *
 * SAVE AND SEND ARE THE SAME ROW. A draft is persisted before it is sent, so a refused send leaves
 * something to reopen and fix rather than a lost message — and the send only marks it sent once the
 * mail server has accepted it.
 */

export interface ComposerInitial {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body_html?: string;
  in_reply_to_id?: number | null;
  /** Editing an existing draft rather than starting a new one. */
  draft_id?: number;
  /** Attachments already stored on the draft, or carried by a forward. */
  attachments?: MailboxAttachment[];
}

interface Props {
  area: Area;
  initial: ComposerInitial;
  onClose: () => void;
  /** Called after a successful send or save, so the folder list can refresh. */
  onDone: () => void;
}

/** New files picked in this session, held as base64 until the draft is saved. */
interface PickedFile { filename: string; mime: string; data: string; size: number }

const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`${file.name} could not be read.`));
    r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^;]*;base64,/, ''));
    r.readAsDataURL(file);
  });

export default function MailComposer({ area, initial, onClose, onDone }: Props) {
  const toast = useToast();
  const [to, setTo] = useState(initial.to ?? '');
  const [cc, setCc] = useState(initial.cc ?? '');
  const [bcc, setBcc] = useState(initial.bcc ?? '');
  const [showCopies, setShowCopies] = useState(!!(initial.cc || initial.bcc));
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body_html ?? '');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [existing, setExisting] = useState<MailboxAttachment[]>(initial.attachments ?? []);
  const [draftId, setDraftId] = useState<number | undefined>(initial.draft_id);
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);

  /*
   * Every save replaces the attachment set, so what is sent is what is on screen.
   *
   * `existing` are files already stored on this draft; they are only re-sent when the user has not
   * removed them. Anything removed here is genuinely gone from the draft on the next save, which is
   * what "remove" has to mean.
   */
  const attachmentsPayload = (): ComposeBody['attachments'] | undefined => {
    if (picked.length === 0 && existing.length === (initial.attachments?.length ?? 0)) return undefined;
    return picked.map((p) => ({ filename: p.filename, mime: p.mime, data: p.data }));
  };

  const payload = (): ComposeBody => ({
    to, cc, bcc, subject,
    body_html: body,
    in_reply_to_id: initial.in_reply_to_id ?? null,
    attachments: attachmentsPayload(),
  });

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const next: PickedFile[] = [];
      for (const f of Array.from(files)) {
        next.push({ filename: f.name, mime: f.type || 'application/octet-stream', data: await readAsBase64(f), size: f.size });
      }
      setPicked((p) => [...p, ...next]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That file could not be read', 'bad');
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const saved = await saveMailboxDraft(area, payload(), draftId);
      setDraftId(saved.id);
      setExisting(saved.attachments);
      setPicked([]);
      toast('Draft saved', 'ok');
      onDone();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the draft'), 'bad');
    } finally { setBusy(null); }
  };

  const send = async () => {
    setBusy('send');
    try {
      await sendMailboxMessage(area, payload(), draftId);
      toast('Message sent', 'ok');
      onDone();
      onClose();
    } catch (e) {
      // The server keeps the content as a failed draft and says why; nothing is lost.
      toast(apiErrorMessage(e, 'The message was not sent'), 'bad');
    } finally { setBusy(null); }
  };

  const discard = async () => {
    if (draftId) {
      try { await deleteMailboxDraft(area, draftId); } catch { /* already gone */ }
      onDone();
    }
    onClose();
  };

  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '94vw', maxWidth: 760, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>{initial.in_reply_to_id ? 'Reply' : draftId ? 'Draft' : 'New message'}</strong>
          <button className="close" style={{ position: 'static' }} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ display: 'grid', gap: 10, overflowY: 'auto', flex: 1 }}>
          <label className="field">
            <span className="lbl">To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, second@example.com" />
          </label>

          {!showCopies && (
            <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setShowCopies(true)}>
              Add CC / BCC
            </button>
          )}
          {showCopies && (
            <>
              <label className="field"><span className="lbl">CC</span>
                <input value={cc} onChange={(e) => setCc(e.target.value)} />
              </label>
              <label className="field"><span className="lbl">BCC</span>
                <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
              </label>
            </>
          )}

          <label className="field">
            <span className="lbl">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>

          <label className="field">
            <span className="lbl">Message</span>
            <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

          <div>
            <label className="btn ghost sm" style={{ display: 'inline-block' }}>
              Attach files
              <input type="file" multiple style={{ display: 'none' }} onChange={(e) => void addFiles(e.target.files)} />
            </label>
            {(existing.length > 0 || picked.length > 0) && (
              <ul style={{ marginTop: 8, listStyle: 'none', padding: 0, display: 'grid', gap: 4 }}>
                {existing.map((a) => (
                  <li key={`e${a.id}`}>
                    <button className="btn ghost sm" onClick={() => void downloadMailboxAttachment(area, 'draft', a.id, a.filename)}>
                      {a.filename}
                    </button>
                    <span className="help"> {kb(a.size_bytes)}</span>
                    <button className="icon-btn" aria-label={`Remove ${a.filename}`}
                      onClick={() => setExisting((x) => x.filter((f) => f.id !== a.id))}>✕</button>
                  </li>
                ))}
                {picked.map((a, i) => (
                  <li key={`p${i}`}>
                    {a.filename} <span className="help">{kb(a.size)}</span>
                    <button className="icon-btn" aria-label={`Remove ${a.filename}`}
                      onClick={() => setPicked((x) => x.filter((_, j) => j !== i))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <button className="btn ghost sm" onClick={discard}>Discard</button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn sm" disabled={busy !== null} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          <button className="btn primary sm" disabled={busy !== null} onClick={send}>
            {busy === 'send' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
