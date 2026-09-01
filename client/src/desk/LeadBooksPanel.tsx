import { useCallback, useEffect, useState } from 'react';
import {
  getLeadBooks, previewLeadBookHandover, transferLeadBook,
  type LeadBookPool, type LeadBookPreview,
} from '../lib/api';
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
/**
 * How many leads the confirmation names before it summarises.
 *
 * A hand-over of four hundred cannot list four hundred names in a dialog somebody will read, and
 * a list nobody reads protects nobody. Ten is enough to recognise the front of the queue - which
 * is where the risk is, since the order is oldest first - and the audit entry carries the rest.
 */
const PREVIEW_LIMIT = 10;

export default function LeadBooksPanel() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();
  const [pool, setPool] = useState<LeadBookPool | null>(null);
  const [to, setTo] = useState('');
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /*
   * WHICH LEADS THE CONFIRMATION IS ABOUT.
   *
   * `null` while it is being fetched, so the dialog can say it is still finding out rather than
   * render an empty list that reads as "none" - the same false-zero this panel was reported for
   * elsewhere. `error` distinguishes "could not look them up" from "there are none".
   */
  const [preview, setPreview] = useState<LeadBookPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

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

  /**
   * Open the confirmation, and find out what it is about.
   *
   * THE DEFECT THIS FIXES. The dialog stated a count, a recipient and the ordering rule, and
   * never which lead. "Oldest first" is doing real work: on the brokerage that reported this the
   * pool held four leads, of which the oldest was a real client and the other three were test
   * records - so handing over "just one" moved the real client's file, permanently, and the
   * window a broker reads before confirming gave them no way to see it.
   *
   * FETCHED WHEN THE DIALOG OPENS, not on page load: the answer depends on the count that was
   * typed, and reading it early would name a set that no longer applies by the time it is read.
   */
  async function openConfirm() {
    setPreview(null);
    setPreviewFailed(false);
    setConfirming(true);
    try {
      setPreview(await previewLeadBookHandover(Number(count) > 0 ? Math.floor(Number(count)) : undefined));
    } catch {
      setPreviewFailed(true);
    }
  }

  async function run() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await transferLeadBook(target.user_id, Number(count) > 0 ? Math.floor(Number(count)) : undefined);
      toast(`${r.moved} brokerage lead${r.moved === 1 ? '' : 's'} handed to ${r.to}. ${r.remaining} left in the pool.`, 'ok');
      setConfirming(false);
      setPreview(null);
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
              <button className="btn primary" disabled={!ready || busy} onClick={() => void openConfirm()}>
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

              {/*
                THE LEADS THEMSELVES. The consequence is permanent — nothing in the application moves
                an assigned lead back to the pool — so the one fact needed to judge it should not be
                the one fact withheld. Named rather than counted, and dated, so "oldest first" is a
                claim the reader can check rather than take.
              */}
              {previewFailed ? (
                <p className="help" style={{ margin: '0 0 10px', color: 'var(--bad)' }}>
                  These leads could not be looked up just now, so this window cannot say which they
                  are. Cancel and try again rather than handing over leads you cannot see.
                </p>
              ) : preview === null ? (
                <p className="help" style={{ margin: '0 0 10px' }}>Finding out which leads these are…</p>
              ) : preview.moving.length === 0 ? (
                <p className="help" style={{ margin: '0 0 10px' }}>
                  There is nothing waiting in the pool now — it may have been handed over already.
                </p>
              ) : (
                <div className="book-preview">
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13 }}>
                    {preview.moving.slice(0, PREVIEW_LIMIT).map((l) => (
                      <li key={l.id} style={{ marginBottom: 2 }}>
                        {l.name} <span className="help">#{l.id}{l.created_at ? ` · waiting since ${l.created_at.slice(0, 10)}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                  {preview.moving.length > PREVIEW_LIMIT && (
                    <p className="help" style={{ margin: '0 0 8px' }}>
                      …and {preview.moving.length - PREVIEW_LIMIT} more. The full list is written to the
                      audit trail when you confirm.
                    </p>
                  )}
                </div>
              )}

              <p className="help" style={{ margin: 0 }}>
                Only leads nobody holds are eligible — no agent loses anything. Recorded in the audit
                trail with the name and the leads moved.
              </p>
            </div>
            <div className="modal-f">
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              {/*
                Held until the list has arrived. Confirming a permanent hand-over while the window is
                still saying "finding out which leads these are" would leave the dialog exactly as
                uninformative as it was before.
              */}
              <button className="btn primary" onClick={() => void run()}
                disabled={busy || preview === null || previewFailed || preview.moving.length === 0}>
                {busy ? 'Handing over…' : `Hand over ${wanted} lead${wanted === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
