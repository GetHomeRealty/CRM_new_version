import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getTransaction, updateTransaction, listAgents, generateTransactionInvoices, getCompanySettings, getCustomers } from '../lib/api';
import { typeClass, typeLabel, isListingType, isPreconType, isCommercialLeaseType, isInvoiceableType, emailLooksValid, parseNumber, TRANSACTION_TYPES, formatCurrency, statusOptionsFor, allowedStatuses, normalizeStatus, defaultStatusFor } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import TeamSplitModal from './TeamSplitModal';
import FinancialModal from './FinancialModal';
import DocsModal from './DocsModal';
import InvoiceModal from './InvoiceModal';
import NoticeOfSaleModal from './NoticeOfSaleModal';
import TradeSheetModal from './TradeSheetModal';
import LawyerModal from './LawyerModal';
import AuditTrailModal from './AuditTrailModal';
import AdminActivitiesModal from './AdminActivitiesModal';
import AgentFaqModal from './AgentFaqModal';
import AdjustmentModal from './AdjustmentModal';
import ChatModal from './ChatModal';
import CommercialLeaseCard, { CL_DEFAULTS } from './CommercialLeaseCard';
import InvoiceEditorModal from './InvoiceEditorModal';

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
    statuses: t.statuses && t.statuses.length
      ? Array.from(new Set(t.statuses.map((s) => normalizeStatus(t.type, s))))
      : [defaultStatusFor(t.type)],
    clients: (t.clients || []).map((c) => ({ ...c })),
    conditions: (t.conditions || []).map((c) => ({ ...c })),
    inter_board_listings: (t.inter_board_listings || []).map((i) => ({ ...i })),
    brokerage: {
      name: t.brokerage?.name || '', address: t.brokerage?.address || '',
      email: t.brokerage?.email || '', invoice_email: t.brokerage?.invoice_email || '',
      agent_email: t.brokerage?.agent_email || '', phone: t.brokerage?.phone || '',
      agents: (t.brokerage?.agents && t.brokerage.agents.length) ? [...t.brokerage.agents] : [''],
    },
    // Preconstruction
    precon_listing_type: t.precon_listing_type || 'mls',
    precon_term_count: t.precon_term_count ?? '',
    commission_agent: t.commission_agent || '',
    builder: {
      name: t.builder?.name || '', vendor: t.builder?.vendor || '', project: t.builder?.project || '',
      address: t.builder?.address || '', office_email: t.builder?.office_email || '',
      invoice_email: t.builder?.invoice_email || '', phone: t.builder?.phone || '',
    },
    // Commercial lease calculator inputs (JSON column)
    commercial_lease: t.commercial_lease || null,
    // Preconstruction per-term rows (pct managed in Financial; closing dates editable here)
    precon_terms: (t.precon_terms || []).map((p) => ({ term_no: p.term_no, pct: p.pct ?? null, closing_date: p.closing_date || '' })),
  };
}

