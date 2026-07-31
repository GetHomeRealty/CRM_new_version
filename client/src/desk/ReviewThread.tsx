import { useEffect, useRef, useState } from 'react';
import { downloadReviewAttachment, listReviewMessages, postReviewMessage, type ReviewMessage } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import Icon from '../ui/Icon';

/**
 * The conversation about one review item.
 *
 * Separate from the deal's own chat on purpose: that thread is where the team talks about the deal,
 * and it cannot answer "which of these four rejections are you replying to?" — which is the only
 * question that matters when an agent is working through a list. A decision still announces itself
 * in the deal chat; the argument about it happens here, against the item it belongs to.
 *
 * Append-only. Nothing here can be edited or deleted, by anyone — a thread somebody can tidy
 * afterwards is not a record of what was said.
 */

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '');
const size = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export default function ReviewThread({ reviewId }: { reviewId: number }) {
  const toast = useToast();
  const { user } = useAuth();
  const [messages, setMessages] = useState<ReviewMessage[] | null>(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<{ filename: string; content_type: string; data: string; size: number }[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listReviewMessages(reviewId)
      .then(setMessages)
      .catch((e) => { setMessages([]); toast(apiErrorMessage(e, 'Could not load the discussion'), 'bad'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

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
    if (!body.trim() && files.length === 0) return;
    setSending(true);
    try {
      setMessages(await postReviewMessage(reviewId, body, files.map(({ filename, content_type, data }) => ({ filename, content_type, data }))));
      setBody('');
      setFiles([]);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not post that'), 'bad');
    } finally {
      setSending(false);
    }
  };

  if (messages === null) return <div className="help" style={{ marginTop: 6 }}>Loading discussion…</div>;

  return (
    <div className="rev-thread">
      {messages.length === 0
        ? <div className="help">No discussion yet. A reply here is attached to this item, not to the deal’s chat.</div>
        : messages.map((m) => (
          <div key={m.id} className={`rev-msg${m.author === user?.name ? ' mine' : ''}`}>
            <div className="rev-msg-head">
              <strong>{m.author ?? 'Someone'}</strong>
              {m.author_role && <span className="rev-msg-role">{m.author_role}</span>}
              <span className="rev-msg-when">{stamp(m.created_at)}</span>
            </div>
            {m.body && <div className="rev-msg-body">{m.body}</div>}
            {m.attachments.length > 0 && (
              <div className="rev-msg-files">
                {m.attachments.map((a) => (
                  <button key={a.id} type="button" className="rev-msg-file"
                    title={`${a.filename} · ${size(a.size)}`}
                    onClick={() => { void downloadReviewAttachment(a.id).catch(() => toast('Could not download that file', 'bad')); }}>
                    <Icon name="doc" size={11} /> {a.filename} <span className="muted">{size(a.size)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

      <div className="rev-reply">
        <textarea rows={2} value={body} disabled={sending} placeholder="Reply, or attach a screenshot…"
          onChange={(e) => setBody(e.target.value)} />
        {files.length > 0 && (
          <div className="rev-msg-files">
            {files.map((f, i) => (
              <span key={i} className="rev-msg-file">
                <Icon name="doc" size={11} /> {f.filename} <span className="muted">{size(f.size)}</span>
                <button type="button" className="rev-file-x" disabled={sending}
                  onClick={() => setFiles((list) => list.filter((_, n) => n !== i))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="rev-reply-actions">
          <input ref={fileInput} type="file" style={{ display: 'none' }}
            onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
          <button type="button" className="btn ghost sm" disabled={sending || files.length >= 5}
            onClick={() => fileInput.current?.click()}>
            {files.length >= 5 ? 'Attachment limit' : '📎 Attach'}
          </button>
          <button type="button" className="btn primary sm" disabled={sending || (!body.trim() && files.length === 0)}
            onClick={() => void send()}>
            {sending ? 'Posting…' : 'Post reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
