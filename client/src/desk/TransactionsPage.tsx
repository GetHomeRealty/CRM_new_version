import { deskPath } from './area';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactionsPage, deleteTransaction, requestTransactionDeletion, type TransactionQuery } from '../lib/api';
import { formatPrice, typeClass, typeLabel, TRANSACTION_TYPES } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import Icon from '../ui/Icon';
import { exportCompleteXlsx, ALL_TRANSACTIONS } from '../lib/bulkApi';
import { queueExport } from '../lib/exportCentreApi';
import AddTransactionModal from './AddTransactionModal';
import ChatModal from './ChatModal';
import BulkExportModal from './BulkExportModal';
import type { Transaction } from '../types';

interface Filters {
  q: string;
  /** Closing-date year, or '' for all — matches the Dashboard's "Year (by closing date)". */
  year: string;
  type: string;
  validation: string;
  agent: string;
  commission: string;
  status: string;
  offerFrom: string;
  offerTo: string;
  closingFrom: string;
  closingTo: string;
  payout: string;
  client: string;
  brokerage: string;
}

const PER_PAGE = 25;
/** Typing shouldn't fire a request per keystroke; selects and dates apply immediately. */
const TYPING_DEBOUNCE_MS = 350;
const TYPED_KEYS: (keyof Filters)[] = ['q', 'agent', 'client', 'brokerage'];

/** UI filter names → the query string the API expects. */
const toQuery = (f: Filters): TransactionQuery => ({
  q: f.q, year: f.year, type: f.type, validation: f.validation, agent: f.agent,
  commission: f.commission, status: f.status, payout: f.payout, client: f.client, brokerage: f.brokerage,
  offer_from: f.offerFrom, offer_to: f.offerTo, closing_from: f.closingFrom, closing_to: f.closingTo,
});

const EMPTY_FILTERS: Filters = {
  q: '', year: '', type: '', validation: '', agent: '', commission: '', status: '',
  // Advanced ribbon filters
  offerFrom: '', offerTo: '', closingFrom: '', closingTo: '', payout: '', client: '', brokerage: '',
};
const RIBBON_KEYS: (keyof Filters)[] = ['offerFrom', 'offerTo', 'closingFrom', 'closingTo', 'payout', 'client', 'brokerage'];

