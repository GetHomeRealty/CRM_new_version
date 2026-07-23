import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions, deleteTransaction, requestTransactionDeletion } from '../lib/api';
import { formatPrice, typeClass, typeLabel, TRANSACTION_TYPES } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
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

/** Closing-date year of a deal (null when it has no closing date) — same rule as the Dashboard. */
const dealYear = (t: Transaction): string | null => (t.closing_date ? String(t.closing_date).slice(0, 4) : null);

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
  const [addOpen, setAddOpen] = useState(false);
  const [chatTxn, setChatTxn] = useState<Transaction | null>(null); // transaction whose chat is open
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showRibbon, setShowRibbon] = useState(false);
  // bulk selection + export/download
  const [selected, setSelected] = useState<number[]>([]);
  const [bulk, setBulk] = useState<'data' | 'documents' | null>(null);
  const toggleSel = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const load = () => {
    setLoading(true);
    listTransactions()
      .then(setRows)
      .catch(() => toast('Could not load transactions', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps


  // Years actually present in the data, newest first — no empty options, and no hardcoded range.
  const years = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((t) => { const y = dealYear(t); if (y) set.add(y); });
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rows]);

  const filtered = useMemo(() => {
    const f = filters;
    const q = f.q.toLowerCase().trim();
    return rows.filter((t) => {
      if (q && !`${t.property} ${t.trade_no} ${t.agent || ''}`.toLowerCase().includes(q)) return false;
      // A deal with no closing date belongs to no year, so it drops out once a year is chosen.
      if (f.year && dealYear(t) !== f.year) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.validation && t.valid_status !== f.validation) return false;
      if (f.agent && !(t.agent || '').toLowerCase().includes(f.agent.toLowerCase())) return false;
      if (f.commission === 'Received' && t.comm_status !== 'Received') return false;
      if (f.commission === 'Not received' && t.comm_status === 'Received') return false;
      if (f.status && !(t.statuses || []).includes(f.status)) return false;
      // --- Advanced ribbon filters ---
      if (f.offerFrom && (!t.offer_date || t.offer_date < f.offerFrom)) return false;
      if (f.offerTo && (!t.offer_date || t.offer_date > f.offerTo)) return false;
      if (f.closingFrom && (!t.closing_date || t.closing_date < f.closingFrom)) return false;
      if (f.closingTo && (!t.closing_date || t.closing_date > f.closingTo)) return false;
      if (f.payout) {
        const paid = t.comm_paid_status; // Yes | No | N/A
        if (f.payout === 'Paid' && paid !== 'Yes') return false;
        if (f.payout === 'Pending' && paid === 'Yes') return false; // No / '' / null
        if (f.payout === 'N/A' && paid !== 'N/A') return false;
      }
      if (f.client) {
        const names = (t.clients || []).map((c) => (c.name || '').toLowerCase()).join(' ');
        if (!names.includes(f.client.toLowerCase())) return false;
      }
      if (f.brokerage) {
        const b = (t.brokerage?.name || '').toLowerCase();
        if (!b.includes(f.brokerage.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, filters]);

  /** Select/deselect every transaction currently visible under the applied filters. */
  const togglePageSel = () => setSelected((s) => {
    const visible = filtered.map((t) => t.id);
    return visible.every((id) => s.includes(id)) ? s.filter((id) => !visible.includes(id)) : [...new Set([...s, ...visible])];
  });

  const setF = (k: keyof Filters, v: string) => setFilters((p) => ({ ...p, [k]: v }));
  const activeRibbonCount = RIBBON_KEYS.filter((k) => filters[k]).length;
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
      setRows((r) => r.filter((x) => x.id !== t.id));
      toast('Transaction deleted', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); }
  };

  const stPill = (s: string) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));

  const pendingDeletions = rows.filter((t) => t.delete_request);

  return (
    <>
      {/* Deletion requests to review (admins/managers). */}
      {isAdminOrAbove && pendingDeletions.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fef2f2', marginBottom: 14 }}>
          <strong style={{ color: '#991b1b' }}>🗑 {pendingDeletions.length} transaction deletion request{pendingDeletions.length === 1 ? '' : 's'} to review</strong>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingDeletions.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: '#7f1d1d', borderTop: '1px solid #fecaca', paddingTop: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{t.property || 'Untitled'}</strong> <span style={{ color: 'var(--muted)' }}>· Trade #{t.trade_no}</span>
                  <div>Requested by {t.delete_request?.requested_by_name || 'agent'}{t.delete_request?.reason ? ` — “${t.delete_request.reason}”` : ''} <span className={`pill ${t.delete_request?.status === 'forwarded' ? 'warn' : 'info'}`} style={{ fontSize: 10 }}>{t.delete_request?.status === 'forwarded' ? 'with Super Admin' : 'pending'}</span></div>
                </div>
                <button className="btn primary sm" onClick={() => navigate(`/app/transactions/${t.id}`)}>Verify &amp; decide →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar"><div className="toolbar-row">
        <input className="inp" placeholder="🔍 Search property, trade #, agent" value={filters.q} onChange={(e) => setF('q', e.target.value)} />
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
          ⚙ Add Filter{activeRibbonCount ? ` (${activeRibbonCount})` : ''} {showRibbon ? '▲' : '▾'}
        </button>
        <button className="btn ghost sm" onClick={() => navigate('/app/transactions/downloads')} title="Background exports and generated downloads">⇩ Download Centre</button>
        {canEdit && <button className="btn ghost sm" onClick={() => navigate('/app/transactions/import')} title="Create many transactions from a spreadsheet">⭳ Bulk Import</button>}
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
            {activeRibbonCount > 0 && <button className="btn ghost sm" onClick={clearRibbon}>✕ Clear filters</button>}
          </div>
        )}
      </div>

      {/* bulk actions — appear once transactions are selected */}
      {selected.length > 0 && (
        <div className="report-bulkbar">
          <strong>{selected.length}</strong> transaction{selected.length === 1 ? '' : 's'} selected
          {selected.length < filtered.length && (
            <button className="btn ghost sm" onClick={() => setSelected(filtered.map((t) => t.id))}>
              Select all {filtered.length} matching
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
              checked={filtered.length > 0 && filtered.every((t) => selected.includes(t.id))}
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
          ) : filtered.length === 0 ? (
            <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No transactions found. Click "+ Add Transaction" to create one.</td></tr>
          ) : filtered.map((t) => {
            const primary = (t.statuses && t.statuses[0]) || 'Open';
            return (
              <tr key={t.id}>
                <td className="report-sel-col">
                  <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggleSel(t.id)} />
                </td>
                <td><span className={`pill ${typeClass(t.type)}`}>{typeLabel(t.type)}</span></td>
                <td>#{t.trade_no}</td>
                <td>{t.offer_date || ''}</td>
                <td>{t.closing_date || ''}</td>
                <td><a className="prop-link" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>{t.property}</a></td>
                <td>{t.agent || 'Unassigned'}</td>
                <td>{formatPrice(t.price)}</td>
                <td><span className={`pill ${stPill(primary)}`}>{primary}</span></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${t.id}?mode=${canEdit ? 'edit' : 'view'}`)}>{canEdit ? 'Edit' : 'View'}</button>
                    {/* Per-transaction chat with an unread-message badge. */}
                    <button className="btn ghost sm" onClick={() => setChatTxn(t)} style={{ position: 'relative' }} title="Open chat">
                      💬
                      {(t.unread_messages ?? 0) > 0 && (
                        <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--bad)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' }}>
                          {(t.unread_messages ?? 0) > 99 ? '99+' : t.unread_messages}
                        </span>
                      )}
                    </button>
                    {canEdit && <button className="btn ghost sm" onClick={() => onDelete(t)}>🗑️</button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <AddTransactionModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(t) => { load(); navigate(`/app/transactions/${t.id}?mode=edit`); }} />

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
