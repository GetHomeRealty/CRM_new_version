import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Icon from '../ui/Icon';
import { addSuppression, listSuppressions, removeSuppression } from '../lib/campaignsApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from './ConfirmDialog';
import type { Suppression, SuppressionPage } from '../types';

/**
 * The suppression list, as a screen.
 *
 * `email_suppressions` was written to by every unsubscribe and read back by nothing, so the one
 * question compliance actually gets asked — "did we honour this person's opt-out?" — could only be
 * answered by querying the database. CASL puts the burden of proof on the sender, so a record
 * nobody can read is most of the problem.
 *
 * Brokerage-wide, matching the API: a suppression is the recipient's decision about the brokerage,
 * and an agent must not be able to route around a colleague's opt-out by not seeing it.
 */

const PER_PAGE = 50;

/** What put this address on the list, in words a person can act on. */
const REASONS: Record<string, { label: string; pill: string; help: string }> = {
  unsubscribe: {
    label: 'Unsubscribed',
    pill: 'warn',
    help: 'They clicked the unsubscribe link in a campaign. Removing this resumes mail to someone who asked for it to stop — only right if they have asked to be put back.',
  },
  hard_bounce: {
    label: 'Hard bounce',
    pill: 'bad',
    help: 'Mail to this address was permanently rejected — the mailbox does not exist. Removing this is only worth doing if the address has since been fixed.',
  },
};

const reasonOf = (r: string | null) => REASONS[String(r ?? '')] ?? { label: r || 'Suppressed', pill: '', help: 'This address is excluded from every campaign.' };

/** Absolute instants from the API, rendered in the reader's own timezone. */
const when = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