export default function TransactionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can, user, isAdminOrAbove } = useAuth();
  const canEdit = can('transactions', 'edit');
  const isAgent = user?.role === 'agent';
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  // Whole-result-set facts the server reports alongside the page: the ids behind "select all",
  // the year options, the deletion-request banner, and the total. None can be derived from the
  // rows on screen once the list is paged.
  const [page, setPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [matchingIds, setMatchingIds] = useState<number[]>([]);
  const [years, setYears] = useState<string[]>([]);
  const [pendingDeletions, setPendingDeletions] = useState<Transaction[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [chatTxn, setChatTxn] = useState<Transaction | null>(null); // transaction whose chat is open
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showRibbon, setShowRibbon] = useState(false);
  // bulk selection + export/download
  const [selected, setSelected] = useState<number[]>([]);
  const [bulk, setBulk] = useState<'data' | 'documents' | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const toggleSel = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  /**
   * One click = every transaction, every detail, one row each. Small sets stream straight
   * back; large ones are queued and collected from the Download Centre, because a request
   * that spends minutes building a workbook would otherwise time out in the browser.
   */
  const downloadEverything = async () => {
    setDownloadingAll(true);
    try {
      // Sized by the whole set, not the visible page — otherwise every export past page one
      // would take the "small enough to stream" branch and time out.
      if (total > 25) {
        const job = await queueExport('transaction-complete-xlsx', ALL_TRANSACTIONS);
        toast(`Preparing ${total} transactions (${job.export_id}) — collecting it in the Download Centre`, 'ok');
        navigate(deskPath('transactions/downloads'));
      } else {
        await exportCompleteXlsx(ALL_TRANSACTIONS);
        toast('Download started', 'ok');
      }
    } catch (e) {
      toast(apiErrorMessage(e, 'The download failed'), 'bad');
    } finally { setDownloadingAll(false); }
  };

  /**
   * Fetch one page. `seq` guards against out-of-order responses: typing quickly leaves several
   * requests in flight, and without it a slow early reply can land after a fast later one and
   * repaint the table with stale rows.
   */
  const seq = useRef(0);
  const load = (toPage = page, f = filters) => {
    const mine = ++seq.current;
    setLoading(true);
    listTransactionsPage({ ...toQuery(f), page: toPage, per_page: PER_PAGE })
      .then((res) => {
        if (mine !== seq.current) return;
        setRows(res.data);
        setLastPage(res.meta.last_page);
        setTotal(res.meta.total);
        setMatchingIds(res.meta.ids);
        setYears(res.meta.years);
        setPendingDeletions(res.meta.pending_deletions);
        // A filter (or a deletion) can shrink the set past the page you were on.
        if (toPage > res.meta.last_page) setPage(res.meta.last_page);
      })
      .catch(() => { if (mine === seq.current) toast('Could not load transactions', 'bad'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  };

  // Filters are applied by the database now, so each change refetches. Text inputs wait for a
  // pause in typing; selects and date pickers apply at once. Any filter change returns to page 1,
  // because staying on page 7 of a set that now has two pages shows nothing.
  const firstRun = useRef(true);
  const prevFilters = useRef(filters);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; load(1, filters); return; }
    // Only a typed field earns the delay. Waiting 350 ms after a dropdown or date pick would
    // read as lag, since there is no further input coming.
    const changed = (Object.keys(filters) as (keyof Filters)[]).filter((k) => filters[k] !== prevFilters.current[k]);
    prevFilters.current = filters;
    const wait = changed.length > 0 && changed.every((k) => TYPED_KEYS.includes(k)) ? TYPING_DEBOUNCE_MS : 0;
    const t = setTimeout(() => { setPage(1); load(1, filters); }, wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  /**
   * Select/deselect every row on this page. Selection deliberately spans pages — paging away
   * does not drop what you already picked — so this only toggles the visible ids.
   */
  const togglePageSel = () => setSelected((s) => {
    const visible = rows.map((t) => t.id);
    return visible.every((id) => s.includes(id)) ? s.filter((id) => !visible.includes(id)) : [...new Set([...s, ...visible])];
  });

  const setF = (k: keyof Filters, v: string) => setFilters((p) => ({ ...p, [k]: v }));
  const anyFilter = (Object.keys(filters) as (keyof Filters)[]).some((k) => filters[k] !== '');
  const activeRibbonCount = RIBBON_KEYS.filter((k) => filters[k]).length;
  const goto = (p: number) => { const n = Math.min(Math.max(1, p), lastPage); setPage(n); load(n); };
  const clearRibbon = () => setFilters((p) => ({ ...p, offerFrom: '', offerTo: '', closingFrom: '', closingTo: '', payout: '', client: '', brokerage: '' }));

  const onDelete = async (t: Transaction) => {
    // Agents cannot delete — they raise a deletion request (routed to Admin → Super Admin).
    if (isAgent) {
      const reason = window.prompt(`Reason for requesting deletion of transaction #${t.trade_no}:`);
      if (reason === null) return;
      if (!reason.trim()) { toast('A reason is required', 'bad'); return; }
      try { await requestTransactionDeletion(t.id, reason.trim()); toast('Deletion request sent to Admin', 'ok'); }
      catch (e) { toast(apiErrorMessage(e, 'Could not send request'), 'bad'); }
      return;
    }
    if (!window.confirm(`Delete transaction #${t.trade_no}?`)) return;
    try {
      await deleteTransaction(t.id);
      setSelected((sel) => sel.filter((x) => x !== t.id));
      // Refetch rather than splice: removing a row pulls one up from the next page and changes
      // the total, neither of which a local filter can know about.
      load();
      toast('Transaction deleted', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); }
  };

  const stPill = (s: string) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));

  return (
    <>
      {/* Deletion requests to review (admins/managers). */}
      {isAdminOrAbove && pendingDeletions.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fef2f2', marginBottom: 14 }}>
          <strong style={{ color: '#991b1b' }}><Icon name="trash" size={13} /> {pendingDeletions.length} transaction deletion request{pendingDeletions.length === 1 ? '' : 's'} to review</strong>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingDeletions.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: '#7f1d1d', borderTop: '1px solid #fecaca', paddingTop: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{t.property || 'Untitled'}</strong> <span style={{ color: 'var(--muted)' }}>· Trade #{t.trade_no}</span>
                  <div>Requested by {t.delete_request?.requested_by_name || 'agent'}{t.delete_request?.reason ? ` — “${t.delete_request.reason}”` : ''} <span className={`pill ${t.delete_request?.status === 'forwarded' ? 'warn' : 'info'}`} style={{ fontSize: 10 }}>{t.delete_request?.status === 'forwarded' ? 'with Super Admin' : 'pending'}</span></div>
                </div>
                <button className="btn primary sm" onClick={() => navigate(deskPath(`transactions/${t.id}`))}>Verify &amp; decide →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar"><div className="toolbar-row">
        <input className="inp with-search" placeholder="Search property, trade #, agent" value={filters.q} onChange={(e) => setF('q', e.target.value)} />
        <select value={filters.year} onChange={(e) => setF('year', e.target.value)} title="Year (by closing date)">
          <option value="">All years (by closing date)</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={filters.type} onChange={(e) => setF('type', e.target.value)}>
          <option value="">All types</option>
          {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
        <select value={filters.validation} onChange={(e) => setF('validation', e.target.value)}>
          <option value="">All validation</option><option>Pending</option><option>Valid</option><option>Invalid</option>
        </select>
        <input style={{ width: 'auto', flex: '0 1 auto', minWidth: 120 }} placeholder="All agents" value={filters.agent} onChange={(e) => setF('agent', e.target.value)} />
        <select value={filters.commission} onChange={(e) => setF('commission', e.target.value)}>
          <option value="">Commission: any</option><option>Received</option><option>Not received</option>
        </select>
        <select value={filters.status} onChange={(e) => setF('status', e.target.value)}>
          <option value="">All statuses</option><option>Open</option><option>Active</option><option>Closed</option><option>Sold</option><option>Leased</option><option>Mutual Release</option><option>DFT</option><option>Void</option><option>Suspended</option><option>Terminated</option><option>Expired</option>
        </select>
        <button className={`btn ${showRibbon || activeRibbonCount ? 'primary' : 'ghost'} sm`} onClick={() => setShowRibbon((s) => !s)}>
          <Icon name="filter" size={13} /> Add Filter{activeRibbonCount ? ` (${activeRibbonCount})` : ''} {showRibbon ? <Icon name="chevronDown" size={12} className="flip" /> : <Icon name="chevronDown" size={12} />}
        </button>
        <button className="btn ghost sm" disabled={downloadingAll || loading} onClick={downloadEverything}
          title="Download every transaction — one row each, with team split, clients, lawyer, financial, adjustments and conditions">
          {downloadingAll ? <><Icon name="clock" size={13} /> Preparing…</> : <><Icon name="download" size={13} /> Download All Transactions</>}
        </button>
        <button className="btn ghost sm" onClick={() => navigate(deskPath('transactions/downloads'))} title="Past and queued exports"><Icon name="download" size={13} /> Download Centre</button>
        {canEdit && <button className="btn ghost sm" onClick={() => navigate(deskPath('transactions/import'))} title="Create many transactions from a spreadsheet"><Icon name="upload" size={13} /> Bulk Import</button>}
        {canEdit && <button className="btn primary sm" onClick={() => setAddOpen(true)}>+ Add Transaction</button>}
      </div>

        {/* Hidden advanced-filter ribbon */}
        {showRibbon && (
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 12, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Dates</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>Offer from<input type="date" value={filters.offerFrom} onChange={(e) => setF('offerFrom', e.target.value)} style={{ display: 'block', marginTop: 2 }} /></label>
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>Offer to<input type="date" value={filters.offerTo} onChange={(e) => setF('offerTo', e.target.value)} style={{ display: 'block', marginTop: 2 }} /></label>
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>Closing from<input type="date" value={filters.closingFrom} onChange={(e) => setF('closingFrom', e.target.value)} style={{ display: 'block', marginTop: 2 }} /></label>
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>Closing to<input type="date" value={filters.closingTo} onChange={(e) => setF('closingTo', e.target.value)} style={{ display: 'block', marginTop: 2 }} /></label>
              </div>
            </div>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Payout status
              <select value={filters.payout} onChange={(e) => setF('payout', e.target.value)} style={{ display: 'block', marginTop: 2 }}>
                <option value="">Any</option><option>Paid</option><option>Pending</option><option>N/A</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Client
              <input value={filters.client} onChange={(e) => setF('client', e.target.value)} placeholder="Client name" style={{ display: 'block', marginTop: 2, minWidth: 160 }} />
            </label>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Brokerage
              <input value={filters.brokerage} onChange={(e) => setF('brokerage', e.target.value)} placeholder="Brokerage name" style={{ display: 'block', marginTop: 2, minWidth: 160 }} />
            </label>
            {activeRibbonCount > 0 && <button className="btn ghost sm" onClick={clearRibbon}><Icon name="close" size={13} /> Clear filters</button>}
          </div>
        )}
      </div>

      {/* bulk actions — appear once transactions are selected */}
      {selected.length > 0 && (
        <div className="report-bulkbar">
          <strong>{selected.length}</strong> transaction{selected.length === 1 ? '' : 's'} selected
          {selected.length < total && (
            <button className="btn ghost sm" onClick={() => setSelected(matchingIds)}>
              Select all {total} matching
            </button>
          )}
          <span className="spacer" />
          <button className="btn sm" onClick={() => setBulk('data')}>Export Data</button>
          <button className="btn sm" onClick={() => setBulk('documents')}>Download Documents</button>
          <button className="btn ghost sm" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      <table className="list-table">
        <thead><tr>
          <th className="report-sel-col">
            <input
              type="checkbox"
              checked={rows.length > 0 && rows.every((t) => selected.includes(t.id))}
              onChange={togglePageSel}
              title="Select all transactions on this page"
            />
          </th>
          <th>Type</th><th>Trade #</th><th>Offer</th><th>Closing</th><th>Property</th><th>Agent</th>
          <th>Price</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={10} className="centered">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>
              {/* With filters on, an empty table means "nothing matched", not "nothing exists". */}
              {anyFilter ? 'No transactions match these filters.' : 'No transactions found. Click "+ Add Transaction" to create one.'}
            </td></tr>
          ) : rows.map((t) => {
            const primary = (t.statuses && t.statuses[0]) || 'Open';
            return (
              <tr key={t.id}>
                <td className="report-sel-col">
                  <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggleSel(t.id)} />
                </td>
                <td><span className={`pill ${typeClass(t.type)}`}>{typeLabel(t.type)}</span></td>
                <td>#{t.trade_no}</td>
                <td className="date">{t.offer_date || ''}</td>
                <td className="date">{t.closing_date || ''}</td>
                <td><a className="prop-link" onClick={() => navigate(`${deskPath(`transactions/${t.id}`)}?mode=view`)}>{t.property}</a></td>
                <td>{t.agent || 'Unassigned'}</td>
                <td>{formatPrice(t.price)}</td>
                <td><span className={`pill ${stPill(primary)}`}>{primary}</span></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => navigate(`${deskPath(`transactions/${t.id}`)}?mode=${canEdit ? 'edit' : 'view'}`)}>{canEdit ? 'Edit' : 'View'}</button>
                    {/* Per-transaction chat with an unread-message badge. */}
                    <button className="btn ghost sm" onClick={() => setChatTxn(t)} style={{ position: 'relative' }} title="Open chat">
                      <Icon name="message" size={14} />
                      {(t.unread_messages ?? 0) > 0 && (
                        <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--bad)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' }}>
                          {(t.unread_messages ?? 0) > 99 ? '99+' : t.unread_messages}
                        </span>
                      )}
                    </button>
                    {canEdit && <button className="btn ghost sm" onClick={() => onDelete(t)}><Icon name="trash" size={14} /></button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Pager. Hidden when everything fits on one page, so a short list looks exactly as before. */}
      {!loading && lastPage > 1 && (
        <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, total)} of {total}
          </span>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => goto(1)}>« First</button>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => goto(page - 1)}>‹ Prev</button>
          <span style={{ fontSize: 12 }}>Page {page} of {lastPage}</span>
          <button className="btn ghost sm" disabled={page >= lastPage} onClick={() => goto(page + 1)}>Next ›</button>
          <button className="btn ghost sm" disabled={page >= lastPage} onClick={() => goto(lastPage)}>Last »</button>
        </div>
      )}

      <AddTransactionModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(t) => { load(); navigate(`${deskPath(`transactions/${t.id}`)}?mode=edit`); }} />

      {/* Opening the chat marks it read on the backend — clear the badge on close. */}
      {chatTxn && (
        <ChatModal
          open
          transactionId={chatTxn.id}
          onClose={() => { setRows((rs) => rs.map((x) => x.id === chatTxn.id ? { ...x, unread_messages: 0 } : x)); setChatTxn(null); }}
        />
      )}
      {bulk && (
        <BulkExportModal mode={bulk} transactionIds={selected} onClose={() => setBulk(null)} />
      )}
    </>
  );
}
