import { useCallback, useEffect, useState } from 'react';
import { getLeadBooks, transferLeadBook, type LeadBook } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import Icon from '../ui/Icon';

/**
 * Moving a book of leads when somebody leaves.
 *
 * Leads are confidential to the person who owns them, which means a departing agent's book is
 * invisible to everybody — including whoever has to deal with it — and there is no lead screen that
 * can reassign it, because the control would sit on a record nobody can open.
 *
 * So the transfer is keyed on the PERSON, not on leads. Nobody opens, names or reads a lead to move
 * a book; the screen shows how many each person holds and nothing whatsoever about who they are.
 *
 * The confirmation says what it is doing in plain words, and says that it is recorded. That is not
 * decoration: this is the one route by which somebody can reach leads that are not theirs, and the
 * design does not pretend otherwise — it makes the route impossible to take quietly.
 */
export default function LeadBooksPanel() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();
  const [books, setBooks] = useState<LeadBook[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try { setBooks(await getLeadBooks()); } catch { setBooks([]); }
  }, []);

  useEffect(() => { if (isSuperAdmin) void load(); }, [isSuperAdmin, load]);

  // Not an error, and not worth explaining to somebody who will never use it.
  if (!isSuperAdmin) return null;

  const holder = (id: string) => (books ?? []).find((b) => String(b.user_id) === id);
  const source = holder(from);
  const target = holder(to);
  const ready = !!source && !!target && from !== to && (source.leads > 0);

  async function run() {
    if (!source || !target) return;
    setBusy(true);
    try {
      const r = await transferLeadBook(source.user_id, target.user_id);
      toast(`${r.moved} lead${r.moved === 1 ? '' : 's'} moved from ${r.from} to ${r.to}.`, 'ok');
      setConfirming(false);
      setFrom(''); setTo('');
      await load();
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast(msg || 'Could not move this book.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 style={{ margin: 0 }}>Lead books</h3>
          <p className="help" style={{ margin: '3px 0 0' }}>
            Leads belong to the person who owns them and nobody else can open them — so when someone
            leaves, their book has to be moved here. This screen shows how many leads each person
            holds and nothing about who those leads are.
          </p>
        </div>
      </div>

      {books === null ? (
        <div><div className="sk sk-line lg" /><div className="sk sk-line md" /></div>
      ) : (
        <>
          <div className="books-grid">
            {books.map((b) => (
              <div className={`book-row ${b.leads === 0 ? 'empty' : ''}`} key={b.user_id}>
                <span className="book-name">{b.name}</span>
                <span className="pill neutral">{b.role}</span>
                <strong className="book-count">{b.leads}</strong>
              </div>
            ))}
          </div>

          <div className="books-transfer">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Move the book of</span>
              <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy}>
                <option value="">Choose a person…</option>
                {books.filter((b) => b.leads > 0).map((b) => (
                  <option key={b.user_id} value={b.user_id}>{b.name} — {b.leads} lead{b.leads === 1 ? '' : 's'}</option>
                ))}
              </select>
            </label>
            <Icon name="chevronRight" size={16} />
            <label className="field" style={{ marginBottom: 0 }}>
              <span>to</span>
              <select value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}>
                <option value="">Choose a person…</option>
                {books.filter((b) => String(b.user_id) !== from).map((b) => (
                  <option key={b.user_id} value={b.user_id}>{b.name}</option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!ready || busy} onClick={() => setConfirming(true)}>
              Move book
            </button>
          </div>
        </>
      )}

      {confirming && source && target && (
        <div className="overlay open" onClick={() => !busy && setConfirming(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              Move {source.name}&rsquo;s book?
              <button className="close" onClick={() => setConfirming(false)} disabled={busy}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="modal-b">
              <p style={{ margin: '0 0 10px' }}>
                All <strong>{source.leads}</strong> of {source.name}&rsquo;s leads become{' '}
                <strong>{target.name}&rsquo;s</strong>. {source.name} will no longer be able to open any of them,
                and {target.name} will.
              </p>
              <p className="help" style={{ margin: 0 }}>
                This is the only way to reach leads that are not your own, so it is written to the audit
                trail with both names and the number moved.
              </p>
            </div>
            <div className="modal-f">
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={() => void run()} disabled={busy}>
                {busy ? 'Moving…' : `Move ${source.leads} lead${source.leads === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
