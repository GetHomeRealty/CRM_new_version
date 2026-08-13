import { useEffect, useRef, useState } from 'react';
import { getMentionCandidates, getTransactionMessages, postTransactionMessage } from '../lib/api';
import { useToast } from './toast';
import type { ChatMessage } from '../types';

interface ChatModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
}

interface Candidate { id: number; name: string }

/**
 * The deal's chat, with mentions.
 *
 * WHY THE CLIENT RESOLVES THE PERSON RATHER THAN SENDING THE TYPED TEXT. "@John" is ambiguous the
 * moment a brokerage employs two Johns, and guessing wrong does not fail loudly — it tells the wrong
 * person about a deal. So `@` opens a list of people who can actually open THIS transaction, picking
 * one records their id, and the id is what is sent.
 *
 * That is a usability measure, not a security one. The server re-checks every id against who may
 * open the deal, because anything a client sends is something a caller can forge — see
 * `MentionService`. Nothing here is trusted.
 */
export default function ChatModal({ open, onClose, transactionId }: ChatModalProps) {
  const toast = useToast();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** People picked so far, by the exact text inserted for them. */
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [query, setQuery] = useState<string | null>(null);   // null = the menu is closed
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!open) return;
    getTransactionMessages(transactionId).then(setMsgs).catch(() => {});
  }, [open, transactionId]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [msgs]);

  // Look people up as the fragment after `@` changes. Server-side search, so the list is always
  // scoped to this deal rather than filtered from something the browser already holds.
  useEffect(() => {
    if (query === null) { setCandidates([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      getMentionCandidates(transactionId, query)
        .then((list) => { if (live) { setCandidates(list); setHighlight(0); } })
        .catch(() => { if (live) setCandidates([]); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [query, transactionId]);

  if (!open) return null;

  /** The `@fragment` immediately before the caret, or null when there is not one. */
  const fragmentAt = (value: string, caret: number): string | null => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    // Must start a word, and must not have run past one — "a@b" is an address, not a mention.
    if (at > 0 && !/\s/.test(upto[at - 1])) return null;
    const fragment = upto.slice(at + 1);
    return /\s/.test(fragment) ? null : fragment;
  };

  const onType = (value: string, caret: number) => {
    setText(value);
    setQuery(fragmentAt(value, caret));
  };

  const choose = (person: Candidate) => {
    const caret = inputRef.current?.selectionStart ?? text.length;
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return;

    // The visible text stays human — "@John Smith" — while the id travels separately.
    const inserted = `@${person.name} `;
    const next = text.slice(0, at) + inserted + text.slice(caret);
    setText(next);
    setPicked((p) => (p.some((x) => x.id === person.id) ? p : [...p, person]));
    setQuery(null);
    // Put the caret after what was just inserted, so typing carries on naturally.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const pos = at + inserted.length;
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (query !== null && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(candidates[highlight]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === 'Enter') void send();
  };

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      /*
       * Only the people still named in the text. Picking somebody and then deleting their name must
       * not notify them — the message would not mention them, and being told you were is worse than
       * not being told at all.
       */
      const stillNamed = picked.filter((p) => text.includes(`@${p.name}`));
      const updated = await postTransactionMessage(transactionId, text.trim(), stillNamed.map((p) => p.id));
      setMsgs(updated);
      setText('');
      setPicked([]);
      setQuery(null);
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

        <div style={{ position: 'relative', display: 'flex', gap: 6 }}>
          {query !== null && candidates.length > 0 && (
            <ul
              role="listbox"
              aria-label="People you can mention"
              style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 5,
                listStyle: 'none', padding: 4, margin: 0, minWidth: 220, maxHeight: 180, overflowY: 'auto',
                background: '#fff', border: '1px solid var(--line)', borderRadius: 8,
                boxShadow: '0 6px 20px rgba(0,0,0,.12)',
              }}
            >
              {candidates.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseDown={(e) => { e.preventDefault(); choose(c); }}
                    onMouseEnter={() => setHighlight(i)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                      border: 0, borderRadius: 6, cursor: 'pointer',
                      background: i === highlight ? 'var(--brand)' : 'transparent',
                      color: i === highlight ? '#fff' : 'inherit',
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            ref={inputRef}
            value={text}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setQuery(null), 120)}
            placeholder="Type message… use @ to mention someone"
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={send} disabled={sending}>Send</button>
        </div>
      </div>
    </div>
  );
}