export default function SuppressionsPanel() {
  const toast = useToast();
  const { can } = useAuth();
  /*
   * TWO DIFFERENT QUESTIONS, and they were being answered by one.
   *
   * `campaigns:edit` decides whether this screen is usable at all. Whether somebody may UNDO an
   * opt-out is narrower - it resumes mail to a person who asked to be left alone - and the server
   * now requires the marketing capability for it. Offering Remove on the wider rule would show a
   * button that is refused, which is exactly the fault CRM-012 describes.
   *
   * `can_remove` comes from the server, per response, so the two cannot disagree.
   */
  const canEdit = can('campaigns', 'edit');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SuppressionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [toRemove, setToRemove] = useState<Suppression | null>(null);

  const load = useCallback((p: number, q: string) => {
    setLoading(true);
    listSuppressions({ page: p, limit: PER_PAGE, search: q.trim() })
      .then(setResult)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the suppression list'), 'bad'))
      .finally(() => setLoading(false));
  }, [toast]);

  // Debounced so typing an address does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load(page, search), 300);
    return () => clearTimeout(t);
  }, [page, search, load]);

  // A new search starts at the first page — page 4 of the old results says nothing about the new
  // ones, and landing on an empty page reads as "no matches" when there are plenty.
  const onSearch = (v: string) => { setSearch(v); setPage(1); };

  const remove = async () => {
    if (!toRemove) return;
    try {
      await removeSuppression(toRemove.email);
      toast(`${toRemove.email} removed — mail to this address will resume.`, 'ok');
      // Removing the last row of a page would otherwise leave an empty list with a pager
      // pointing past the end.
      const emptied = (result?.data.length ?? 0) === 1 && page > 1;
      if (emptied) setPage((p) => p - 1); else load(page, search);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not remove the suppression'), 'bad');
    }
  };

  const rows = result?.data ?? [];
  const meta = result?.meta;
  // Undefined on an older response: keep the control rather than silently removing it.
  const canRemove = canEdit && meta?.can_remove !== false;
  /*
   * Whether this is a slice or the whole list, answered by the server — see `scoped` in
   * `listSuppressions`. Defaults to false so an older response renders the brokerage-wide
   * wording rather than accusing a complete list of being partial.
   */
  const scoped = meta?.scoped === true;

  /*
   * RECORDING AN OPT-OUT IS THE EASY DIRECTION, and stays on `campaigns:edit`.
   *
   * Reversing one needs the marketing capability (CRM-027) because it resumes mail to somebody who
   * asked for silence. Honouring the request must never be the harder of the two: the agent who
   * took the telephone call is exactly who should be able to act on it, and making them find an
   * administrator first means the brokerage keeps mailing in the meantime.
   */
  const [newAddress, setNewAddress] = useState('');
  const [newReason, setNewReason] = useState('');
  const [adding, setAdding] = useState(false);
  /*
   * THE CONFIRMATION HAS TO OUTLIVE THE TOAST.
   *
   * An agent's view of this list is scoped to the addresses of their OWN leads, so recording an
   * opt-out for anybody else - somebody who telephoned, a colleague's client, an address on no lead
   * at all - correctly produces no visible row. A toast saying it worked disappears in seconds; the
   * empty list stays on screen. Whoever did it is left looking at what appears to be a failure.
   *
   * So the acknowledgement persists until dismissed, and when the address genuinely is not in the
   * visible list it says why rather than leaving somebody to conclude nothing happened.
   */
  const [recorded, setRecorded] = useState<{ email: string; already: boolean } | null>(null);

  const record = async () => {
    const email = newAddress.trim();
    if (!email) return;
    setAdding(true);
    try {
      const res = await addSuppression(email, newReason.trim());
      // Named in both places: the toast for the moment, the panel below for afterwards.
      toast(`Opt-out recorded for ${email}.`, 'ok');
      setRecorded({ email: email.toLowerCase(), already: res.already });
      setNewAddress('');
      setNewReason('');
      void load(1, search);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not record that opt-out'), 'bad');
    } finally { setAdding(false); }
  };

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="modal-h" style={{ fontSize: 16 }}>Suppression List</div>
      {/*
        CRM-045: SEPARATES WHAT THE LIST DOES FROM WHAT THIS READER CAN SEE.

        The old sentence — "This list is shared across the brokerage and applies to every agent's
        sends" — is true about ENFORCEMENT and was read as a promise about VISIBILITY. An agent
        read it directly above '0 addresses suppressed' at a moment when the brokerage had a
        suppressed address. Both halves are now said separately, because they are different
        facts and only one of them depends on who is looking.
      */}
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Addresses no campaign may reach — people who unsubscribed, and mailboxes that permanently
        rejected our mail. Suppression applies to every agent&rsquo;s sends across the brokerage,
        whoever is sending.
        {scoped && (
          <>
            {' '}
            <strong>You are seeing the opt-outs among your own leads.</strong> The brokerage-wide
            list holds other agents&rsquo; clients&rsquo; addresses and is not shown to your role —
            it is still enforced on everything you send.
          </>
        )}
      </div>

      {canEdit && (
        <div className="reminder-ok" style={{ marginBottom: 12, padding: '10px 12px' }}>
          <strong style={{ fontSize: 13 }}>Somebody asked to stop receiving email?</strong>
          <div className="help" style={{ margin: '2px 0 8px' }}>
            Record it here whether they said so by telephone, in person, or in a reply — they do not
            have to click an unsubscribe link for it to count.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={newAddress} type="email" style={{ flex: '1 1 220px', minWidth: 200 }}
              placeholder="their email address" aria-label="Email address that asked to stop"
              onChange={(e) => setNewAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void record(); } }}
            />
            <input
              value={newReason} style={{ flex: '1 1 200px', minWidth: 180 }}
              placeholder="how they told us (optional)" aria-label="How the request was received"
              onChange={(e) => setNewReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void record(); } }}
            />
            <button
              className="btn primary sm" type="button"
              disabled={adding || !newAddress.trim()} onClick={() => void record()}
            >
              {adding ? 'Recording…' : 'Record opt-out'}
            </button>
          </div>
        </div>
      )}

      {recorded && (
        <div className="reminder-ok" style={{ marginBottom: 12, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <strong style={{ fontSize: 13 }}>Opt-out recorded for {recorded.email}.</strong>
              <div className="help" style={{ marginTop: 2 }}>
                {recorded.already
                  ? 'They were already on the list, so nothing changed — they will not be emailed.'
                  : 'No campaign or automated email will go to this address again.'}
              </div>
              {/*
                THE PART THAT ANSWERS "so why can I not see it?".
                Only shown when it really is absent from what this person can see, so it never
                explains away a row that is sitting right there.
              */}
              {!rows.some((r) => r.email.trim().toLowerCase() === recorded.email) && (
                <div className="help" style={{ marginTop: 6 }}>
                  {canRemove
                    ? 'It is not in the list below because of the search or page you are on — clear the search to find it.'
                    : 'It is not shown below because this list shows opt-outs for your own leads, and '
                      + 'this address is not on one. It is still recorded, and still enforced everywhere.'}
                </div>
              )}
            </div>
            <button className="btn ghost sm" type="button" onClick={() => setRecorded(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search an email address…"
          style={{ flex: 1, minWidth: 220 }}
        />
        {search && <button className="btn ghost sm" type="button" onClick={() => onSearch('')}>Clear</button>}
        <span className="muted" style={{ fontSize: 12 }}>
          {meta
            ? `${meta.total} address${meta.total === 1 ? '' : 'es'}${search ? ' matching' : ' suppressed'}`
              + (scoped && !search ? ' among your leads' : '')
            : ''}
        </span>
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
        {loading ? (
          <div className="muted" style={{ padding: 18, textAlign: 'center' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="muted" style={{ padding: 18, textAlign: 'center' }}>
            {/*
              AN ABSENCE, NOT A CLAIM ABOUT THE BROKERAGE. 'Nobody is suppressed' was displayed to
              an agent while the brokerage did have a suppressed address — the screen did not
              withhold the answer, it gave the wrong one.
            */}
            {search
              ? (scoped
                ? 'No suppressed address among your leads matches that search. Addresses belonging '
                  + 'to other agents\u2019 clients are not shown here.'
                : 'No suppressed address matches that search.')
              : (scoped
                ? 'None of your leads has opted out. This is not the whole brokerage list — other '
                  + 'agents\u2019 clients may have opted out, and those addresses are still blocked '
                  + 'on anything you send.'
                : 'Nobody is suppressed. Addresses appear here when someone unsubscribes, when a mailbox '
                  + 'permanently rejects our mail, or when somebody records a request above.')}
          </div>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--surface-2)' }}>
                <tr>
                  <th style={th}>Email address</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Suppressed</th>
                  <th style={th}>From campaign</th>
                  {canRemove && <th style={{ ...th, textAlign: 'right' }}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const r = reasonOf(s.reason);
                  return (
                    <tr key={s.id}>
                      <td style={{ ...cell, fontWeight: 600, wordBreak: 'break-all' }}>{s.email}</td>
                      <td style={cell}><span className={`pill ${r.pill}`} title={r.help}>{r.label}</span></td>
                      <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--muted)' }}>{when(s.created_at)}</td>
                      <td style={{ ...cell, color: 'var(--muted)' }}>{s.campaign_id ? `#${s.campaign_id}` : '—'}</td>
                      {canRemove && (
                        <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            className="btn ghost sm"
                            type="button"
                            onClick={() => setToRemove(s)}
                            title="Resume mail to this address"
                          >
                            <Icon name="undo" size={13} /> Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {meta && meta.last_page > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span className="muted" style={{ fontSize: 12 }}>Page {meta.page} of {meta.last_page}</span>
          <button className="btn ghost sm" disabled={page >= meta.last_page} onClick={() => setPage((p) => Math.min(meta.last_page, p + 1))}>Next →</button>
        </div>
      )}

      {!canRemove && rows.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {canEdit
            // Says WHY, and who to ask. "You lack a permission" is not an actionable sentence.
            ? 'Taking an address off this list resumes mail to somebody who asked it to stop, so it '
              + 'is limited to marketing and administrative roles. Ask an administrator.'
            : 'Removing an address needs campaign edit rights.'}
        </div>
      )}

      {/*
        Confirmed rather than immediate, and worded as what it actually does. This is the one
        action on the screen that undoes somebody's opt-out, and the server logs who did it.
      */}
      <ConfirmDialog
        confirm={toRemove ? {
          title: 'Resume mail to this address?',
          message: `${toRemove.email} was suppressed${toRemove.reason === 'hard_bounce'
            ? ' because mail to it was permanently rejected. Removing it means campaigns will try this address again — worth doing only if the mailbox has since been fixed.'
            : ' because they unsubscribed. Removing it means campaigns can email them again — only do this if they have asked to be put back on the list.'}`,
          onConfirm: remove,
        } : null}
        onClose={() => setToRemove(null)}
      />
    </div>
  );
}

const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--surface-3)', fontSize: 12, verticalAlign: 'top' };
const th: CSSProperties = { ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)', whiteSpace: 'nowrap', textAlign: 'left' };
