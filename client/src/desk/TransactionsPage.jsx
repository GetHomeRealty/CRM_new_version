import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions, deleteTransaction, requestTransactionDeletion } from '../lib/api';
import { formatPrice, typeClass, typeLabel, TRANSACTION_TYPES } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import AddTransactionModal from './AddTransactionModal';
import ChatModal from './ChatModal';

const EMPTY_FILTERS = { q: '', type: '', validation: '', agent: '', commission: '', status: '' };

export default function TransactionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can, user, isAdminOrAbove } = useAuth();
  const canEdit = can('transactions', 'edit');
  const isAgent = user?.role === 'agent';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [chatTxn, setChatTxn] = useState(null); // transaction whose chat is open
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const load = () => {
    setLoading(true);
    listTransactions()
      .then(setRows)
      .catch(() => toast('Could not load transactions', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps


  const filtered = useMemo(() => {
    const f = filters;
    const q = f.q.toLowerCase().trim();
    return rows.filter((t) => {
      if (q && !`${t.property} ${t.trade_no} ${t.agent || ''}`.toLowerCase().includes(q)) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.validation && t.valid_status !== f.validation) return false;
      if (f.agent && !(t.agent || '').toLowerCase().includes(f.agent.toLowerCase())) return false;
      if (f.commission === 'Received' && t.comm_status !== 'Received') return false;
      if (f.commission === 'Not received' && t.comm_status === 'Received') return false;
      if (f.status && !(t.statuses || []).includes(f.status)) return false;
      return true;
    });
  }, [rows, filters]);

  const setF = (k, v) => setFilters((p) => ({ ...p, [k]: v }));

  const onDelete = async (t) => {
    // Agents cannot delete — they raise a deletion request (routed to Admin → Super Admin).
    if (isAgent) {
      const reason = window.prompt(`Reason for requesting deletion of transaction #${t.trade_no}:`);
      if (reason === null) return;
      if (!reason.trim()) { toast('A reason is required', 'bad'); return; }
      try { await requestTransactionDeletion(t.id, reason.trim()); toast('Deletion request sent to Admin', 'ok'); }
      catch (e) { toast(e.response?.data?.message || 'Could not send request', 'bad'); }
      return;
    }
    if (!window.confirm(`Delete transaction #${t.trade_no}?`)) return;
    try {
      await deleteTransaction(t.id);
      setRows((r) => r.filter((x) => x.id !== t.id));
      toast('Transaction deleted', 'ok');
    } catch (e) { toast(e.response?.data?.message || 'Could not delete', 'bad'); }
  };

  const stPill = (s) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));

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
                  <div>Requested by {t.delete_request.requested_by_name || 'agent'}{t.delete_request.reason ? ` — “${t.delete_request.reason}”` : ''} <span className={`pill ${t.delete_request.status === 'forwarded' ? 'warn' : 'info'}`} style={{ fontSize: 10 }}>{t.delete_request.status === 'forwarded' ? 'with Super Admin' : 'pending'}</span></div>
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
        {canEdit && <button className="btn primary sm" onClick={() => setAddOpen(true)}>+ Add Transaction</button>}
      </div></div>

      <table className="list-table">
        <thead><tr>
          <th>Type</th><th>Trade #</th><th>Offer</th><th>Closing</th><th>Property</th><th>Agent</th>
          <th>Price</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={9} className="centered">Loading…</td></tr>
          ) : filtered.length === 0 ? (
            <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No transactions found. Click "+ Add Transaction" to create one.</td></tr>
          ) : filtered.map((t) => {
            const primary = (t.statuses && t.statuses[0]) || 'Open';
            return (
              <tr key={t.id}>
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
                      {t.unread_messages > 0 && (
                        <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--bad)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' }}>
                          {t.unread_messages > 99 ? '99+' : t.unread_messages}
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
    </>
  );
}