export default function TransactionDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('transactions', 'edit');
  const canInvoice = can('invoice', 'edit');
  const [generating, setGenerating] = useState(false);

  const [form, setForm] = useState(null);
  const [txn, setTxn] = useState(null); // raw API object (carries team + financial breakdown)
  const [mode, setMode] = useState(params.get('mode') === 'edit' && canEdit ? 'edit' : 'view');
  const [agents, setAgents] = useState([]);
  const [saving, setSaving] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [finOpen, setFinOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [nosOpen, setNosOpen] = useState(false);
  const [tsOpen, setTsOpen] = useState(false);
  const [lawyerOpen, setLawyerOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [adjOpen, setAdjOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [invEditorId, setInvEditorId] = useState(undefined); // in-context invoice editor (undefined = closed)
  const [invSettings, setInvSettings] = useState(null);
  const [invCustomers, setInvCustomers] = useState([]);
  const bodyRef = useRef(null); // wraps the filterable cards for "search this transaction"

  useEffect(() => {
    getTransaction(id).then((t) => { setForm(toForm(t)); setTxn(t); }).catch(() => toast('Could not load transaction', 'bad'));
    listAgents().then(setAgents).catch(() => {});
    // Loaded lazily so the invoice editor can open in-context on this page.
    getCompanySettings().then(setInvSettings).catch(() => {});
    getCustomers().then(setInvCustomers).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyUpdated = (updated) => { setForm(toForm(updated)); setTxn(updated); };

  const generateInvoices = async () => {
    setGenerating(true);
    try {
      const res = await generateTransactionInvoices(id);
      toast(res.existing ? 'Opening existing invoice' : `Created ${res.count} invoice${res.count === 1 ? '' : 's'}`, 'ok');
      // Open the (new or existing) invoice in the same editor, in-context on this page.
      const invId = res.invoices?.[0]?.id;
      if (invId) { setInvEditorId(invId); getTransaction(id).then(applyUpdated).catch(() => {}); }
      else navigate('/app/invoices');
    } catch (e) {
      toast(e.response?.data?.message || 'Could not generate invoice', 'bad');
    } finally { setGenerating(false); }
  };

  // Unified invoice action (header + Quick Actions): existing invoice → open it in
  // the new editor; invoiceable + none yet → generate then open; otherwise the
  // on-the-fly document (non-invoiceable types have no persisted invoice).
  const openInvoice = () => {
    if (txn?.invoices?.length) setInvEditorId(txn.invoices[0].id);
    else if (canInvoice && isInvoiceableType(form.type)) generateInvoices();
    else setInvoiceOpen(true);
  };

  if (!form) return <div className="centered">Loading…</div>;

  const view = mode === 'view';
  const listing = isListingType(form.type);
  const precon = isPreconType(form.type);
  const commercialLease = isCommercialLeaseType(form.type);
  // Referral is a stripped-down transaction (no MLS / deposit / conditions / lawyer).
  const referral = form.type === 'Referral';
  // Lease types use the free-text (Custom-only) condition layout.
  const isLease = /lease/i.test(form.type);
  // Lawyer Details is hidden for lease / preconstruction / referral types (legal side handled differently).
  const lawyerHidden = precon || /lease/i.test(form.type) || referral;
  const statusOptions = statusOptionsFor(form.type);
  const statusAllowed = allowedStatuses(form.type, form.statuses);
  const ro = view; // read-only flag

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setBrok = (k, v) => setForm((f) => ({ ...f, brokerage: { ...f.brokerage, [k]: v } }));
  const setBuilder = (k, v) => setForm((f) => ({ ...f, builder: { ...f.builder, [k]: v } }));
  const cl = { ...CL_DEFAULTS, ...(form.commercial_lease || {}) };
  const setCl = (k, v) => setForm((f) => ({ ...f, commercial_lease: { ...CL_DEFAULTS, ...(f.commercial_lease || {}), [k]: v } }));
  // Preconstruction per-term closing dates (driven by the term count).
  const preconTermClosing = (k) => ((form.precon_terms || []).find((x) => Number(x.term_no) === k)?.closing_date) || '';
  const setPreconTermClosing = (k, date) => setForm((f) => {
    const arr = [...(f.precon_terms || [])];
    const idx = arr.findIndex((x) => Number(x.term_no) === k);
    if (idx >= 0) arr[idx] = { ...arr[idx], closing_date: date };
    else arr.push({ term_no: k, pct: null, closing_date: date });
    return { ...f, precon_terms: arr };
  });
  const setListingType = (which) => set('mls_type', which);

  // "Search this transaction" — filters the cards on the page (mirrors the original).
  const onSearch = (q) => {
    const root = bodyRef.current; if (!root) return;
    const query = (q || '').toLowerCase().trim();
    root.querySelectorAll('.card').forEach((c) => {
      c.style.display = !query || (c.textContent || '').toLowerCase().includes(query) ? '' : 'none';
    });
  };

  // Transaction progress stepper
  const stages = [
    { label: 'Drafted', pass: !!(txn?.id || form.property) },
    { label: 'Agent Set', pass: !!(form.agent && form.agent.trim()) },
    { label: 'Clients', pass: (form.clients || []).length > 0 },
    { label: 'Financial', pass: !!(txn?.comm_pct || txn?.comm_amt || txn?.precon_comm_pct || (txn?.financial && txn.financial.total > 0)) },
    { label: 'Closed', pass: (form.statuses || []).includes('Closed') },
  ];
  let curStage = stages.findIndex((s) => !s.pass);
  if (curStage === -1) curStage = stages.length - 1;
  const progressPct = Math.round(stages.filter((s) => s.pass).length / stages.length * 100);

  const toggleStatus = (s) => {
    setForm((f) => {
      const has = f.statuses.includes(s);
      // Enforce grouping: can't add a status outside the group of the current selection.
      if (!has && !allowedStatuses(f.type, f.statuses).includes(s)) return f;
      let next = has ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
      if (next.length === 0) next = [defaultStatusFor(f.type)];
      return { ...f, statuses: next };
    });
  };

  // Changing type can switch status family — reset to that family's default status.
  const onTypeChange = (newType) => setForm((f) => ({ ...f, type: newType, statuses: [defaultStatusFor(newType)] }));

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
    if (precon) {
      payload.precon_listing_type = form.precon_listing_type;
      payload.precon_term_count = form.precon_term_count === '' ? null : parseInt(form.precon_term_count, 10);
      payload.commission_agent = form.commission_agent || null;
      payload.builder = {
        name: form.builder.name || null, vendor: form.builder.vendor || null, project: form.builder.project || null,
        address: form.builder.address || null, office_email: form.builder.office_email || null,
        invoice_email: form.builder.invoice_email || null, phone: form.builder.phone || null,
      };
      // Per-term rows from the term count; preserve pct set in Financial, carry closing dates entered here.
      const tc = parseInt(form.precon_term_count, 10) || 0;
      payload.precon_terms = Array.from({ length: tc }, (_, i) => {
        const k = i + 1;
        const existing = (form.precon_terms || []).find((x) => Number(x.term_no) === k) || {};
        return { term_no: k, pct: existing.pct ?? null, closing_date: existing.closing_date || null };
      });
    }
    if (commercialLease) {
      payload.commercial_lease = { ...CL_DEFAULTS, ...(form.commercial_lease || {}) };
    }
    setSaving(true);
    try {
      const updated = await updateTransaction(id, payload);
      applyUpdated(updated);
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
          <span className={`pill ${typeClass(form.type)}`}>{typeLabel(form.type)}</span>
          {form.statuses.map((s) => <span key={s} className={`pill ${stPill(s)}`}>{s}</span>)}
          <span className={`pill ${view ? 'info' : 'warn'}`} style={{ fontSize: 10 }}>{view ? '🔒 View Only' : '✏ Edit Mode'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn ghost sm" onClick={openInvoice}>🧾 Invoice</button>
          <button className="btn ghost sm" onClick={() => setTsOpen(true)}>📋 Trade Sheet</button>
          <button className="btn ghost sm" onClick={() => setNosOpen(true)}>📄 Notice of Sale</button>
          <button className="btn ghost sm" onClick={() => setChatOpen(true)}>💬 Chat</button>
          <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} />
          {!canEdit
            ? <span className="pill info" style={{ fontSize: 10 }}>Read-only access</span>
            : view
            ? <button className="btn primary sm" onClick={() => setMode('edit')}>✏ Edit</button>
            : (<>
                <button className="btn ghost sm" onClick={() => setMode('view')}>Cancel</button>
                <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
              </>)}
        </div>
      </div>

      {/* Transaction progress stepper */}
      <div className="card" style={{ background: 'linear-gradient(180deg,#fff,#fafbff)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ fontSize: 13, color: 'var(--brand)' }}>Transaction Progress</strong>
          <span className="pill info" style={{ fontSize: 11 }}>{progressPct}% complete</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto', padding: '4px 2px' }}>
          {stages.map((s, idx) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'flex-start', flex: idx < stages.length - 1 ? 1 : '0 0 auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 72 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700,
                  background: s.pass ? '#16a34a' : (idx === curStage ? 'var(--brand)' : '#e5e7eb'),
                  color: s.pass || idx === curStage ? '#fff' : '#6b7280' }}>{s.pass ? '✓' : idx + 1}</div>
                <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap',
                  color: s.pass ? '#166534' : (idx === curStage ? 'var(--brand)' : '#9ca3af') }}>{s.label}</div>
              </div>
              {idx < stages.length - 1 && <div style={{ flex: 1, height: 2, background: '#e5e7eb', marginTop: 13 }} />}
            </div>
          ))}
        </div>
        <div style={{ height: 6, borderRadius: 3, background: '#e5e7eb', marginTop: 12, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg,#16a34a,var(--brand))' }} />
        </div>
      </div>

      {/* Search this transaction */}
      <div className="card" style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14 }}>🔍</span>
          <input placeholder="Search this transaction (clients, brokerage, terms, conditions…)" onChange={(e) => onSearch(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
        </div>
      </div>

      <div ref={bodyRef}>
        <div className="detail-2col">
          {/* Basic Info */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="modal-h" style={{ fontSize: 14 }}>Basic Info</div>
            <div style={{ display: 'grid', gridTemplateColumns: referral ? '1.2fr 1.6fr' : '1.1fr 1.2fr 1.6fr', gap: 12, marginBottom: 12 }}>
              {!referral && (
              <Field label="Listing Type">
                <div className="seg-toggle">
                  <button type="button" className={`seg-btn ${form.mls_type !== 'exclusive' ? 'active' : ''}`} disabled={ro} onClick={() => setListingType('mls')}>MLS</button>
                  <button type="button" className={`seg-btn ${form.mls_type === 'exclusive' ? 'active' : ''}`} disabled={ro} onClick={() => setListingType('exclusive')}>Exclusive</button>
                </div>
                {form.mls_type !== 'exclusive'
                  ? <input style={{ marginTop: 6 }} value={form.mls_num} disabled={ro} onChange={(e) => set('mls_num', e.target.value.toUpperCase())} placeholder="e.g. E12345678" />
                  : <span className="pill type-pre" style={{ marginTop: 6, display: 'inline-block', padding: '6px 12px' }}>Exclusive Listing</span>}
                {listing && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', marginTop: 8, cursor: ro ? 'default' : 'pointer' }}>
                    <input type="radio" checked={!!form.mls_verified} disabled={ro} onClick={() => !ro && set('mls_verified', !form.mls_verified)} readOnly />
                    Mark Verified {form.mls_verified && <span className="pill ok" style={{ fontSize: 10 }}>Verified</span>}
                  </label>
                )}
              </Field>
              )}
              <Field label="Type">
                <select value={form.type} disabled={ro} onChange={(e) => onTypeChange(e.target.value)}>
                  {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <StatusMultiSelect options={statusOptions} selected={form.statuses} allowed={statusAllowed} disabled={ro} onToggle={toggleStatus} />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: referral ? '1fr 1.5fr 1fr' : '1fr 1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Agent Name">
                <input list="agentList" value={form.agent} disabled={ro} onChange={(e) => set('agent', e.target.value)} placeholder="Search Agent..." />
                <datalist id="agentList">{agents.map((a) => <option key={a} value={a} />)}</datalist>
              </Field>
              <Field label="Property Address" req><input value={form.property} disabled={ro} onChange={(e) => set('property', e.target.value)} /></Field>
              <Field label={isLease ? 'Total lease price' : 'Total Purchase Price'}><input value={form.price} disabled={ro} onChange={(e) => set('price', e.target.value)} /></Field>
              {!referral && <Field label="Deposit"><input value={form.deposit} disabled={ro} onChange={(e) => set('deposit', e.target.value)} /></Field>}
            </div>
            <div className="g3">
              <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: '#f9fafb' }} /></Field>
              {listing ? (<>
                <Field label="Listing Contract Date"><input type="date" value={form.listing_contract_date} disabled={ro} onChange={(e) => set('listing_contract_date', e.target.value)} /></Field>
                <Field label="Listing Expiry Date"><input type="date" value={form.listing_expiry_date} disabled={ro} onChange={(e) => set('listing_expiry_date', e.target.value)} /></Field>
              </>) : (<>
                <Field label="Offer Date"><input type="date" value={form.offer_date} disabled={ro} onChange={(e) => set('offer_date', e.target.value)} /></Field>
                <Field label="Closing Date"><input type="date" value={form.closing_date} disabled={ro} onChange={(e) => set('closing_date', e.target.value)} /></Field>
              </>)}
            </div>
          </div>

          {/* Quick Actions */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="modal-h" style={{ fontSize: 14 }}>Quick Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {canInvoice && isInvoiceableType(form.type) && (
                (txn?.invoices && txn.invoices.length > 0) ? (
                  <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setInvEditorId(txn.invoices[0].id)}>
                    🧾 View Invoice{txn.invoices.length === 1 ? '' : 's'} ({txn.invoices.length})
                  </button>
                ) : (
                  <button className="btn primary sm" style={{ textAlign: 'left' }} disabled={generating} onClick={generateInvoices}>
                    🧾 {generating ? 'Creating…' : (precon ? `Create Term Invoice${(parseInt(form.precon_term_count, 10) || 0) === 1 ? '' : 's'}` : 'Create Invoice')}
                  </button>
                )
              )}
              {canEdit && form.agent && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setTeamOpen(true)}>👥 Team Split</button>}
              {canEdit && !lawyerHidden && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setLawyerOpen(true)}>⚖ Lawyer Details</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setDocsOpen(true)}>📑 Legal &amp; Docs</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdminOpen(true)}>🔧 Admin</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFinOpen(true)}>💰 Financial</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdjOpen(true)}>⚖ Adjustment</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFaqOpen(true)}>📊 Agent FAQ Center</button>}
              <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAuditOpen(true)}>📜 Audit Trail</button>
              {!canEdit && <span className="help" style={{ margin: '4px 0 0' }}>Read-only access — editing actions are hidden.</span>}
            </div>
          </div>
        </div>

      {/* Commercial Lease calculator (structure / rent / commission) */}
      {commercialLease && <CommercialLeaseCard cl={cl} setCl={setCl} ro={ro} />}

      {/* Preconstruction details */}
      {precon && (
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Preconstruction Details</div>
          <div className="g3">
            <Field label="Listing Type">
              <select value={form.precon_listing_type} disabled={ro} onChange={(e) => set('precon_listing_type', e.target.value)}>
                <option value="mls">MLS</option><option value="builder">Builder</option>
              </select>
            </Field>
            <Field label="Commission Agent">
              <input list="agentList" value={form.commission_agent} disabled={ro} onChange={(e) => set('commission_agent', e.target.value)} placeholder="Search Agent..." />
            </Field>
            <Field label="Commission Receivable in Terms">
              <input type="number" min="0" max="200" value={form.precon_term_count} disabled={ro} onChange={(e) => set('precon_term_count', e.target.value)} placeholder="e.g. 3" />
            </Field>
          </div>
          {(() => {
            const tc = parseInt(form.precon_term_count, 10) || 0;
            if (tc <= 0) return null;
            return (
              <>
                <div className="modal-sub" style={{ marginTop: 4 }}>{tc === 1 ? 'Closing Date' : 'Closing Dates'}</div>
                <div className="g3">
                  {Array.from({ length: tc }, (_, i) => i + 1).map((k) => (
                    <Field key={k} label={tc === 1 ? 'Closing Date' : `Term ${k} Closing Date`}>
                      <input type="date" value={preconTermClosing(k)} disabled={ro} onChange={(e) => setPreconTermClosing(k, e.target.value)} />
                    </Field>
                  ))}
                </div>
              </>
            );
          })()}
          <span className="help">Set the number of terms and the closing date{(parseInt(form.precon_term_count, 10) || 0) === 1 ? '' : 's'} here; open <strong>Financial</strong> to enter each term's commission %.</span>
        </div>
      )}

      {/* Builder Information (precon) */}
      {precon && (
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Builder Information</div>
          <div className="g2">
            <Field label="Builder Name"><input value={form.builder.name} disabled={ro} onChange={(e) => setBuilder('name', e.target.value)} /></Field>
            <Field label="Vendor Name"><input value={form.builder.vendor} disabled={ro} onChange={(e) => setBuilder('vendor', e.target.value)} /></Field>
          </div>
          <div className="g2">
            <Field label="Project Name"><input value={form.builder.project} disabled={ro} onChange={(e) => setBuilder('project', e.target.value)} /></Field>
            <Field label="Address"><input value={form.builder.address} disabled={ro} onChange={(e) => setBuilder('address', e.target.value)} /></Field>
          </div>
          <div className="g3">
            <Field label="Builder Office Email"><input type="email" value={form.builder.office_email} disabled={ro} onChange={(e) => setBuilder('office_email', e.target.value)} /></Field>
            <Field label="Invoice Email"><input type="email" value={form.builder.invoice_email} disabled={ro} onChange={(e) => setBuilder('invoice_email', e.target.value)} /></Field>
            <Field label="Phone"><input value={form.builder.phone} disabled={ro} onChange={(e) => setBuilder('phone', e.target.value)} placeholder="+1 000-000-0000" /></Field>
          </div>
        </div>
      )}

      {/* Brokerage (hidden for preconstruction — Builder card replaces it) */}
      {!precon && (
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
      )}

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

      {/* Conditional Offer — hidden for preconstruction and referral */}
      {!precon && !referral && (
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
                {isLease ? (
                  /* Lease layout: free-text condition name, no Type column (fixed to Custom). */
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                    <Field label="Condition Name"><input value={c.custom_name || ''} disabled={ro} onChange={(e) => updCond(i, 'custom_name', e.target.value)} placeholder="Enter name" /></Field>
                    <Field label="Condition Deadline"><input type="date" value={c.deadline || ''} disabled={ro} onChange={(e) => updCond(i, 'deadline', e.target.value)} /></Field>
                    <Field label="Status">
                      <select value={c.status} disabled={ro} onChange={(e) => updCond(i, 'status', e.target.value)}>
                        <option>Pending</option><option>Waived</option><option>Fulfilled</option><option>Not Met</option>
                      </select>
                    </Field>
                    {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}>🗑️</button>}
                  </div>
                ) : (
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
                )}
              </div>
            ))}
            {!ro && <button className="btn primary sm" style={{ marginTop: 8 }} onClick={addCond}>+ Add Condition</button>}
          </div>
        )}
      </div>
      )}

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

      </div>

      {teamOpen && txn && (
        <TeamSplitModal
          open={teamOpen}
          onClose={() => setTeamOpen(false)}
          transactionId={id}
          primaryAgent={form.agent}
          initialTeam={txn.team}
          agents={agents}
          isPrecon={precon}
          termCount={parseInt(form.precon_term_count, 10) || 0}
          onSaved={applyUpdated}
        />
      )}
      {finOpen && txn && (
        <FinancialModal
          open={finOpen}
          onClose={() => setFinOpen(false)}
          transactionId={id}
          txn={txn}
          termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined}
          onSaved={applyUpdated}
        />
      )}
      {docsOpen && (
        <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} transactionId={id} />
      )}
      {invoiceOpen && txn && (
        <InvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} txn={txn} />
      )}
      {nosOpen && txn && (
        <NoticeOfSaleModal open={nosOpen} onClose={() => setNosOpen(false)} txn={txn} />
      )}
      {tsOpen && txn && (
        <TradeSheetModal open={tsOpen} onClose={() => setTsOpen(false)} txn={txn} />
      )}
      {lawyerOpen && txn && (
        <LawyerModal open={lawyerOpen} onClose={() => setLawyerOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} />
      )}
      {auditOpen && txn && (
        <AuditTrailModal open={auditOpen} onClose={() => setAuditOpen(false)} txn={txn} />
      )}
      {adminOpen && txn && (
        <AdminActivitiesModal open onClose={() => setAdminOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {faqOpen && txn && (
        <AgentFaqModal open onClose={() => setFaqOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {adjOpen && txn && (
        <AdjustmentModal open onClose={() => setAdjOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {chatOpen && (
        <ChatModal open onClose={() => setChatOpen(false)} transactionId={id} />
      )}
      {invEditorId !== undefined && (
        <InvoiceEditorModal
          open
          invoiceId={invEditorId}
          settings={invSettings}
          customers={invCustomers}
          agents={agents}
          onClose={() => setInvEditorId(undefined)}
          onBack={() => setInvEditorId(undefined)}
          onSaved={() => getTransaction(id).then(applyUpdated).catch(() => {})}
        />
      )}
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

// Multi-select Status dropdown. Collapses the status checklist into a dropdown
// while keeping the multi-status + grouping rules (allowed/blocked) intact.
// `Expired` is auto-set from the listing expiry date and can't be picked here.
function StatusMultiSelect({ options, selected, allowed, disabled, onToggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const label = selected.length ? selected.join(', ') : 'Select status';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: disabled ? '#f9fafb' : '#fff',
          fontSize: 13, color: selected.length ? 'var(--text)' : 'var(--muted)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {!disabled && <span style={{ color: 'var(--muted)', flexShrink: 0 }}>▾</span>}
      </button>
      {open && !disabled && (
        <div style={{ position: 'absolute', zIndex: 30, top: 'calc(100% + 4px)', left: 0, right: 0, background: '#fff',
          border: '1px solid var(--line)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 6, maxHeight: 260, overflowY: 'auto' }}>
          {options.map((s) => {
            const on = selected.includes(s);
            const auto = s === 'Expired'; // set automatically from listing expiry
            const blocked = !on && (auto || !allowed.includes(s));
            return (
              <label
                key={s}
                title={auto ? 'Set automatically from the listing expiry date' : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, fontSize: 13,
                  cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.4 : 1,
                  background: on ? 'var(--brand-soft, #eef2ff)' : 'transparent' }}
              >
                <input type="checkbox" checked={on} disabled={blocked} onChange={() => onToggle(s)} />{s}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
