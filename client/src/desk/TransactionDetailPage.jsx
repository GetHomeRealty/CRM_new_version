import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getTransaction, updateTransaction, listAgents, generateTransactionInvoices, getCompanySettings, getCustomers, getBrokerageSuggestions, requestTransactionEdit, approveEditRequest, rejectEditRequest, reviewAgentChanges, rejectAgentChange, requestTransactionDeletion, forwardDeleteRequest, approveDeleteRequest, rejectDeleteRequest, getDocuments } from '../lib/api';
import { typeClass, typeLabel, isListingType, isListingFinancialType, isListingStatusFamily, isPreconType, isCommercialLeaseType, isInvoiceableType, emailLooksValid, parseNumber, TRANSACTION_TYPES, formatCurrency, statusOptionsFor, normalizeStatus, defaultStatusFor } from './format';
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
import DepositReceiptModal from './DepositReceiptModal';
import LawyerStatementModal from './LawyerStatementModal';
import AutoComplete from './AutoComplete';
import ConfirmDialog from './ConfirmDialog';

const COND_TYPES = ['Financing', 'Home Inspection', 'Sale of Property', 'Status Certificate Review', 'Custom'];

// Listing types that also show Offer Date + Closing Date in Basic Info.
const OFFER_CLOSING_LISTING_TYPES = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
];

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
      : (defaultStatusFor(t.type) ? [defaultStatusFor(t.type)] : []),
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
  const { can, isSuperAdmin, isAdminOrAbove, user } = useAuth();
  const isAgent = user?.role === 'agent';
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
  const [depositOpen, setDepositOpen] = useState(false);   // listing-side: Deposit Receipt doc
  const [lawyerStmtOpen, setLawyerStmtOpen] = useState(false); // listing-side: Commission/Lawyer Statement doc
  const bodyRef = useRef(null);
  const [brokSuggestions, setBrokSuggestions] = useState([]);
  const [confirm, setConfirm] = useState(null); // delete-confirmation popup
  const [coreDocReminders, setCoreDocReminders] = useState([]); // §5.2 Active: pending core listing docs

  useEffect(() => {
    getTransaction(id).then((t) => { setForm(toForm(t)); setTxn(t); }).catch(() => toast('Could not load transaction', 'bad'));
    listAgents().then(setAgents).catch(() => {});
    // Loaded lazily so the invoice editor can open in-context on this page.
    getCompanySettings().then(setInvSettings).catch(() => {});
    getCustomers().then(setInvCustomers).catch(() => {});
    getBrokerageSuggestions().then(setBrokSuggestions).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // §5.2 — Active sale listings auto-remind about the core docs (Listing Agreement,
  // MLS Data Sheet, Client Photo IDs) while they are still pending.
  useEffect(() => {
    const isActiveSale = form && isListingStatusFamily(form.type) && !/lease/i.test(form.type) && (form.statuses || []).includes('Active');
    if (!isActiveSale) { setCoreDocReminders([]); return; }
    const core = ['listing agreement', 'mls data sheet', 'client photo'];
    getDocuments(id)
      .then((d) => setCoreDocReminders((d.documents || [])
        .filter((doc) => { const t = (doc.title || '').toLowerCase(); return core.some((k) => t.includes(k)) && doc.status !== 'Received'; })
        .map((doc) => doc.title)))
      .catch(() => setCoreDocReminders([]));
  }, [id, form?.type, (form?.statuses || []).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Founding team members (selected at creation, access='full') edit like the primary;
  // docs-only split members (added later) are view-only except for uploading documents.
  const myTeamAccess = txn?.my_team_access; // 'full' | 'docs' | null
  const isSplitViewerEarly = isAgent && form.agent !== user?.name && myTeamAccess !== 'full';
  const view = mode === 'view' || isSplitViewerEarly;
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
  const ro = view; // read-only flag

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setBrok = (k, v) => setForm((f) => ({ ...f, brokerage: { ...f.brokerage, [k]: v } }));
  // Selecting a saved brokerage fills only its contact details — never the agent
  // name(s), which differ per transaction.
  const pickBrokerage = (s) => setForm((f) => ({
    ...f,
    brokerage: {
      ...f.brokerage,
      name: s.name || '',
      address: s.address || f.brokerage.address,
      email: s.email || f.brokerage.email,
      invoice_email: s.invoice_email || f.brokerage.invoice_email,
      phone: s.phone || f.brokerage.phone,
    },
  }));
  // Typing (not just clicking a suggestion): when the name exactly matches a known
  // brokerage, fill any blank contact fields from it (agents are left untouched).
  const onBrokName = (v) => setForm((f) => {
    const next = { ...f, brokerage: { ...f.brokerage, name: v } };
    const match = brokSuggestions.find((s) => (s.name || '').trim().toLowerCase() === v.trim().toLowerCase());
    if (match) {
      next.brokerage = {
        ...next.brokerage,
        address: f.brokerage.address || match.address || '',
        email: f.brokerage.email || match.email || '',
        invoice_email: f.brokerage.invoice_email || match.invoice_email || '',
        phone: f.brokerage.phone || match.phone || '',
      };
    }
    return next;
  });
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
      // Any status may be selected freely (no grouping/transition restriction).
      let next = has ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
      if (next.length === 0) { const d = defaultStatusFor(f.type); next = d ? [d] : []; }
      return { ...f, statuses: next };
    });
  };

  // Changing type can switch status family — reset to that family's default status (empty for secured deal types).
  const onTypeChange = (newType) => setForm((f) => ({ ...f, type: newType, statuses: defaultStatusFor(newType) ? [defaultStatusFor(newType)] : [] }));

  // Delete confirmation: opens a popup describing the item and any linked
  // functionality before the row is removed (applied on Save).
  const askDelete = (opts) => setConfirm(opts);

  // clients
  const addClient = () => set('clients', [...form.clients, { name: '', email: '', phone: '' }]);
  const updClient = (i, k, v) => set('clients', form.clients.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmClient = (i) => askDelete({
    title: 'Delete client?',
    message: `Remove client "${form.clients[i]?.name || `#${i + 1}`}" from this transaction?`,
    linked: ['Notice of Sale buyers/sellers', 'Invoice customer details', 'Agent FAQ document clearance'],
    note: 'The change applies when you click Save on the transaction.',
    onConfirm: () => setForm((f) => ({ ...f, clients: f.clients.filter((_, idx) => idx !== i) })),
  });

  // conditions
  const addCond = () => set('conditions', [...form.conditions, { type: isLease ? 'Custom' : '', custom_name: '', deadline: '', status: 'Pending' }]);
  const updCond = (i, k, v) => set('conditions', form.conditions.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmCond = (i) => askDelete({
    title: 'Delete condition?',
    message: `Remove condition "${form.conditions[i]?.custom_name || form.conditions[i]?.type || `#${i + 1}`}"?`,
    linked: ['Its matching row in Legal & Documentation (and any files uploaded to it)', 'Document clearance / Final Validation in Agent FAQ'],
    note: 'The change applies when you click Save on the transaction.',
    onConfirm: () => setForm((f) => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) })),
  });

  // inter-board
  const addIb = () => set('inter_board_listings', [...form.inter_board_listings, { name: '', board_id: '', verified: false }]);
  const updIb = (i, k, v) => set('inter_board_listings', form.inter_board_listings.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const rmIb = (i) => askDelete({
    title: 'Delete inter-board listing?',
    message: `Remove inter-board listing "${form.inter_board_listings[i]?.name || `#${i + 1}`}"?`,
    linked: ['MLS / board verification on this transaction'],
    note: 'The change applies when you click Save on the transaction.',
    onConfirm: () => setForm((f) => ({ ...f, inter_board_listings: f.inter_board_listings.filter((_, idx) => idx !== i) })),
  });

  // brokerage agents
  const addBrokAgent = () => setBrok('agents', [...form.brokerage.agents, '']);
  const updBrokAgent = (i, v) => setBrok('agents', form.brokerage.agents.map((a, idx) => idx === i ? v : a));
  const rmBrokAgent = (i) => askDelete({
    title: 'Delete agent name?',
    message: `Remove agent "${form.brokerage.agents[i] || `#${i + 1}`}" from the brokerage?`,
    linked: ['Listing Agent Name(s) shown on Invoices, Notice of Sale, Deposit Receipt and Lawyer Statement'],
    note: 'The change applies when you click Save on the transaction.',
    onConfirm: () => setForm((f) => ({ ...f, brokerage: { ...f.brokerage, agents: f.brokerage.agents.filter((_, idx) => idx !== i) } })),
  });

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

  // §5.2 — Sale Listing status matrix (sale listings only; lease excluded).
  const saleListing = isListingStatusFamily(form.type) && !/lease/i.test(form.type);
  const stActive = saleListing && form.statuses.includes('Active');
  const stSoldCond = saleListing && form.statuses.includes('Sold Conditional');
  const stTerminated = saleListing && form.statuses.includes('Terminated');

  // §5.1 — deal-side Mutual Release / Void restrict the page to Legal & Docs only
  // (listing-family types are exempt). docRestrict limits which documents show.
  const dealSide = !isListingStatusFamily(form.type);
  const stVoid = dealSide && form.statuses.includes('Void');
  const stMutualRelease = dealSide && form.statuses.includes('Mutual Release');
  const stSecuredFirm = form.statuses.includes('Secured Firm'); // hides Conditional Offer
  const docsOnly = stVoid || stMutualRelease;
  const docRestrict = stVoid
    ? ['agreement of purchase', 'aps', 'agreement to lease']
    : stMutualRelease ? ['agreement of purchase', 'aps', 'agreement to lease', 'mutual release', 'deposit receipt']
      : stActive ? ['listing agreement', 'mls data sheet', 'client photo', 'fintrac']
        : stTerminated ? ['listing agreement', 'mls data sheet', 'client photo', 'fintrac', 'cancellation']
          : null;

  const slDepositOnly = stActive || stSoldCond; // Admin: deposit only · FAQ: deposit slip only · Financial: hide client/commission
  const slHideBasic = stActive || stTerminated; // hide Offer/Closing dates, Co-op Brokerage, Conditional Offer
  const slHideLawyer = stActive || stSoldCond || stTerminated;
  const slMarkVerifiedHidden = stActive || stTerminated; // Sold Conditional / Sold keep Mark Verified
  const slNoSections = stTerminated; // no Admin / Financial / Agent FAQ; hide Team Split

  // §5.1 — DFT / Closed lock direct edits; Admins request, Super Admin approves.
  const stClosed = form.statuses.includes('Closed');
  const stDFT = form.statuses.includes('DFT');
  const editLocked = stClosed || stDFT;
  const lockedForUser = editLocked && !isSuperAdmin;

  // Agent portal — full access (primary OR founding team member) vs docs-only member.
  const isOwnerAgent = isAgent && form.agent === user?.name;
  const isFullAgent = isAgent && (isOwnerAgent || myTeamAccess === 'full');
  const isSplitViewer = isAgent && !isFullAgent;
  // A full-access agent (primary or founding member) or an admin may edit the team split.
  const teamSplitEditableByRole = !isAgent || isFullAgent;

  // §6 — lifecycle locks layered on top of status rules.
  const nosSent = !!txn?.notice_of_sale?.sent_at; // Notice of Sale sent for signing
  const agentPaid = txn?.activity_tracker?.agent_commission_paid_status === 'Yes' || txn?.comm_paid_status === 'Yes'; // agent payment complete
  // Team Split: hidden entirely once agent payment is complete (Super Admin only);
  // after Notice of Sale is sent, agents can't be added/removed/renamed (Admin+ retain access).
  const teamSplitVisible = !agentPaid || isSuperAdmin;
  const teamReadOnly = view || (agentPaid && !isSuperAdmin) || !teamSplitEditableByRole;
  const teamLockAgents = nosSent && !isAdminOrAbove && !agentPaid;
  // Adjustment / advance / client referral / external brokerage referral: fully locked once agent payment is complete.
  const adjReadOnly = view || agentPaid;
  const editRequests = txn?.edit_requests || [];
  const pendingReq = editRequests.find((r) => r.status === 'pending');
  const approvedReq = editRequests.find((r) => r.status === 'approved');
  const reloadTxn = () => getTransaction(id).then(applyUpdated).catch(() => {});
  const onRequestEdit = async () => {
    const reason = window.prompt('Reason for the edit request (optional):');
    if (reason === null) return;
    try { await requestTransactionEdit(id, reason); toast('Edit request sent for Super Admin approval', 'ok'); reloadTxn(); }
    catch (e) { toast(e.response?.data?.message || 'Could not send request', 'bad'); }
  };
  const onApproveReq = async (reqId) => { try { await approveEditRequest(reqId); toast('Edit approved', 'ok'); reloadTxn(); } catch { toast('Could not approve', 'bad'); } };
  const onRejectReq = async (reqId) => { try { await rejectEditRequest(reqId); toast('Edit rejected', 'ok'); reloadTxn(); } catch { toast('Could not reject', 'bad'); } };

  // Transaction deletion approval workflow.
  const deleteReq = txn?.delete_request || null;
  const onRequestDelete = async () => {
    const reason = window.prompt('Reason for requesting this transaction be deleted:');
    if (reason === null) return;
    if (!reason.trim()) { toast('A reason is required', 'bad'); return; }
    try { await requestTransactionDeletion(id, reason.trim()); toast('Deletion request sent to Admin', 'ok'); reloadTxn(); }
    catch (e) { toast(e.response?.data?.message || 'Could not send request', 'bad'); }
  };
  const onForwardDelete = async () => {
    const reason = window.prompt('Reason to forward this deletion to a Super Admin (optional):');
    if (reason === null) return;
    try { await forwardDeleteRequest(deleteReq.id, reason); toast('Forwarded to Super Admin', 'ok'); reloadTxn(); }
    catch (e) { toast(e.response?.data?.message || 'Could not forward', 'bad'); }
  };
  const onApproveDelete = async () => {
    if (!window.confirm('Approve and permanently delete this transaction?')) return;
    try { await approveDeleteRequest(deleteReq.id); toast('Transaction deleted', 'ok'); navigate('/app/transactions'); }
    catch (e) { toast(e.response?.data?.message || 'Could not delete', 'bad'); }
  };
  const onRejectDelete = async () => {
    try { await rejectDeleteRequest(deleteReq.id); toast('Deletion request rejected', 'ok'); reloadTxn(); }
    catch (e) { toast(e.response?.data?.message || 'Could not reject', 'bad'); }
  };

  // Per-transaction banner: agent-made changes an admin hasn't reviewed yet.
  const agentChanges = txn?.agent_changes || [];
  const onReviewAgentChanges = async () => {
    try { const updated = await reviewAgentChanges(id); applyUpdated(updated); toast('Marked as reviewed', 'ok'); }
    catch (e) { toast(e.response?.data?.message || 'Could not update', 'bad'); }
  };
  const onRejectAgentChange = async (auditId) => {
    try { const updated = await rejectAgentChange(id, auditId); applyUpdated(updated); toast('Change rejected — old value restored', 'ok'); }
    catch (e) { toast(e.response?.data?.message || 'Could not reject', 'bad'); }
  };

  return (
    <>
      <div className="detail-head" style={{ position: 'sticky', top: 60, zIndex: 30 }}>
        <button className="btn ghost sm" onClick={() => navigate('/app/transactions')}>← Back</button>
        <div className="detail-title">
          <strong>{form.property || 'Untitled'}</strong>
          <span className={`pill ${typeClass(form.type)}`}>{typeLabel(form.type)}</span>
          {form.statuses.map((s) => <span key={s} className={`pill ${stPill(s)}`}>{s}</span>)}
          <span className={`pill ${view ? 'info' : 'warn'}`} style={{ fontSize: 10 }}>{view ? '🔒 View Only' : '✏ Edit Mode'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Invoice / Trade Sheet / Notice of Sale are hidden for agents. */}
          {!isAgent && (isListingFinancialType(form.type) ? (<>
            <button className="btn ghost sm" onClick={() => setDepositOpen(true)}>🧾 Deposit Receipt</button>
            <button className="btn ghost sm" onClick={() => setLawyerStmtOpen(true)}>📄 Lawyer Statement</button>
          </>) : (
            !docsOnly && <button className="btn ghost sm" onClick={openInvoice}>🧾 Invoice</button>
          ))}
          {!isAgent && !docsOnly && <button className="btn ghost sm" onClick={() => setTsOpen(true)}>📋 Trade Sheet</button>}
          {!isAgent && !docsOnly && <button className="btn ghost sm" onClick={() => setNosOpen(true)}>📄 Notice of Sale</button>}
          <button className="btn ghost sm" onClick={() => setChatOpen(true)}>💬 Chat</button>
          <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} />
          {!canEdit
            ? <span className="pill info" style={{ fontSize: 10 }}>Read-only access</span>
            : isSplitViewer
            ? <span className="pill info" style={{ fontSize: 10 }} title="Shared with you via team split — view only">👁 Shared — view only</span>
            : stClosed && !isSuperAdmin
            ? <span className="pill" style={{ fontSize: 10, background: '#fee2e2', color: '#9a3412', border: '1px solid #fecaca' }} title="This transaction is Closed — only a Super Admin can edit it.">🔒 Closed — Super Admin only</span>
            : lockedForUser && !approvedReq
            ? (<>
                <button className="btn primary sm" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }} title="Locked (DFT) — edits need Super Admin approval">✏ Edit</button>
                {isAdminOrAbove && !pendingReq && <button className="btn ghost sm" onClick={onRequestEdit}>🔓 Request Edit</button>}
                {pendingReq && <span className="pill warn" style={{ fontSize: 10 }}>Awaiting approval</span>}
              </>)
            : view
            ? <button className="btn primary sm" onClick={() => setMode('edit')}>✏ Edit{lockedForUser && approvedReq ? ' (approved)' : ''}</button>
            : (<>
                <button className="btn ghost sm" onClick={() => setMode('view')}>Cancel</button>
                <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
              </>)}
          {/* Agents request deletion (their own deals); admins/super admins delete via the workflow banner. */}
          {isFullAgent && !deleteReq && <button className="btn ghost sm" style={{ color: '#dc2626' }} onClick={onRequestDelete}>🗑 Request Deletion</button>}
        </div>
      </div>

      {/* Closed — fully locked: only a Super Admin may edit (no request workflow). */}
      {stClosed && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fff7ed' }}>
          <div style={{ fontWeight: 700, color: '#9a3412' }}>🔒 Closed — the transaction is locked.</div>
          <div style={{ fontSize: 12.5, color: '#7c2d12', marginTop: 2 }}>
            {isSuperAdmin ? 'You have Super Admin access and can edit this transaction.' : 'No editing is permitted on a Closed transaction. Only a Super Admin can make changes.'}
          </div>
        </div>
      )}

      {/* §5.1 — DFT edit-approval banner (Admins request; Super Admin approves). */}
      {stDFT && !stClosed && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fff7ed' }}>
          <div style={{ fontWeight: 700, color: '#9a3412' }}>🔒 DFT — direct edits are locked.</div>
          <div style={{ fontSize: 12.5, color: '#7c2d12', marginTop: 2 }}>
            {isSuperAdmin ? 'You can edit directly, or review Admin edit requests below.' : 'Admins must request an edit; a Super Admin approves before changes can be saved.'}
          </div>
          {pendingReq && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5 }}><strong>Pending:</strong> {pendingReq.requested_by_name}{pendingReq.reason ? ` — ${pendingReq.reason}` : ''}</span>
              {isSuperAdmin && <><button className="btn primary sm" onClick={() => onApproveReq(pendingReq.id)}>Approve</button><button className="btn ghost sm" onClick={() => onRejectReq(pendingReq.id)}>Reject</button></>}
            </div>
          )}
          {approvedReq && <div className="help" style={{ marginTop: 6, color: '#166534' }}>✓ Edit approved by {approvedReq.reviewed_by_name} — changes can now be saved.</div>}
        </div>
      )}

      {/* Transaction deletion approval workflow banner. */}
      {deleteReq && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fef2f2' }}>
          <div style={{ fontWeight: 700, color: '#991b1b' }}>🗑 Deletion {deleteReq.status === 'forwarded' ? 'forwarded to Super Admin' : 'requested'}</div>
          <div style={{ fontSize: 12.5, color: '#7f1d1d', marginTop: 2 }}>
            Requested by {deleteReq.requested_by_name}{deleteReq.reason ? ` — “${deleteReq.reason}”` : ''}
            {deleteReq.status === 'forwarded' && deleteReq.forwarded_by_name ? ` · Forwarded by ${deleteReq.forwarded_by_name}${deleteReq.forward_reason ? ` — “${deleteReq.forward_reason}”` : ''}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {/* Admin (not super): forward a pending request; reject. */}
            {isAdminOrAbove && !isSuperAdmin && deleteReq.status === 'pending' && (<>
              <button className="btn primary sm" onClick={onForwardDelete}>Send to Super Admin</button>
              <button className="btn ghost sm" onClick={onRejectDelete}>Reject</button>
            </>)}
            {isAdminOrAbove && !isSuperAdmin && deleteReq.status === 'forwarded' && (
              <span className="pill warn" style={{ fontSize: 10 }}>Awaiting Super Admin approval</span>
            )}
            {/* Super Admin: approve (deletes) or reject at any stage. */}
            {isSuperAdmin && (<>
              <button className="btn sm" style={{ background: '#dc2626', color: '#fff' }} onClick={onApproveDelete}>Approve &amp; Delete</button>
              <button className="btn ghost sm" onClick={onRejectDelete}>Reject</button>
            </>)}
            {isAgent && <span className="pill warn" style={{ fontSize: 10 }}>Your deletion request is {deleteReq.status === 'forwarded' ? 'with the Super Admin' : 'pending admin review'}</span>}
          </div>
        </div>
      )}

      {/* Agent changes awaiting admin review (admins only). */}
      {isAdminOrAbove && agentChanges.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #d97706', background: '#fffbeb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, color: '#92400e' }}>🔔 {agentChanges.length} change{agentChanges.length === 1 ? '' : 's'} by the agent — please review</div>
            <button className="btn primary sm" onClick={onReviewAgentChanges}>✓ Mark reviewed</button>
          </div>
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {agentChanges.map((c, idx) => (
              <div key={c.id ?? idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#7c2d12', padding: '5px 0', borderTop: idx ? '1px solid #fde68a' : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{c.section ? `${c.section} — ` : ''}{c.field || c.action}</strong>
                  {(c.old_value || c.new_value) && <span> : <span style={{ color: '#991b1b' }}>{c.old_value || '—'}</span> → <span style={{ color: '#166534' }}>{c.new_value || '—'}</span></span>}
                  <span style={{ color: 'var(--muted)' }}> · {c.who}{c.stamp ? ` · ${c.stamp}` : ''}</span>
                </div>
                {c.id && <button className="btn ghost sm" style={{ flexShrink: 0, color: '#991b1b' }} title="Reject this change and restore the old value" onClick={() => onRejectAgentChange(c.id)}>↩ Reject</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* §5.2 — Active sale listing: reminder for pending core documents */}
      {stActive && coreDocReminders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #d97706', background: '#fffbeb' }}>
          <div style={{ fontWeight: 700, color: '#92400e' }}>⏰ Reminder — core listing documents pending</div>
          <div style={{ fontSize: 12.5, color: '#78350f', marginTop: 2 }}>
            The following must be received to complete the Active listing:
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5, color: '#78350f' }}>
            {coreDocReminders.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => setDocsOpen(true)}>📁 Open Legal &amp; Documentation</button>
          </div>
        </div>
      )}

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

      <div ref={bodyRef}>
        <div className="detail-2col">
          {/* Basic Info */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="modal-h" style={{ fontSize: 14 }}>Basic Info</div>
            <div style={{ display: 'grid', gridTemplateColumns: referral ? '1.2fr 1.6fr' : (OFFER_CLOSING_LISTING_TYPES.includes(form.type) ? '1.7fr 1.1fr 1fr 1fr' : '1.1fr 1.2fr 1.6fr'), gap: 12, marginBottom: 12 }}>
              {!referral && (
              <Field label={OFFER_CLOSING_LISTING_TYPES.includes(form.type) && form.mls_type !== 'exclusive' && !slMarkVerifiedHidden ? (
                <span style={{ whiteSpace: 'nowrap' }}>Listing Type{' '}
                  <span role="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!ro) set('mls_verified', !form.mls_verified); }}
                    style={{ cursor: ro ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, textTransform: 'none', padding: '2px 8px', borderRadius: 6, border: `1px solid ${form.mls_verified ? '#16a34a' : '#c8102e'}`, color: form.mls_verified ? '#16a34a' : '#c8102e', background: form.mls_verified ? '#f0fdf4' : '#fff1f2' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', border: '1px solid currentColor', background: form.mls_verified ? 'currentColor' : 'transparent', display: 'inline-block', flexShrink: 0 }} />{form.mls_verified ? 'Verified' : 'Mark Verified'}
                  </span>
                </span>
              ) : 'Listing Type'}>
                <div className="seg-toggle">
                  <button type="button" className={`seg-btn ${form.mls_type !== 'exclusive' ? 'active' : ''}`} disabled={ro} onClick={() => setListingType('mls')}>MLS</button>
                  <button type="button" className={`seg-btn ${form.mls_type === 'exclusive' ? 'active' : ''}`} disabled={ro} onClick={() => setListingType('exclusive')}>Exclusive</button>
                </div>
                {form.mls_type !== 'exclusive'
                  ? <input style={{ marginTop: 6 }} value={form.mls_num} disabled={ro} onChange={(e) => set('mls_num', e.target.value.toUpperCase())} placeholder="e.g. E12345678" />
                  : <span className="pill type-pre" style={{ marginTop: 6, display: 'inline-block', padding: '6px 12px' }}>Exclusive Listing</span>}
                {listing && !OFFER_CLOSING_LISTING_TYPES.includes(form.type) && form.mls_type !== 'exclusive' && !slMarkVerifiedHidden && (
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
                <StatusMultiSelect options={statusOptions} selected={form.statuses} disabled={ro} onToggle={toggleStatus} />
              </Field>
              {OFFER_CLOSING_LISTING_TYPES.includes(form.type) && (
                <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: '#f9fafb' }} /></Field>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: referral ? '1fr 1.5fr 1fr' : '1fr 1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Agent Name">
                {isAgent
                  ? <input value={form.agent} readOnly style={{ background: '#f9fafb', cursor: 'not-allowed' }} title="The agent who creates the transaction is its primary agent." />
                  : (<>
                    <input list="agentList" value={form.agent} disabled={ro} onChange={(e) => set('agent', e.target.value)} placeholder="Search Agent..." />
                    <datalist id="agentList">{agents.map((a) => <option key={a} value={a} />)}</datalist>
                  </>)}
              </Field>
              <Field label="Property Address" req><input value={form.property} disabled={ro} onChange={(e) => set('property', e.target.value)} /></Field>
              <Field label={isLease ? 'Total lease price' : 'Total Purchase Price'}><input value={form.price} disabled={ro} onChange={(e) => set('price', e.target.value)} /></Field>
              {!referral && <Field label="Deposit"><input value={form.deposit} disabled={ro} onChange={(e) => set('deposit', e.target.value)} /></Field>}
            </div>
            {!OFFER_CLOSING_LISTING_TYPES.includes(form.type) && (
              <div className="g3">
                <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: '#f9fafb' }} /></Field>
                {listing && (<>
                  <Field label="Listing Contract Date"><input type="date" value={form.listing_contract_date} disabled={ro} onChange={(e) => set('listing_contract_date', e.target.value)} /></Field>
                  <Field label="Listing Expiry Date"><input type="date" value={form.listing_expiry_date} disabled={ro} onChange={(e) => set('listing_expiry_date', e.target.value)} /></Field>
                </>)}
                {!listing && (<>
                  <Field label="Offer Date"><input type="date" value={form.offer_date} disabled={ro} onChange={(e) => set('offer_date', e.target.value)} /></Field>
                  <Field label="Closing Date"><input type="date" value={form.closing_date} disabled={ro} onChange={(e) => set('closing_date', e.target.value)} /></Field>
                </>)}
              </div>
            )}
            {OFFER_CLOSING_LISTING_TYPES.includes(form.type) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginTop: 12 }}>
                <Field label="Listing Contract Date"><input type="date" value={form.listing_contract_date} disabled={ro} onChange={(e) => set('listing_contract_date', e.target.value)} /></Field>
                <Field label="Listing Expiry Date"><input type="date" value={form.listing_expiry_date} disabled={ro} onChange={(e) => set('listing_expiry_date', e.target.value)} /></Field>
                {!slHideBasic && <Field label="Offer Date"><input type="date" value={form.offer_date} disabled={ro} onChange={(e) => set('offer_date', e.target.value)} /></Field>}
                {!slHideBasic && <Field label="Closing Date"><input type="date" value={form.closing_date} disabled={ro} onChange={(e) => set('closing_date', e.target.value)} /></Field>}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="modal-h" style={{ fontSize: 14 }}>Quick Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!isAgent && !docsOnly && canInvoice && isInvoiceableType(form.type) && !['Residential Buying', 'Residential Lease'].includes(form.type) && !(txn?.invoices && txn.invoices.length > 0) && (
                <button className="btn primary sm" style={{ textAlign: 'left' }} disabled={generating} onClick={generateInvoices}>
                  🧾 {generating ? 'Creating…' : (precon ? `Create Term Invoice${(parseInt(form.precon_term_count, 10) || 0) === 1 ? '' : 's'}` : 'Create Invoice')}
                </button>
              )}
              {!docsOnly && !slNoSections && canEdit && form.agent && teamSplitVisible && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setTeamOpen(true)}>👥 Team Split</button>}
              {!docsOnly && !slHideLawyer && canEdit && !lawyerHidden && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setLawyerOpen(true)}>⚖ Lawyer Details</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setDocsOpen(true)}>📑 Legal &amp; Docs</button>}
              {/* Admin Activities, Adjustment and Audit Trail are admin-only (hidden from agents). */}
              {!isAgent && !docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdminOpen(true)}>🔧 Admin</button>}
              {!docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFinOpen(true)}>💰 Financial</button>}
              {!isAgent && !docsOnly && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdjOpen(true)}>⚖ Adjustment</button>}
              {!docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFaqOpen(true)}>📊 Agent FAQ Center</button>}
              {!isAgent && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAuditOpen(true)}>📜 Audit Trail</button>}
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

      {/* Brokerage (hidden for preconstruction — Builder card replaces it; §5.2 hides Co-op Brokerage for Active/Terminated sale listings) */}
      {!precon && !slHideBasic && (
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>{brokLabel} Brokerage Information</div>
        <Field label={`${brokLabel} Brokerage Name`}>
          <AutoComplete
            value={form.brokerage.name} disabled={ro} onChange={onBrokName} onPick={pickBrokerage}
            options={brokSuggestions} getLabel={(s) => s.name}
            getSub={(s) => [s.address, s.phone].filter(Boolean).join(' · ')}
            placeholder="Brokerage name"
          />
        </Field>
        {(() => {
          const manyAgents = form.brokerage.agents.length >= 4; // 4+ agents → Address on its own row
          return (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'start' }}>
                {form.brokerage.agents.map((a, i) => (
                  <div className="field" key={i} style={{ flex: '0 0 calc(20% - 10px)', marginBottom: 0 }}>
                    <label>{i === 0 ? `${brokLabel} Agent Name(s)` : `Agent ${i + 1}`}</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input value={a} disabled={ro} onChange={(e) => updBrokAgent(i, e.target.value)} placeholder="Agent name..." style={{ minWidth: 0 }} />
                      {!ro && form.brokerage.agents.length > 1 && <button className="row-rm" onClick={() => rmBrokAgent(i)}>🗑️</button>}
                    </div>
                  </div>
                ))}
                {!manyAgents && (
                  <div className="field" style={{ flex: '1 1 0', minWidth: 0, marginBottom: 0 }}>
                    <label>Brokerage Address</label>
                    <input value={form.brokerage.address} disabled={ro} onChange={(e) => setBrok('address', e.target.value)} />
                  </div>
                )}
              </div>
              {!ro && <button className="btn primary sm" style={{ marginTop: 6, marginBottom: manyAgents ? 6 : 12 }} onClick={addBrokAgent}>+ Add Agent</button>}
              {manyAgents && <Field label="Brokerage Address" style={{ marginBottom: 12 }}><input value={form.brokerage.address} disabled={ro} onChange={(e) => setBrok('address', e.target.value)} /></Field>}
            </>
          );
        })()}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <Field label="Brokerage Email"><input type="email" value={form.brokerage.email} disabled={ro} onChange={(e) => setBrok('email', e.target.value)} /></Field>
          <Field label="Invoice Email"><input type="email" value={form.brokerage.invoice_email} disabled={ro} onChange={(e) => setBrok('invoice_email', e.target.value)} /></Field>
          <Field label="Agent Email"><input type="email" value={form.brokerage.agent_email} disabled={ro} onChange={(e) => setBrok('agent_email', e.target.value)} /></Field>
          <Field label="Phone Number"><input value={form.brokerage.phone} disabled={ro} onChange={(e) => setBrok('phone', e.target.value)} placeholder="+1 000-000-0000" /></Field>
        </div>
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

      {/* Conditional Offer — hidden for preconstruction, referral, §5.2 Active/Terminated sale listings, Void / Mutual Release, and Secured Firm */}
      {!precon && !referral && !slHideBasic && !docsOnly && !stSecuredFirm && (
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
                  /* Lease layout: free-text condition name, no Type column (fixed to Custom).
                     Box sizing matches the Residential Buying conditional-offer box. */
                  <div style={{ display: 'grid', gridTemplateColumns: '320px 160px 160px auto 1fr', gap: 8, alignItems: 'end' }}>
                    <Field label="Condition Name"><input value={c.custom_name || ''} disabled={ro} onChange={(e) => updCond(i, 'custom_name', e.target.value)} placeholder="Enter name" /></Field>
                    <Field label="Condition Deadline"><input type="date" value={c.deadline || ''} disabled={ro} onChange={(e) => updCond(i, 'deadline', e.target.value)} /></Field>
                    <Field label="Status">
                      <select value={c.status} disabled={ro} onChange={(e) => updCond(i, 'status', e.target.value)}>
                        <option>Pending</option><option>Waived</option><option>Fulfilled</option><option>Not Met</option>
                      </select>
                    </Field>
                    {!ro && !isAgent && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}>🗑️</button>}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: c.type === 'Custom' ? '320px 320px 160px 160px auto 1fr' : '320px 160px 160px auto 1fr', gap: 8, alignItems: 'end' }}>
                    <Field label="Type">
                      <select value={c.type} disabled={ro} onChange={(e) => updCond(i, 'type', e.target.value)}>
                        <option value="">Select type</option>
                        {/* No duplicate condition types — hide types already chosen in other rows (Custom may repeat). */}
                        {COND_TYPES.filter((t) => t === 'Custom' || t === c.type || !form.conditions.some((x, idx) => idx !== i && x.type === t)).map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </Field>
                    {c.type === 'Custom' && <Field label="Custom Name"><input value={c.custom_name || ''} disabled={ro} onChange={(e) => updCond(i, 'custom_name', e.target.value)} /></Field>}
                    <Field label="Deadline"><input type="date" value={c.deadline || ''} disabled={ro} onChange={(e) => updCond(i, 'deadline', e.target.value)} /></Field>
                    <Field label="Status">
                      <select value={c.status} disabled={ro} onChange={(e) => updCond(i, 'status', e.target.value)}>
                        <option>Pending</option><option>Waived</option><option>Fulfilled</option><option>Not Met</option>
                      </select>
                    </Field>
                    {!ro && !isAgent && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}>🗑️</button>}
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
          isLease={isLease}
          termCount={parseInt(form.precon_term_count, 10) || 0}
          onSaved={applyUpdated}
          readOnly={teamReadOnly}
          lockAgents={teamLockAgents}
          isAgent={isAgent}
          canManageAccess={!isAgent || isOwnerAgent}
        />
      )}
      {finOpen && txn && (
        <FinancialModal
          open={finOpen}
          onClose={() => setFinOpen(false)}
          transactionId={id}
          txn={txn}
          termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined}
          hideClientCommission={slDepositOnly}
          dftNA={stDFT}
          readOnly={view || isAgent}
          isAgent={isAgent}
          onSaved={applyUpdated}
        />
      )}
      {docsOpen && (
        <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} transactionId={id} restrictTitles={docRestrict} hideTitles={stMutualRelease ? [] : ['mutual release']} readOnly={isAgent ? false : view} agentMode={isAgent} canDeleteConditionDocs={isSuperAdmin} canReviewDeleted={isAdminOrAbove} />
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
        <LawyerModal open={lawyerOpen} onClose={() => setLawyerOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} readOnly={view} isAgent={isAgent} />
      )}
      {auditOpen && txn && (
        <AuditTrailModal open={auditOpen} onClose={() => setAuditOpen(false)} txn={txn} />
      )}
      {adminOpen && txn && (
        <AdminActivitiesModal open onClose={() => setAdminOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} depositOnly={slDepositOnly} dftNA={stDFT} readOnly={view} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {faqOpen && txn && (
        <AgentFaqModal open onClose={() => setFaqOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} depositSlipOnly={slDepositOnly} dftNA={stDFT} readOnly={view || isAgent} allowBatchEmail={isAgent} isAgent={isAgent} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {adjOpen && txn && (
        <AdjustmentModal open onClose={() => setAdjOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} readOnly={adjReadOnly} termCount={precon ? (parseInt(form.precon_term_count, 10) || 0) : undefined} />
      )}
      {chatOpen && (
        <ChatModal open onClose={() => setChatOpen(false)} transactionId={id} />
      )}
      {depositOpen && txn && (
        <DepositReceiptModal open onClose={() => setDepositOpen(false)} txn={txn} />
      )}
      {lawyerStmtOpen && txn && (
        <LawyerStatementModal open onClose={() => setLawyerStmtOpen(false)} txn={txn} settings={invSettings} />
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
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
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
function StatusMultiSelect({ options, selected, disabled, onToggle }) {
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
            const blocked = !on && auto; // only Expired is locked (auto-managed); all others selectable
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
