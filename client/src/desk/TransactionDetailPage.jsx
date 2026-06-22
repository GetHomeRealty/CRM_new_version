import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getTransaction, updateTransaction, listAgents } from '../lib/api';
import { typeClass, isListingType, emailLooksValid, parseNumber, TRANSACTION_TYPES } from './format';
import { useToast } from './toast';

const STATUS_LISTING = ['Open', 'Sold', 'Sold conditional', 'Terminated', 'Expired', 'Suspended', 'Mutual release', 'DFT', 'Void', 'MPR', 'Closed'];
const STATUS_DEFAULT = ['Open', 'Hold', 'Closed', 'Mutual Release', 'DFT', 'Void', 'MPR'];
const COND_TYPES = ['Financing', 'Home Inspection', 'Sale of Property', 'Status Certificate Review', 'Custom'];

function toForm(t) {
  return {
    id: t.id, trade_no: t.trade_no, type: t.type,
    property: t.property || '', agent: t.agent || '',
    price: t.price || 0, deposit: t.deposit || 0,
    offer_date: t.offer_date || '', closing_date: t.closing_date || '',
    listing_contract_date: t.listing_contract_date || '', listing_expiry_date: t.listing_expiry_date || '',
    mls_type: t.mls_type || 'mls', mls_num: t.mls_num || '', mls_verified: !!t.mls_verified,
    conditional_offer: !!t.conditional_offer, inter_board_enabled: !!t.inter_board_enabled,
    statuses: t.statuses && t.statuses.length ? t.statuses : ['Open'],
    clients: (t.clients || []).map((c) => ({ ...c })),
    conditions: (t.conditions || []).map((c) => ({ ...c })),
    inter_board_listings: (t.inter_board_listings || []).map((i) => ({ ...i })),
    brokerage: {
      name: t.brokerage?.name || '', address: t.brokerage?.address || '',
      email: t.brokerage?.email || '', invoice_email: t.brokerage?.invoice_email || '',
      agent_email: t.brokerage?.agent_email || '', phone: t.brokerage?.phone || '',
      agents: (t.brokerage?.agents && t.brokerage.agents.length) ? [...t.brokerage.agents] : [''],
    },
  };
}

