import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Icon from '../ui/Icon';
import { listSuppressions, removeSuppression } from '../lib/campaignsApi';
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

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="modal-h" style={{ fontSize: 16 }}>Suppression List</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Addresses no campaign may reach — people who unsubscribed, and mailboxes that permanently
        rejected our mail. This list is shared across the brokerage and applies to every agent's sends.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search an email address…"
          style={{ flex: 1, minWidth: 220 }}
        />
        {search && <button className="btn ghost sm" type="button" onClick={() => onSearch('')}>Clear</button>}
        <span className="muted" style={{ fontSize: 12 }}>
          {meta ? `${meta.total} address${meta.total === 1 ? '' : 'es'}${search ? ' matching' : ' suppressed'}` : ''}
        </span>
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
        {loading ? (
          <div className="muted" style={{ padding: 18, textAlign: 'center' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="muted" style={{ padding: 18, textAlign: 'center' }}>
            {search
              ? 'No suppressed address matches that search.'
              : 'Nobody is suppressed. Addresses appear here when someone unsubscribes or their mailbox permanently rejects our mail.'}
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
                  {canEdit && <th style={{ ...th, textAlign: 'right' }}>Action</th>}
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
                      {canEdit && (
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

      {!canEdit && rows.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Removing an address needs campaign edit rights.
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
