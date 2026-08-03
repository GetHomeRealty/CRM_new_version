import { useCallback, useEffect, useState } from 'react';
import { getLeadBooks, transferLeadBook, type LeadBookPool } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import Icon from '../ui/Icon';

/**
 * The brokerage's own unassigned leads, and handing them to somebody.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. This screen used to list every person in the brokerage beside
 * a count of the leads they held, and let an administrator move one person's whole book to another.
 * Both were ruled out on 2026-08-02: an agent's leads — owned or assigned — are not available here,
 * and how many any named agent holds is a report on their book that this screen is not for.
 *
 * So there is no "from". Eligible leads have no holder at all, which is what makes them the
 * brokerage's to hand out: unattributed intake, and the brokerage leads a departing agent's account
 * returns to the pool when it is deactivated. Their personal Meta leads never appear here.
 *
 * The confirmation says what it is doing in plain words, and says that it is recorded — this reaches
 * leads nobody personally holds, but it is still an administrator moving work about, and the design
 * does not make that quiet.
 */
export default function LeadBooksPanel() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();
  const [pool, setPool] = useState<LeadBookPool | null>(null);
  const [to, setTo] = useState('');
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try { setPool(await getLeadBooks()); } catch { setPool({ available: 0, recipients: [] }); }
  }, []);

  useEffect(() => { if (isSuperAdmin) void load(); }, [isSuperAdmin, load]);

  // Not an error, and not worth explaining to somebody who will never use it.
  if (!isSuperAdmin) return null;

  const target = (pool?.recipients ?? []).find((r) => String(r.user_id) === to);
  const available = pool?.available ?? 0;
  // Blank means all of them. A number above what is there is treated as all of them too, rather
  // than refused — asking for fifty when forty exist plainly means "give me what you have".
  const wanted = Math.min(Number(count) > 0 ? Math.floor(Number(count)) : available, available);
  const ready = !!target && available > 0 && wanted > 0;

  async function run() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await transferLeadBook(target.user_id, Number(count) > 0 ? Math.floor(Number(count)) : undefined);
      toast(`${r.moved} brokerage lead${r.moved === 1 ? '' : 's'} handed to ${r.to}. ${r.remaining} left in the pool.`, 'ok');
      setConfirming(false);
      setTo(''); setCount('');
      await load();
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast(msg || 'Could not hand these leads over.', 'bad');
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
            The brokerage&rsquo;s own leads that nobody is working yet — walk-ins, unattributed
            enquiries, and the leads returned to the brokerage when an agent&rsquo;s account is
            deactivated. Hand them to whoever picks the work up.
            {' '}Leads that belong to an agent are <strong>not shown here and cannot be moved</strong>,
            and neither is anything about how many leads any agent holds.
          </p>
        </div>
      </div>

      {pool === null ? (
        <div><div className="sk sk-line lg" /><div className="sk sk-line md" /></div>
      ) : (
        <>
          <div className="books-grid">
            <div className={`book-row ${available === 0 ? 'empty' : ''}`}>
              <span className="book-name">Unassigned brokerage leads</span>
              <strong className="book-count">{available}</strong>
            </div>
          </div>

          {available === 0 ? (
            <p className="help" style={{ marginTop: 8 }}>
              Nothing waiting. Leads appear here when they arrive without an owner, or when an
              agent&rsquo;s account is deactivated and their brokerage leads return to the pool.
            </p>
          ) : (
            <div className="books-transfer">
              <label className="field" style={{ marginBottom: 0 }}>
                <span>How many</span>
                <input type="number" min={1} max={available} value={count} disabled={busy}
                  placeholder={`All ${available}`} onChange={(e) => setCount(e.target.value)} />
              </label>
              <Icon name="chevronRight" size={16} />
              <label className="field" style={{ marginBottom: 0 }}>
                <span>to</span>
                <select value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}>
                  <option value="">Choose a person…</option>
                  {(pool.recipients ?? []).map((r) => (
                    <option key={r.user_id} value={r.user_id}>{r.name}</option>
                  ))}
                </select>
              </label>
              <button className="btn primary" disabled={!ready || busy} onClick={() => setConfirming(true)}>
                Hand over
              </button>
            </div>
          )}
        </>
      )}

      {confirming && target && (
        <div className="overlay open" onClick={() => !busy && setConfirming(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              Hand leads to {target.name}?
              <button className="close" onClick={() => setConfirming(false)} disabled={busy}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="modal-b">
              <p style={{ margin: '0 0 10px' }}>
                <strong>{wanted}</strong> unassigned brokerage lead{wanted === 1 ? '' : 's'} become{' '}
                <strong>{target.name}&rsquo;s</strong> to work. Oldest first, so the
                longest-waiting enquiry goes over first.
              </p>
              <p className="help" style={{ margin: 0 }}>
                Only leads nobody holds are eligible — no agent loses anything. Recorded in the audit
                trail with the name and the number moved.
              </p>
            </div>
            <div className="modal-f">
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={() => void run()} disabled={busy}>
                {busy ? 'Handing over…' : `Hand over ${wanted} lead${wanted === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