export default function TransactionDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState(null);
  const [mode, setMode] = useState(params.get('mode') === 'edit' ? 'edit' : 'view');
  const [agents, setAgents] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTransaction(id).then((t) => setForm(toForm(t))).catch(() => toast('Could not load transaction', 'bad'));
    listAgents().then(setAgents).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) return <div className="centered">Loading…</div>;

  const view = mode === 'view';
  const listing = isListingType(form.type);
  const isLease = form.type.includes('Residential Lease');
  const statusOptions = listing ? STATUS_LISTING : STATUS_DEFAULT;
  const ro = view; // read-only flag

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setBrok = (k, v) => setForm((f) => ({ ...f, brokerage: { ...f.brokerage, [k]: v } }));

  const toggleStatus = (s) => {
    setForm((f) => {
      const has = f.statuses.includes(s);
      let next = has ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
      if (next.length === 0) next = ['Open'];
      return { ...f, statuses: next };
    });
  };

  // clients
  const addClient = () => set('clients', [...form.clients, { name: '', email: '', phone: '' }]);
  const updClient = (i, k, v) => set('clients', form.clients.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmClient = (i) => set('clients', form.clients.filter((_, idx) => idx !== i));

  // conditions
  const addCond = () => set('conditions', [...form.conditions, { type: isLease ? 'Custom' : 'Financing', custom_name: '', deadline: '', status: 'Pending' }]);
  const updCond = (i, k, v) => set('conditions', form.conditions.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmCond = (i) => set('conditions', form.conditions.filter((_, idx) => idx !== i));

  // inter-board
  const addIb = () => set('inter_board_listings', [...form.inter_board_listings, { name: '', board_id: '', verified: false }]);
  const updIb = (i, k, v) => set('inter_board_listings', form.inter_board_listings.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const rmIb = (i) => set('inter_board_listings', form.inter_board_listings.filter((_, idx) => idx !== i));

  // brokerage agents
  const addBrokAgent = () => setBrok('agents', [...form.brokerage.agents, '']);
  const updBrokAgent = (i, v) => setBrok('agents', form.brokerage.agents.map((a, idx) => idx === i ? v : a));
  const rmBrokAgent = (i) => setBrok('agents', form.brokerage.agents.filter((_, idx) => idx !== i));

  const dOrNull = (v) => (v && v.trim() ? v : null);

  const save = async () => {
    // validate clients
    for (const c of form.clients) {
      if (!c.name?.trim()) { toast('Each client needs a name', 'bad'); return; }
      if (c.email && !emailLooksValid(c.email)) { toast('Invalid client email', 'bad'); return; }
    }
    const payload = {
      type: form.type, property: form.property, agent: form.agent || null,
      price: parseNumber(form.price), deposit: parseNumber(form.deposit),
      offer_date: dOrNull(form.offer_date), closing_date: dOrNull(form.closing_date),
      listing_contract_date: dOrNull(form.listing_contract_date), listing_expiry_date: dOrNull(form.listing_expiry_date),
      mls_type: form.mls_type, mls_num: form.mls_num || null, mls_verified: form.mls_verified,
      conditional_offer: form.conditional_offer, inter_board_enabled: form.inter_board_enabled,
      statuses: form.statuses,
      clients: form.clients.map((c) => ({ name: c.name, email: c.email || null, phone: c.phone || null })),
      conditions: form.conditional_offer
        ? form.conditions.map((c) => ({ type: c.type, custom_name: c.custom_name || null, deadline: dOrNull(c.deadline), status: c.status }))
        : [],
      inter_board_listings: form.inter_board_enabled
        ? form.inter_board_listings.map((i) => ({ name: i.name || null, board_id: i.board_id || null, verified: !!i.verified }))
        : [],
      brokerage: {
        name: form.brokerage.name || null, address: form.brokerage.address || null,
        email: form.brokerage.email || null, invoice_email: form.brokerage.invoice_email || null,
        agent_email: form.brokerage.agent_email || null, phone: form.brokerage.phone || null,
        agents: form.brokerage.agents.filter((a) => a && a.trim()),
      },
    };
    setSaving(true);
    try {
      const updated = await updateTransaction(id, payload);
      setForm(toForm(updated));
      setMode('view');
      toast('Transaction saved', 'ok');
    } catch (err) {
      toast(err.response?.data?.message || 'Could not save', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const stPill = (s) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' || s === 'MPR' ? 'bad' : 'warn'));
  const brokLabel = listing ? 'Co-Op' : 'Listing';

  return (
    <>
      <div className="detail-head">
        <button className="btn ghost sm" onClick={() => navigate('/app/transactions')}>← Back</button>
        <div className="detail-title">
          <strong>{form.property || 'Untitled'}</strong>
          <span className={`pill ${typeClass(form.type)}`}>{form.type}</span>
          {form.statuses.map((s) => <span key={s} className={`pill ${stPill(s)}`}>{s}</span>)}
          <span className={`pill ${view ? 'info' : 'warn'}`} style={{ fontSize: 10 }}>{view ? '🔒 View Only' : '✏ Edit Mode'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {view
            ? <button className="btn primary sm" onClick={() => setMode('edit')}>✏ Edit</button>
            : (<>
                <button className="btn ghost sm" onClick={() => setMode('view')}>Cancel</button>
                <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
              </>)}
        </div>
      </div>

      {/* Basic Info + Trade meta */}
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Basic Info</div>
        <div className="g3">
          <Field label="Type">
            <select value={form.type} disabled={ro} onChange={(e) => set('type', e.target.value)}>
              {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: '#f9fafb' }} /></Field>
          <Field label="Agent Name">
            <input list="agentList" value={form.agent} disabled={ro} onChange={(e) => set('agent', e.target.value)} placeholder="Search Agent..." />
            <datalist id="agentList">{agents.map((a) => <option key={a} value={a} />)}</datalist>
          </Field>
        </div>
        <div className="g3">
          <Field label="Property Address" req><input value={form.property} disabled={ro} onChange={(e) => set('property', e.target.value)} /></Field>
          <Field label={isLease ? 'Total lease price' : 'Total Purchase Price'}>
            <input value={form.price} disabled={ro} onChange={(e) => set('price', e.target.value)} />
          </Field>
          <Field label="Deposit"><input value={form.deposit} disabled={ro} onChange={(e) => set('deposit', e.target.value)} /></Field>
        </div>
        <div className="g3">
          {listing ? (<>
            <Field label="Listing Contract Date"><input type="date" value={form.listing_contract_date} disabled={ro} onChange={(e) => set('listing_contract_date', e.target.value)} /></Field>
            <Field label="Listing Expiry Date"><input type="date" value={form.listing_expiry_date} disabled={ro} onChange={(e) => set('listing_expiry_date', e.target.value)} /></Field>
          </>) : (<>
            <Field label="Offer Date"><input type="date" value={form.offer_date} disabled={ro} onChange={(e) => set('offer_date', e.target.value)} /></Field>
            <Field label="Closing Date"><input type="date" value={form.closing_date} disabled={ro} onChange={(e) => set('closing_date', e.target.value)} /></Field>
          </>)}
          <Field label="MLS #">
            <input value={form.mls_num} disabled={ro} onChange={(e) => set('mls_num', e.target.value.toUpperCase())} placeholder="e.g. E12345678" />
          </Field>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Status</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {statusOptions.map((s) => {
              const on = form.statuses.includes(s);
              return (
                <label key={s} className={`ms-chip ${on ? 'on' : ''}`} style={ro ? { opacity: 0.7, pointerEvents: 'none' } : undefined}>
                  <input type="checkbox" checked={on} disabled={ro} onChange={() => toggleStatus(s)} />{s}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Brokerage */}
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>{brokLabel} Brokerage Information</div>
        <Field label={`${brokLabel} Brokerage Name`}><input value={form.brokerage.name} disabled={ro} onChange={(e) => setBrok('name', e.target.value)} placeholder="Brokerage name" /></Field>
        <div className="field">
          <label>{brokLabel} Agent Name(s)</label>
          {form.brokerage.agents.map((a, i) => (
            <div className="agent-item" key={i}>
              <input value={a} disabled={ro} onChange={(e) => updBrokAgent(i, e.target.value)} placeholder="Enter agent name..." />
              {!ro && form.brokerage.agents.length > 1 && <button className="row-rm" onClick={() => rmBrokAgent(i)}>🗑️</button>}
            </div>
          ))}
          {!ro && <button className="btn primary sm" style={{ marginTop: 6 }} onClick={addBrokAgent}>+ Add Agent</button>}
        </div>
        <Field label="Brokerage Address"><input value={form.brokerage.address} disabled={ro} onChange={(e) => setBrok('address', e.target.value)} /></Field>
        <div className="g3">
          <Field label="Brokerage Email"><input type="email" value={form.brokerage.email} disabled={ro} onChange={(e) => setBrok('email', e.target.value)} /></Field>
          <Field label="Invoice Email"><input type="email" value={form.brokerage.invoice_email} disabled={ro} onChange={(e) => setBrok('invoice_email', e.target.value)} /></Field>
          <Field label="Agent Email"><input type="email" value={form.brokerage.agent_email} disabled={ro} onChange={(e) => setBrok('agent_email', e.target.value)} /></Field>
        </div>
        <Field label="Phone Number"><input value={form.brokerage.phone} disabled={ro} onChange={(e) => setBrok('phone', e.target.value)} placeholder="+1 000-000-0000" /></Field>
      </div>

      {/* Clients */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="modal-h" style={{ fontSize: 14, margin: 0 }}>Client Information</div>
          <span className="pill info" style={{ fontSize: 11 }}>{form.clients.length} client{form.clients.length === 1 ? '' : 's'}</span>
        </div>
        {form.clients.length === 0 && <div className="help">No clients added yet.</div>}
        {form.clients.map((c, i) => (
          <div key={i} className="g3" style={{ alignItems: 'end', marginBottom: 8 }}>
            <Field label="Full Name" req><input value={c.name} disabled={ro} onChange={(e) => updClient(i, 'name', e.target.value)} /></Field>
            <Field label="Email"><input type="email" value={c.email || ''} disabled={ro} onChange={(e) => updClient(i, 'email', e.target.value)} /></Field>
            <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
              <Field label="Phone"><input value={c.phone || ''} disabled={ro} onChange={(e) => updClient(i, 'phone', e.target.value)} placeholder="+1 000-000-0000" /></Field>
              {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmClient(i)}>🗑️</button>}
            </div>
          </div>
        ))}
        {!ro && <button className="btn primary sm" onClick={addClient}>+ Add Client</button>}
      </div>

      {/* Conditional Offer (non-listing UI mirrors original; shown for all here) */}
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Conditional Offer</div>
        <Field label="Is Offer Conditional?" style={{ maxWidth: 220 }}>
          <select value={form.conditional_offer ? 'Yes' : 'No'} disabled={ro} onChange={(e) => set('conditional_offer', e.target.value === 'Yes')}>
            <option>No</option><option>Yes</option>
          </select>
        </Field>
        {form.conditional_offer && (
          <div>
            {form.conditions.map((c, i) => (
              <div key={i} className="cond-row">
                <div style={{ display: 'grid', gridTemplateColumns: c.type === 'Custom' ? '160px 1fr 1fr 1fr auto' : '200px 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                  <Field label="Type">
                    <select value={c.type} disabled={ro} onChange={(e) => updCond(i, 'type', e.target.value)}>
                      {COND_TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </Field>
                  {c.type === 'Custom' && <Field label="Custom Name"><input value={c.custom_name || ''} disabled={ro} onChange={(e) => updCond(i, 'custom_name', e.target.value)} /></Field>}
                  <Field label="Deadline"><input type="date" value={c.deadline || ''} disabled={ro} onChange={(e) => updCond(i, 'deadline', e.target.value)} /></Field>
                  <Field label="Status">
                    <select value={c.status} disabled={ro} onChange={(e) => updCond(i, 'status', e.target.value)}>
                      <option>Pending</option><option>Waived</option><option>Fulfilled</option><option>Not Met</option>
                    </select>
                  </Field>
                  {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}>🗑️</button>}
                </div>
              </div>
            ))}
            {!ro && <button className="btn primary sm" style={{ marginTop: 8 }} onClick={addCond}>+ Add Condition</button>}
          </div>
        )}
      </div>

      {/* Inter-board (listing types only) */}
      {listing && (
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Inter Board Listing</div>
          <Field label="Inter Board Listing?" style={{ maxWidth: 220 }}>
            <select value={form.inter_board_enabled ? 'Yes' : 'No'} disabled={ro} onChange={(e) => set('inter_board_enabled', e.target.value === 'Yes')}>
              <option>No</option><option>Yes</option>
            </select>
          </Field>
          {form.inter_board_enabled && (
            <div>
              {form.inter_board_listings.map((x, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr auto auto', gap: 10, alignItems: 'end', marginBottom: 8 }}>
                  <Field label="Name"><input value={x.name || ''} disabled={ro} onChange={(e) => updIb(i, 'name', e.target.value)} /></Field>
                  <Field label="ID"><input value={x.board_id || ''} disabled={ro} onChange={(e) => updIb(i, 'board_id', e.target.value.toUpperCase())} /></Field>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', paddingBottom: 10 }}>
                    <input type="checkbox" checked={!!x.verified} disabled={ro} onChange={(e) => updIb(i, 'verified', e.target.checked)} /> Verified
                  </label>
                  {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmIb(i)}>🗑️</button>}
                </div>
              ))}
              {!ro && <button className="btn primary sm" style={{ marginTop: 6 }} onClick={addIb}>+ Add Inter Board listing</button>}
            </div>
          )}
        </div>
      )}

      {/* Stage note */}
      <div className="card" style={{ background: 'var(--surface-2)' }}>
        <span className="help" style={{ margin: 0 }}>
          Financial, Team Split, Legal &amp; Docs, Admin, Adjustments, Agent FAQ and PDF generation (Invoice / Notice of Sale / Trade Sheet) arrive in later stages. Commission totals are computed by the backend and shown on the Transactions list.
        </span>
      </div>
    </>
  );
}

function Field({ label, req, children, style }) {
  return (
    <div className="field" style={{ marginBottom: 0, ...style }}>
      <label>{label}{req && <span className="req">*</span>}</label>
      {children}
    </div>
  );
}
