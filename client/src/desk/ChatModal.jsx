import { useEffect, useRef, useState } from 'react';
import { getTransactionMessages, postTransactionMessage } from '../lib/api';
import { useToast } from './toast';

export default function ChatModal({ open, onClose, transactionId }) {
  const toast = useToast();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    getTransactionMessages(transactionId).then(setMsgs).catch(() => {});
  }, [open, transactionId]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [msgs]);

  if (!open) return null;

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const updated = await postTransactionMessage(transactionId, text.trim());
      setMsgs(updated); setText('');
    } catch { toast('Could not send', 'bad'); } finally { setSending(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 560 }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">💬 Transaction Chat</div>
        <div ref={logRef} style={{ height: 300, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 10, background: '#fafafa', marginBottom: 10, fontSize: 13 }}>
          {msgs.length === 0 && <div className="help" style={{ margin: 0 }}>No messages yet. Start the conversation.</div>}
          {msgs.map((m) => (
            <div key={m.id} style={{ marginBottom: 8, textAlign: m.mine ? 'right' : 'left' }}>
              <div style={{ display: 'inline-block', background: m.mine ? 'var(--brand)' : '#fff', color: m.mine ? '#fff' : 'var(--text)', border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px', maxWidth: '80%' }}>
                <div style={{ fontSize: 10, opacity: 0.8, marginBottom: 2 }}>{m.author} · {m.at}</div>
                {m.body}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="Type message…" style={{ flex: 1 }} />
          <button className="btn primary" onClick={send} disabled={sending}>Send</button>
        </div>
      </div>
    </div>
  );
}
