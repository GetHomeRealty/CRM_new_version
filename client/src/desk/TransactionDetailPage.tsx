import { deskPath } from './area';
import Icon from '../ui/Icon';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getTransaction, updateTransaction, listAgents, generateTransactionInvoices, getCompanySettings, getCustomers, getBrokerageSuggestions, requestTransactionEdit, approveEditRequest, rejectEditRequest, reviewAgentChanges, rejectAgentChange, requestTransactionDeletion, forwardDeleteRequest, approveDeleteRequest, rejectDeleteRequest, getDocuments, markTransactionReviewsSeen, bulkReviewAction, type OpenReviewItem } from '../lib/api';
import ReviewHistoryPanel from './ReviewHistoryPanel';
import { typeClass, typeLabel, isListingType, isListingFinancialType, isListingStatusFamily, isPreconType, isCommercialLeaseType, isInvoiceableType, emailLooksValid, phoneLooksValid, parseNumber, TRANSACTION_TYPES, statusOptionsFor, normalizeStatus, defaultStatusFor } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import TeamSplitModal from './TeamSplitModal';
import FinancialModal from './FinancialModal';
import DocsModal from './DocsModal';
import InvoiceModal from './InvoiceModal';
import NoticeOfSaleModal from './NoticeOfSaleModal';
import TradeSheetModal from './TradeSheetModal';
import MoneyInput from './MoneyInput';
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
import ConfirmDialog, { type ConfirmOptions } from './ConfirmDialog';
import type { BrokerageSuggestion, CompanySettings, Transaction } from '../types';

const COND_TYPES = ['Financing', 'Home Inspection', 'Sale of Property', 'Status Certificate Review', 'Custom'];

// Listing types that also show Offer Date + Closing Date in Basic Info.
const OFFER_CLOSING_LISTING_TYPES = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
];

interface ClientRow { id?: number; name: string; email?: string | null; phone?: string | null; }
interface ConditionRow { id?: number; type: string; custom_name?: string | null; deadline?: string | null; status: string; }
interface InterBoardRow { id?: number; name?: string; board_id?: string; verified?: boolean; }
interface BrokerageForm { name: string; address: string; email: string; invoice_email: string; agent_email: string; phone: string; agents: string[]; }
interface BuilderForm { name: string; vendor: string; project: string; address: string; office_email: string; invoice_email: string; phone: string; }
interface PreconTermForm { term_no: number; pct: number | null; closing_date: string; }
interface DetailForm {
  id: number;
  trade_no: number | string;
  type: string;
  property: string;
  agent: string;
  price: number | string;
  deposit: number | string;
  offer_date: string;
  closing_date: string;
  listing_contract_date: string;
  listing_expiry_date: string;
  mls_type: string;
  mls_num: string;
  mls_verified: boolean;
  conditional_offer: boolean;
  inter_board_enabled: boolean;
  statuses: string[];
  clients: ClientRow[];
  conditions: ConditionRow[];
  inter_board_listings: InterBoardRow[];
  brokerage: BrokerageForm;
  precon_listing_type: string;
  precon_term_count: number | string;
  commission_agent: string;
  builder: BuilderForm;
  commercial_lease: Record<string, unknown> | null;
  precon_terms: PreconTermForm[];
}

function toForm(t: Transaction): DetailForm {
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
    clients: (t.clients || []).map((c) => ({ ...c, name: c.name || '' })),
    conditions: (t.conditions || []).map((c) => ({ ...c, type: c.type || '', status: c.status || 'Pending' })),
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

const dOrNull = (v: string | null | undefined) => (v && v.trim() ? v : null);

/**
 * The exact PUT body for a form. Shared by the manual Save and the auto-save so the
 * two can never drift — an auto-save that wrote a different shape than Save would be
 * far worse than no auto-save at all.
 */
function buildPayload(form: DetailForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: form.type, property: form.property, agent: form.agent || null,
    price: parseNumber(form.price), deposit: parseNumber(form.deposit),
    offer_date: dOrNull(form.offer_date), closing_date: dOrNull(form.closing_date),
    listing_contract_date: dOrNull(form.listing_contract_date), listing_expiry_date: dOrNull(form.listing_expiry_date),
    mls_type: form.mls_type, mls_num: form.mls_num || null, mls_verified: form.mls_verified,
    conditional_offer: form.conditional_offer, inter_board_enabled: form.inter_board_enabled,
    statuses: form.statuses,
    clients: form.clients.map((c) => ({ name: c.name, email: c.email || null, phone: c.phone || null })),
    /*
     * TD-065 — the spare row is not sent until it is filled in.
     *
     * "+ Add Condition" appends an empty row for the next entry, and the whole list went up on
     * save, so one condition entered was stored as two — the second nameless, and given a document
     * titled "Condition: " that nobody could ever satisfy. The API drops such rows now, which is
     * where the rule has to live; this keeps the request honest about what was actually entered
     * instead of sending something to be discarded.
     */
    conditions: form.conditional_offer
      ? form.conditions
        .filter((c) => (c.type || '').trim() !== '' || (c.custom_name || '').trim() !== '')
        .map((c) => ({ id: c.id, type: c.type, custom_name: c.custom_name || null, deadline: dOrNull(c.deadline), status: c.status }))
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
  if (isPreconType(form.type)) {
    payload.precon_listing_type = form.precon_listing_type;
    payload.precon_term_count = form.precon_term_count === '' ? null : parseInt(String(form.precon_term_count), 10);
    payload.commission_agent = form.commission_agent || null;
    payload.builder = {
      name: form.builder.name || null, vendor: form.builder.vendor || null, project: form.builder.project || null,
      address: form.builder.address || null, office_email: form.builder.office_email || null,
      invoice_email: form.builder.invoice_email || null, phone: form.builder.phone || null,
    };
    // Per-term rows from the term count; preserve pct set in Financial, carry closing dates entered here.
    const tc = parseInt(String(form.precon_term_count), 10) || 0;
    payload.precon_terms = Array.from({ length: tc }, (_, i) => {
      const k = i + 1;
      const existing = (form.precon_terms || []).find((x) => Number(x.term_no) === k) || { pct: null, closing_date: '' };
      return { term_no: k, pct: existing.pct ?? null, closing_date: existing.closing_date || null };
    });
  }
  if (isCommercialLeaseType(form.type)) {
    payload.commercial_lease = { ...CL_DEFAULTS, ...(form.commercial_lease || {}) };
  }
  return payload;
}

/**
 * TD-003 — the message for a save the server refused because somebody else saved first, or null
 * when the failure was anything else. A 409 from this endpoint means exactly one thing, so the
 * status is what identifies it; the body only supplies the wording.
 */
function staleSaveMessage(err: unknown): string | null {
  const e = err as { response?: { status?: number; data?: { message?: string } } };
  if (e?.response?.status !== 409) return null;
  return e.response?.data?.message
    ?? 'Somebody else changed this transaction while you were editing it.';
}

/** Why the form can't be persisted yet, or null when it's good to save. */
function validateForm(form: DetailForm): string | null {
  for (const c of form.clients) {
    if (!c.name?.trim()) return 'Each client needs a name';
    if (c.email && !emailLooksValid(c.email)) return 'Invalid client email';
    // TD-028 — phone was the one field on this row nobody checked, so 'abc-not-a-phone' saved and
    // then went out on a Deposit Receipt. Same rule the API applies, so the two cannot disagree.
    if (c.phone && !phoneLooksValid(c.phone)) return 'Invalid client phone number';
  }
  return null;
}

/** Idle gap after the last keystroke before an auto-save fires. */
const AUTOSAVE_MS = 1200;

export default function TransactionDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, isSuperAdmin, isAdminOrAbove, user } = useAuth();
  const isAgent = user?.role === 'agent';

  /**
   * Opening the deal is what clears the agent's review notifications for it — the point of the bell
   * is to get them here, so arriving is the acknowledgement. Best-effort: a failed call leaves the
   * mark for next time rather than interrupting the page.
   */
  useEffect(() => {
    if (!isAgent || !id) return;
    markTransactionReviewsSeen(id).catch(() => {});
  }, [isAgent, id]);
  // Documentation role: full access to Legal & Documentation only; every other section
  // (Basic Info, Team Split, Financial, Adjustment, Admin Activities) is view-only, and
  // the Invoice module is hidden.
  const isDocumentation = user?.role === 'documentation';
  const canEdit = can('transactions', 'edit');
  const canInvoice = can('invoice', 'edit');
  const [generating, setGenerating] = useState(false);

  const [form, setForm] = useState<DetailForm | null>(null);
  const [txn, setTxn] = useState<Transaction | null>(null); // raw API object (carries team + financial breakdown)
  const [mode, setMode] = useState<'view' | 'edit'>(params.get('mode') === 'edit' && canEdit ? 'edit' : 'view');
  const [agents, setAgents] = useState<string[]>([]);
  // TD-045 - true when the agent on this deal is an external/co-op name rather than an account.
  const [externalAgent, setExternalAgent] = useState(false);
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
  const [invEditorId, setInvEditorId] = useState<number | undefined>(undefined); // in-context invoice editor (undefined = closed)
  const [invSettings, setInvSettings] = useState<CompanySettings | null>(null);
  const [invCustomers, setInvCustomers] = useState<unknown>([]);
  const [depositOpen, setDepositOpen] = useState(false);   // listing-side: Deposit Receipt doc
  const [lawyerStmtOpen, setLawyerStmtOpen] = useState(false); // listing-side: Commission/Lawyer Statement doc
  const bodyRef = useRef<HTMLDivElement>(null);
  const [brokSuggestions, setBrokSuggestions] = useState<BrokerageSuggestion[]>([]);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null); // delete-confirmation popup
  const [coreDocReminders, setCoreDocReminders] = useState<string[]>([]); // §5.2 Active: pending core listing docs

  // Close-guard and review-decision state. Declared up here with the rest of the state rather
  // than beside the handlers that use it further down, and it has to stay here: the
  // `if (!form) return …` guard below returns on the loading render, so anything declared past
  // it runs on some renders and not others. React counts hooks per render and rejects that
  // outright — "Rendered more hooks than during the previous render" — which took the whole
  // page down as soon as the transaction finished loading. Every hook belongs above the guard.
  const [closeBlock, setCloseBlock] = useState<{ items: OpenReviewItem[]; message: string; reason: string } | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [decision, setDecision] = useState<{ kind: 'review' | 'reject' | 'reject-many'; auditId: number | null; text: string } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [reviewsKey, setReviewsKey] = useState(0);

  useEffect(() => {
    // applyUpdated (not a bare setForm) so the auto-save baseline is captured with the
    // freshly loaded values — otherwise the first render looks dirty and re-saves.
    getTransaction(id).then(applyUpdated).catch(() => toast('Could not load transaction', 'bad'));
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
        .map((doc) => doc.title || '')))
      .catch(() => setCoreDocReminders([]));
  }, [id, form?.type, (form?.statuses || []).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrived from a document-review notification (?open=docs) → open Legal &
  // Documentation directly, then drop the param so closing it doesn't reopen.
  useEffect(() => {
    if (params.get('open') === 'docs' && txn) {
      setDocsOpen(true);
      const p = new URLSearchParams(params); p.delete('open'); setParams(p, { replace: true });
    }
  }, [params, txn]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Auto-save ────────────────────────────────────────────────────────────
  // Every field on this page persists on its own. The sections behind Team Split,
  // Financial, Legal & Documentation etc. read this transaction's *saved* values, so
  // anything left unsaved here used to reappear as missing data over there — and was
  // lost outright on navigating back. Edits are now debounced and PUT automatically,
  // and flushed the moment a section opens or the page unmounts.
  const formRef = useRef<DetailForm | null>(null);
  const savedSnapRef = useRef<string | null>(null); // payload JSON as last persisted; null until loaded
  /*
   * TD-003 — the version this page is holding, refreshed from every server reply.
   *
   * A REF AND NOT PART OF `buildPayload`, deliberately, for two reasons. It is not something the
   * user edited, so it must not make the form look dirty and trigger an auto-save on its own. And
   * `flushAutoSave` reuses the snapshot it sent as the new baseline without refreshing `form` —
   * that is on purpose, so a reply cannot yank the field being typed in — which means a version
   * baked into the payload would still read as the pre-save one on the next keystroke and the
   * page would 409 against its own last write.
   */
  const versionRef = useRef<number | null>(null);
  // Set when the server says somebody else saved first. Auto-save stops while it is set: the
  // version in hand cannot succeed, so retrying on every keystroke would only be a stream of
  // failed writes. Cleared by reloading, which is the only thing that can resolve it.
  const [conflict, setConflict] = useState<string | null>(null);
  const savingRef = useRef(false);
  const rerunRef = useRef(false);                   // an edit landed while a save was in flight
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoOnRef = useRef(false);                  // assigned during render, once the edit gate is known
  const [autoState, setAutoState] = useState<'idle' | 'saving' | 'saved' | 'blocked' | 'error'>('idle');
  const [autoMsg, setAutoMsg] = useState('');

  useEffect(() => { formRef.current = form; }, [form]);

  /**
   * The payload plus the version this page loaded. Both save paths go through it so they cannot
   * disagree about what they are writing against — an auto-save that skipped the check would
   * reintroduce the whole defect through the back door.
   *
   * Omitted rather than sent as null when unknown: the server treats an absent version as "no
   * opinion" and saves unconditionally, which is the right behaviour for a page that genuinely
   * never received one, and the wrong behaviour to fake when it did.
   */
  const withVersion = useCallback((payload: Record<string, unknown>): Record<string, unknown> => (
    versionRef.current === null ? payload : { ...payload, version: versionRef.current }
  ), []);

  /** Persist now if there is anything to persist. Safe to call spuriously. */
  const flushAutoSave = useCallback(async (): Promise<void> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const f = formRef.current;
    if (!autoOnRef.current || !f || savedSnapRef.current === null) return;
    const snap = JSON.stringify(buildPayload(f));
    if (snap === savedSnapRef.current) return;      // nothing changed since the last write
    const problem = validateForm(f);
    // Hold rather than write a half-filled row — the indicator says why, and the save
    // goes through as soon as the field is completed.
    if (problem) { setAutoState('blocked'); setAutoMsg(problem); return; }
    if (savingRef.current) { rerunRef.current = true; return; }
    savingRef.current = true;
    setAutoState('saving'); setAutoMsg('');
    try {
      const updated = await updateTransaction(id, withVersion(JSON.parse(snap) as Record<string, unknown>));
      savedSnapRef.current = snap;
      versionRef.current = updated.version ?? null;
      // Refresh the raw transaction only — never `form`, which would fight whatever the
      // user is typing right now (cursor jumps, dropped keystrokes mid-flight).
      setTxn(updated);
      setAutoState('saved'); setAutoMsg('');
    } catch (err) {
      // A stale save is not "could not save" — the write was understood and deliberately refused,
      // and the edit is still sitting in the form. Say so, and stop auto-saving until it is
      // resolved; the banner carries the only action that can resolve it.
      const stale = staleSaveMessage(err);
      if (stale) { setConflict(stale); setAutoState('error'); setAutoMsg('Not saved — someone else saved first'); }
      else { setAutoState('error'); setAutoMsg(apiErrorMessage(err, 'Could not save')); }
    } finally {
      savingRef.current = false;
      if (rerunRef.current) { rerunRef.current = false; void flushAutoSave(); }
    }
  }, [id, withVersion]);

  // Debounce: restart the clock on every edit, write once the user pauses.
  useEffect(() => {
    if (!autoOnRef.current || !form || savedSnapRef.current === null) return;
    if (JSON.stringify(buildPayload(form)) === savedSnapRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flushAutoSave(); }, AUTOSAVE_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [form, flushAutoSave]);

  // Leaving the page (route change or tab close) must not outrun the debounce.
  useEffect(() => {
    const onLeave = () => { void flushAutoSave(); };
    window.addEventListener('beforeunload', onLeave);
    return () => { window.removeEventListener('beforeunload', onLeave); void flushAutoSave(); };
  }, [flushAutoSave]);

  // Opening another section — the reported case. Those modals load the transaction
  // server-side, so the pending edit has to land before they read it.
  const sectionOpen = teamOpen || finOpen || docsOpen || invoiceOpen || nosOpen || tsOpen
    || lawyerOpen || auditOpen || adminOpen || faqOpen || adjOpen || chatOpen
    || depositOpen || lawyerStmtOpen || invEditorId !== undefined;
  useEffect(() => { if (sectionOpen) void flushAutoSave(); }, [sectionOpen, flushAutoSave]);

  const applyUpdated = (updated: Transaction) => {
    setForm(toForm(updated));
    setTxn(updated);
    // New baseline — without this the next render would look "dirty" and re-save.
    savedSnapRef.current = JSON.stringify(buildPayload(toForm(updated)));
    // TD-003 — every server reply is also the freshest version this page has seen, whether it came
    // from the initial load, a save, or a reload after a conflict. Taking it here means the one
    // place that adopts the server's values is the same place that adopts its version, so the two
    // can never describe different snapshots.
    versionRef.current = updated.version ?? null;
    setConflict(null);
  };

  const generateInvoices = async () => {
    setGenerating(true);
    try {
      const res = await generateTransactionInvoices(id);
      toast(res.existing ? 'Opening existing invoice' : `Created ${res.count} invoice${res.count === 1 ? '' : 's'}`, 'ok');
      // Open the (new or existing) invoice in the same editor, in-context on this page.
      const invId = res.invoices?.[0]?.id;
      if (invId) { setInvEditorId(invId); getTransaction(id).then(applyUpdated).catch(() => {}); }
      else navigate(deskPath('invoice'));
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not generate invoice'), 'bad');
    } finally { setGenerating(false); }
  };

  // Unified invoice action (header + Quick Actions): existing invoice → open it in
  // the new editor; invoiceable + none yet → generate then open; otherwise the
  // on-the-fly document (non-invoiceable types have no persisted invoice).
  const openInvoice = () => {
    if (txn?.invoices?.length) setInvEditorId(txn.invoices[0].id);
    else if (canInvoice && form && isInvoiceableType(form.type)) generateInvoices();
    else setInvoiceOpen(true);
  };

  if (!form) return <div className="centered">Loading…</div>;

  // Founding team members (selected at creation, access='full') edit like the primary;
  // docs-only split members (added later) are view-only except for uploading documents.
  const myTeamAccess = txn?.my_team_access; // 'full' | 'docs' | null
  const isSplitViewerEarly = isAgent && form.agent !== user?.name && myTeamAccess !== 'full';
  const view = mode === 'view' || isSplitViewerEarly || isDocumentation;
  const listing = isListingType(form.type);
  const precon = isPreconType(form.type);
  const commercialLease = isCommercialLeaseType(form.type);
  // Referral is a stripped-down transaction (no MLS / deposit / conditions / lawyer).
  const referral = form.type === 'Referral';
  // Lease types use the free-text (Custom-only) condition layout.
  const isLease = /lease/i.test(form.type);
  /** Sale-listing types show "Total Sale Price" instead of "Total Purchase Price". */
  const isSaleListing = /sale listing/i.test(form.type);
  const priceLabel = isLease ? 'Total lease price' : isSaleListing ? 'Total Sale Price' : 'Total Purchase Price';
  // Lawyer Details is hidden for lease / preconstruction / referral types (legal side handled differently).
  const lawyerHidden = precon || /lease/i.test(form.type) || referral;
  const statusOptions = statusOptionsFor(form.type);
  const ro = view; // read-only flag

  function set<K extends keyof DetailForm>(k: K, v: DetailForm[K]) { setForm((f) => (f ? { ...f, [k]: v } : f)); }
  function setBrok<K extends keyof BrokerageForm>(k: K, v: BrokerageForm[K]) { setForm((f) => (f ? { ...f, brokerage: { ...f.brokerage, [k]: v } } : f)); }
  // Selecting a saved brokerage fills only its contact details — never the agent
  // name(s), which differ per transaction.
  const pickBrokerage = (s: BrokerageSuggestion) => setForm((f) => (f ? {
    ...f,
    brokerage: {
      ...f.brokerage,
      name: s.name || '',
      address: s.address || f.brokerage.address,
      email: s.email || f.brokerage.email,
      invoice_email: s.invoice_email || f.brokerage.invoice_email,
      phone: s.phone || f.brokerage.phone,
    },
  } : f));
  // Typing (not just clicking a suggestion): when the name exactly matches a known
  // brokerage, fill any blank contact fields from it (agents are left untouched).
  const onBrokName = (v: string) => setForm((f) => {
    if (!f) return f;
    const next: DetailForm = { ...f, brokerage: { ...f.brokerage, name: v } };
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
  const setBuilder = (k: keyof BuilderForm, v: string) => setForm((f) => (f ? { ...f, builder: { ...f.builder, [k]: v } } : f));
  const cl: Record<string, unknown> = { ...CL_DEFAULTS, ...(form.commercial_lease || {}) };
  const setCl = (k: string, v: unknown) => setForm((f) => (f ? { ...f, commercial_lease: { ...CL_DEFAULTS, ...(f.commercial_lease || {}), [k]: v } } : f));
  // Preconstruction per-term closing dates (driven by the term count).
  const preconTermClosing = (k: number): string => ((form.precon_terms || []).find((x) => Number(x.term_no) === k)?.closing_date) || '';
  const setPreconTermClosing = (k: number, date: string) => setForm((f) => {
    if (!f) return f;
    const arr = [...(f.precon_terms || [])];
    const idx = arr.findIndex((x) => Number(x.term_no) === k);
    if (idx >= 0) arr[idx] = { ...arr[idx], closing_date: date };
    else arr.push({ term_no: k, pct: null, closing_date: date });
    return { ...f, precon_terms: arr };
  });
  const setListingType = (which: string) => set('mls_type', which);

  // Transaction progress stepper
  const stages = [
    { label: 'Drafted', pass: !!(txn?.id || form.property) },
    { label: 'Agent Set', pass: !!(form.agent && form.agent.trim()) },
    { label: 'Clients', pass: (form.clients || []).length > 0 },
    { label: 'Financial', pass: !!(txn?.comm_pct || txn?.comm_amt || txn?.precon_comm_pct || Number(txn?.financial?.total) > 0) },
    { label: 'Closed', pass: (form.statuses || []).includes('Closed') },
  ];
  let curStage = stages.findIndex((s) => !s.pass);
  if (curStage === -1) curStage = stages.length - 1;
  const progressPct = Math.round(stages.filter((s) => s.pass).length / stages.length * 100);

  const toggleStatus = (s: string) => {
    setForm((f) => {
      if (!f) return f;
      const has = f.statuses.includes(s);
      // Any status may be selected freely (no grouping/transition restriction).
      let next = has ? f.statuses.filter((x) => x !== s) : [...f.statuses, s];
      if (next.length === 0) { const d = defaultStatusFor(f.type); next = d ? [d] : []; }
      return { ...f, statuses: next };
    });
  };

  /*
   * TD-015 — A TYPE CHANGE CARRIES THE STATUS ACROSS, AND ASKS BEFORE DROPPING ONE.
   *
   * This reset the status to the new family's default on every type change, silently: a deal marked
   * "Secured Firm" whose type was corrected came back "Open", and the only way to notice was to
   * remember what it had been. The reported case was a type restored on deal 5 — the status had to
   * be set again by hand, on a field that decides the edit-lock, the commission layout and every
   * status filter in the reports.
   *
   * MOST STATUSES DO NOT NEED TO BE LOST. `normalizeStatus` already knows how a status reads in
   * another family — "Open" is "Active" on a listing and "Secured Conditional" on a secured deal,
   * "Sold" is "Leased" on a lease — so the carry-over is that mapping, kept where the new type's
   * vocabulary actually has it.
   *
   * THE SAME RULE THE SERVER APPLIES, deliberately. `statusSetProblem` refuses a status the type
   * does not define, and since TD-071 it refuses one the deal is merely still holding, so a client
   * that carried anything else forward would produce a save the API rejects. Its other two rules —
   * one terminal status, no terminal beside a running one — cannot be broken by this mapping: it
   * never turns a running status into an ended one.
   *
   * WHAT CANNOT COME ACROSS IS NAMED BEFORE IT GOES, which is the half the entry asks for: "either
   * preserve a still-valid status or warn the user that status will reset". Cancelling leaves the
   * type alone, so nothing is saved either way.
   */
  const carryStatuses = (was: string[], newType: string): { keep: string[]; lost: string[] } => {
    const options = statusOptionsFor(newType);
    const keep: string[] = [];
    const lost: string[] = [];
    for (const s of was.filter(Boolean)) {
      const mapped = normalizeStatus(newType, s);
      if (!options.includes(mapped)) lost.push(s);
      else if (!keep.includes(mapped)) keep.push(mapped);
    }
    return { keep, lost };
  };

  const onTypeChange = (newType: string) => {
    if (!form || newType === form.type) return;
    const { keep, lost } = carryStatuses(form.statuses || [], newType);
    const fallback = keep.length ? keep : (defaultStatusFor(newType) ? [defaultStatusFor(newType)] : []);
    const apply = () => setForm((f) => (f ? { ...f, type: newType, statuses: fallback } : f));
    if (lost.length === 0) { apply(); return; }
    const quoted = lost.map((s) => `“${s}”`).join(' and ');
    askDelete({
      title: 'Change the transaction type?',
      message: `A ${typeLabel(newType)} deal cannot be ${quoted}, so ${lost.length === 1 ? 'that status' : 'those statuses'} will be removed. `
        + (fallback.length ? `This deal will be ${fallback.join(' and ')}.` : 'Its status will be left blank for you to set.'),
      linked: ['Which fields this deal shows and how its commission is worked out', 'Whether the deal is locked for editing', 'Every report and filter that selects by status'],
      confirmLabel: 'Change type',
      onConfirm: apply,
    });
  };

  // Delete confirmation: opens a popup describing the item and any linked
  // functionality before the row is removed (applied on Save).
  const askDelete = (opts: ConfirmOptions) => setConfirm(opts);

  // clients
  const addClient = () => set('clients', [...form.clients, { name: '', email: '', phone: '' }]);
  const updClient = (i: number, k: 'name' | 'email' | 'phone', v: string) => set('clients', form.clients.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmClient = (i: number) => askDelete({
    title: 'Delete client?',
    message: `Remove client "${form.clients[i]?.name || `#${i + 1}`}" from this transaction?`,
    linked: ['Notice of Sale buyers/sellers', 'Invoice customer details', 'Document clearance in Agent Payment Readiness'],
    note: 'The change is saved automatically a moment after you confirm.',
    onConfirm: () => setForm((f) => (f ? { ...f, clients: f.clients.filter((_, idx) => idx !== i) } : f)),
  });

  // conditions
  const addCond = () => set('conditions', [...form.conditions, { type: isLease ? 'Custom' : '', custom_name: '', deadline: '', status: 'Pending' }]);
  const updCond = (i: number, k: 'type' | 'custom_name' | 'deadline' | 'status', v: string) => set('conditions', form.conditions.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  const rmCond = (i: number) => askDelete({
    title: 'Delete condition?',
    message: `Remove condition "${form.conditions[i]?.custom_name || form.conditions[i]?.type || `#${i + 1}`}"?`,
    linked: ['Its matching row in Legal & Documentation (and any files uploaded to it)', 'Document clearance / Final Validation in Agent Payment Readiness'],
    note: 'The change is saved automatically a moment after you confirm.',
    onConfirm: () => setForm((f) => (f ? { ...f, conditions: f.conditions.filter((_, idx) => idx !== i) } : f)),
  });

  // inter-board
  const addIb = () => set('inter_board_listings', [...form.inter_board_listings, { name: '', board_id: '', verified: false }]);
  const updIb = <K extends keyof InterBoardRow>(i: number, k: K, v: InterBoardRow[K]) => set('inter_board_listings', form.inter_board_listings.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const rmIb = (i: number) => askDelete({
    title: 'Delete inter-board listing?',
    message: `Remove inter-board listing "${form.inter_board_listings[i]?.name || `#${i + 1}`}"?`,
    linked: ['MLS / board verification on this transaction'],
    note: 'The change is saved automatically a moment after you confirm.',
    onConfirm: () => setForm((f) => (f ? { ...f, inter_board_listings: f.inter_board_listings.filter((_, idx) => idx !== i) } : f)),
  });

  // brokerage agents
  const addBrokAgent = () => setBrok('agents', [...form.brokerage.agents, '']);
  const updBrokAgent = (i: number, v: string) => setBrok('agents', form.brokerage.agents.map((a, idx) => idx === i ? v : a));
  const rmBrokAgent = (i: number) => askDelete({
    title: 'Delete agent name?',
    message: `Remove agent "${form.brokerage.agents[i] || `#${i + 1}`}" from the brokerage?`,
    linked: ['Listing Agent Name(s) shown on Invoices, Notice of Sale, Deposit Receipt and Lawyer Statement'],
    note: 'The change is saved automatically a moment after you confirm.',
    onConfirm: () => setForm((f) => (f ? { ...f, brokerage: { ...f.brokerage, agents: f.brokerage.agents.filter((_, idx) => idx !== i) } } : f)),
  });

  /**
   * Manual save — now a "save and leave edit mode" shortcut over the same payload the
   * auto-save writes. Cancels any pending debounce so the two can't race.
   */
  /**
   * Save, and handle the one refusal that is not a mistake.
   *
   * Closing a deal with an unanswered rejection on it is blocked, because closing is the moment the
   * paperwork is declared final and an open review item says it is not. The block is overridable —
   * an office that settled the point another way must not be stuck — but the override is a
   * deliberate act with a reason, and it is written to the audit trail.
   */
  const save = async (overrideReason?: string) => {
    const problem = validateForm(form);
    if (problem) { toast(problem, 'bad'); return; }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const payload = buildPayload(form);
    if (overrideReason) payload.review_override_reason = overrideReason;
    setSaving(true);
    try {
      const updated = await updateTransaction(id, withVersion(payload));
      applyUpdated(updated);
      setMode('view');
      setAutoState('saved'); setAutoMsg('');
      setCloseBlock(null);
      toast('Transaction saved', 'ok');
    } catch (err) {
      const body = (err as { response?: { data?: { unresolved_reviews?: unknown[]; message?: string } } })?.response?.data;
      const stale = staleSaveMessage(err);
      if (stale) {
        // TD-003 — the edit is still on screen and still theirs; what is gone is the right to write
        // it blind. The banner says so and offers the reload. Deliberately not a toast: it would
        // fade while the user was still deciding what to do about it. The close-guard modal, if it
        // is what triggered this save, comes down — its question is moot until this is settled.
        setConflict(stale);
        setCloseBlock(null);
        setAutoState('error'); setAutoMsg('Not saved — someone else saved first');
      } else if (Array.isArray(body?.unresolved_reviews)) {
        // Not an error to shrug at: show what is outstanding and ask for a reason to proceed.
        setCloseBlock({ items: body.unresolved_reviews as OpenReviewItem[], message: body.message ?? '', reason: '' });
      } else {
        toast(apiErrorMessage(err, 'Could not save'), 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  const stPill = (s: string) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));
  const brokLabel = listing ? 'Co-Op' : 'Listing';

  // Auto-save status shown beside the Done button, so "did that save?" is never a guess.
  const autoPill = autoState === 'error' || autoState === 'blocked' ? 'bad'
    : autoState === 'saving' ? 'warn'
      : autoState === 'saved' ? 'ok' : 'info';
  const autoText = autoState === 'saving' ? <><Icon name="clock" size={12} /> Saving…</>
    : autoState === 'error' ? <><Icon name="alert" size={12} /> {autoMsg || 'Not saved'}</>
      : autoState === 'blocked' ? <><Icon name="alert" size={12} /> {autoMsg}</>
        : autoState === 'saved' ? <><Icon name="check" size={12} /> Saved</> : <><Icon name="zap" size={12} /> Auto-save on</>;

  // §5.2 — Sale Listing status matrix (sale listings only; lease excluded).
  const saleListing = isListingStatusFamily(form.type) && !/lease/i.test(form.type);
  const stActive = saleListing && form.statuses.includes('Active');
  // A listing that's still Active has no price/deposit yet — hide those fields.
  const hidePriceDeposit = listing && form.statuses.includes('Active');
  /*
   * TD-035 — A DEPOSIT RECEIPT FOLLOWS THE DEPOSIT, NOT THE DEAL TYPE.
   *
   * The button was offered on `isListingFinancialType(form.type)` and nothing else, which is a
   * question about which SIDE of a trade this is — it decides whether the header shows the
   * listing-side documents or the Invoice. It says nothing about whether money was taken. So a
   * Residential Buying deal holding a $28,000 deposit could not produce a receipt for it, while a
   * Residential Sale Listing at $0 offered to write a receipt for nothing.
   *
   * Read from `form` rather than `txn` so the button follows what is on screen: entering a deposit
   * offers the receipt immediately, and clearing it withdraws the offer, without a save in between.
   * `parseNumber` is the same reader `buildPayload` uses, so the button and the saved value cannot
   * disagree about what counts as a deposit.
   *
   * A NEGATIVE deposit is not a deposit either — the API refuses to store one (TD-055) but older
   * rows can still hold one, and a receipt for minus eight hundred dollars is not a document
   * anybody should be able to send.
   */
  const hasDeposit = parseNumber(form.deposit) > 0;
  const stSoldCond = saleListing && form.statuses.includes('Sold Conditional');
  const stTerminated = saleListing && form.statuses.includes('Terminated');

  // §5.1 — deal-side Mutual Release / Void restrict the page to Legal & Docs only
  // (listing-family types are exempt). docRestrict limits which documents show.
  const dealSide = !isListingStatusFamily(form.type);
  const stVoid = dealSide && form.statuses.includes('Void');
  const stMutualRelease = dealSide && form.statuses.includes('Mutual Release');
  const stSecuredFirm = form.statuses.includes('Secured Firm'); // hides Conditional Offer
  // Once Sold / Leased, hide the Conditional Offer section (its saved data stays
  // interlinked — e.g. Legal & Documentation condition docs remain).
  const stSoldOrLeased = form.statuses.includes('Sold') || form.statuses.includes('Leased');
  // Header doc buttons: Active hides Lawyer Statement + Notice of Sale + Trade Sheet;
  // Sold/Lease Conditional hides Lawyer Statement + Notice of Sale (Trade Sheet stays).
  const stHdrActive = form.statuses.includes('Active');
  const stHdrConditional = form.statuses.includes('Sold Conditional') || form.statuses.includes('Lease Conditional');
  const hideStmtNos = stHdrActive || stHdrConditional; // Lawyer Statement + Notice of Sale
  const hideTradeSheet = stHdrActive;
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
  const slNoSections = stTerminated; // no Admin / Financial / Agent Payment Readiness; hide Team Split

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
  const tradeSheetSent = !!txn?.trade_sheet_sent_at;
  const invoiceSent = (txn?.invoices || []).some((i) => i.sent_at);
  const invoicePaid = (txn?.invoices || []).some((i) => i.status === 'Paid'); // payment recorded → header shows "Paid"
  const agentPaid = txn?.activity_tracker?.agent_commission_paid_status === 'Yes' || txn?.comm_paid_status === 'Yes'; // agent payment complete
  // Once the deal is Closed AND the agent commission is paid, the money-side sections
  // (Team Split, Adjustments/Advances, agent %, client & external referrals) lock for
  // everyone except a Super Admin.
  const closedAndPaid = stClosed && agentPaid;
  // Team Split: hidden entirely once closed & paid (Super Admin only);
  // after Notice of Sale is sent, agents can't be added/removed/renamed (Admin+ retain access).
  const teamSplitVisible = !closedAndPaid || isSuperAdmin;
  const teamReadOnly = view || (closedAndPaid && !isSuperAdmin) || !teamSplitEditableByRole;
  /*
   * TD-058 — which of the three locks is on, said in the modal.
   *
   * The defect was a Team Split form that accepted a split in View Only and discarded it silently;
   * the fields are now inside a disabled fieldset. This is the other half of "nothing tells them":
   * the banner explaining the lock was shown to everybody EXCEPT agents, which is the one role the
   * defect was reported on. Telling an agent to "click Edit" is only true when editing would
   * actually let them in, so the reason is chosen here, where the three conditions live.
   */
  const teamReadOnlyReason = !teamSplitEditableByRole
    ? 'Read-only — only the primary agent or a full-access team member can change the split.'
    : (closedAndPaid && !isSuperAdmin)
      ? 'Read-only — this deal is closed and the commission has been paid, so the split is locked.'
      : undefined;
  const teamLockAgents = nosSent && !isAdminOrAbove && !agentPaid;
  // Adjustment / advance / client referral / external brokerage referral: locked to
  // Super Admin once the deal is closed and the agent commission is paid.
  const adjReadOnly = view || (closedAndPaid && !isSuperAdmin);
  const editRequests = txn?.edit_requests || [];
  // The DFT/Closed lock uses general (non-financial) requests; financial-scoped ones
  // are handled inside the Financial modal.
  const pendingReq = editRequests.find((r) => r.status === 'pending' && r.scope !== 'financial');
  const approvedReq = editRequests.find((r) => r.status === 'approved' && r.scope !== 'financial');

  // Auto-save is allowed exactly when the Save button would have been offered — same
  // permission, role and lifecycle-lock gate, so it can never write where a manual
  // save was refused. Assigned during render; the effects above read it when they run.
  // TD-003 — and never while a conflict is unresolved. Every write the page could make right now
  // carries a version the server has already rejected, so leaving it on would turn one refusal
  // into a failed PUT per keystroke while the user reads the banner explaining the first.
  const autoSaveOn = !view && canEdit && !isSplitViewer
    && !conflict
    && !(stClosed && !isSuperAdmin)
    && !(lockedForUser && !approvedReq);
  autoOnRef.current = autoSaveOn;

  // Is there an edit the server hasn't got yet? Computed during render, not in an
  // effect, because it gates whether a section may mount at all — an effect would run
  // a commit too late and the section would already have snapshotted stale values.
  const dirty = savedSnapRef.current !== null && JSON.stringify(buildPayload(form)) !== savedSnapRef.current;
  // Sections like Financial copy txn.price into their own state on mount, so a late
  // setTxn never reaches them. Hold the section closed until the write lands. Released
  // on 'blocked'/'error' too, so a save that can't succeed never traps the user.
  const holdSections = sectionOpen && autoSaveOn && dirty && autoState !== 'blocked' && autoState !== 'error';

  const reloadTxn = () => getTransaction(id).then(applyUpdated).catch(() => {});
  const onRequestEdit = async () => {
    const reason = window.prompt('Reason for the edit request (optional):');
    if (reason === null) return;
    try { await requestTransactionEdit(id, reason); toast('Edit request sent for Super Admin approval', 'ok'); reloadTxn(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not send request'), 'bad'); }
  };
  const onApproveReq = async (reqId: number) => { try { await approveEditRequest(reqId); toast('Edit approved', 'ok'); reloadTxn(); } catch { toast('Could not approve', 'bad'); } };
  const onRejectReq = async (reqId: number) => { try { await rejectEditRequest(reqId); toast('Edit rejected', 'ok'); reloadTxn(); } catch { toast('Could not reject', 'bad'); } };

  // Transaction deletion approval workflow.
  const deleteReq = txn?.delete_request || null;
  const onRequestDelete = async () => {
    const reason = window.prompt('Reason for requesting this transaction be deleted:');
    if (reason === null) return;
    if (!reason.trim()) { toast('A reason is required', 'bad'); return; }
    try { await requestTransactionDeletion(id, reason.trim()); toast('Deletion request sent to Admin', 'ok'); reloadTxn(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not send request'), 'bad'); }
  };
  const onForwardDelete = async () => {
    if (!deleteReq) return;
    const reason = window.prompt('Reason to forward this deletion to a Super Admin (optional):');
    if (reason === null) return;
    try { await forwardDeleteRequest(deleteReq.id, reason); toast('Forwarded to Super Admin', 'ok'); reloadTxn(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not forward'), 'bad'); }
  };
  const onApproveDelete = async () => {
    if (!deleteReq) return;
    if (!window.confirm('Approve and permanently delete this transaction?')) return;
    try { await approveDeleteRequest(deleteReq.id); toast('Transaction deleted', 'ok'); navigate(deskPath('transactions')); }
    catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); }
  };
  const onRejectDelete = async () => {
    if (!deleteReq) return;
    try { await rejectDeleteRequest(deleteReq.id); toast('Deletion request rejected', 'ok'); reloadTxn(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not reject'), 'bad'); }
  };

  // Per-transaction banner: agent-made changes an admin hasn't reviewed yet.
  const agentChanges = txn?.agent_changes || [];
  /**
   * A decision is never taken without something being written down beside it: a rejection must carry
   * a reason, and a review may carry a note. Both open the same small dialog, which is also what
   * stops a Reject being one stray click away from an agent hearing "no" with no explanation.
   */
  const onReviewAgentChanges = () => setDecision({ kind: 'review', auditId: null, text: '' });
  const onRejectAgentChange = (auditId: number) => setDecision({ kind: 'reject', auditId, text: '' });
  /**
   * Rejecting several at once under one reason.
   *
   * An administrator turning down five fields is usually making a single judgement — "none of this
   * matches the APS" — and asking for it five times produces five copies of the same sentence or
   * five worse ones. Each item still becomes its own record with its own lifecycle.
   */
  const onRejectSelected = () => setDecision({ kind: 'reject-many', auditId: null, text: '' });
  const togglePicked = (auditId: number) =>
    setPicked((p) => (p.includes(auditId) ? p.filter((n) => n !== auditId) : [...p, auditId]));

  const submitDecision = async () => {
    if (!decision) return;
    const text = decision.text.trim();
    if (decision.kind !== 'review' && !text) return; // the button is disabled; this is the belt to its braces
    setDeciding(true);
    try {
      if (decision.kind === 'reject-many') {
        const r = await bulkReviewAction(id, 'reject', picked, text);
        setPicked([]);
        // Rejecting changes the transaction, so it is re-read rather than patched.
        applyUpdated(await getTransaction(id));
        toast(`${r.rejected ?? 0} rejected — the agent has been notified`, 'ok');
      } else {
        const updated = decision.kind === 'reject'
          ? await rejectAgentChange(id, decision.auditId!, text)
          : await reviewAgentChanges(id, text);
        applyUpdated(updated);
        toast(decision.kind === 'reject' ? 'Rejected — the agent has been notified' : 'Marked as reviewed', 'ok');
      }
      setDecision(null);
      // The history is loaded separately, so it has to be told that it just changed.
      setReviewsKey((k) => k + 1);
    } catch (e) {
      toast(apiErrorMessage(e, decision.kind === 'review' ? 'Could not update' : 'Could not reject'), 'bad');
    } finally {
      setDeciding(false);
    }
  };

  return (
    <>
      <div className="detail-head" style={{ position: 'sticky', top: 60, zIndex: 30 }}>
        <button className="btn ghost sm" onClick={() => navigate(deskPath('transactions'))}><Icon name="arrowLeft" size={13} /> Back</button>
        <div className="detail-title">
          <strong>{form.property || 'Untitled'}</strong>
          <span className={`pill ${typeClass(form.type)}`}>{typeLabel(form.type)}</span>
          {form.statuses.map((s) => <span key={s} className={`pill ${stPill(s)}`}>{s}</span>)}
          <span className={`pill ${view ? 'info' : 'warn'}`} style={{ fontSize: 10 }}>{view ? <><Icon name="lock" size={11} /> View Only</> : <><Icon name="edit" size={11} /> Edit Mode</>}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Invoice / Trade Sheet / Notice of Sale are hidden for agents. */}
          {/*
            * TD-035 — the Deposit Receipt is its own decision, taken on `hasDeposit`.
            *
            * It used to be the first arm of the type ternary below, which made "is there a deposit
            * to receipt?" and "which side of the trade is this?" the same question. They are not,
            * and the ternary is still correct for the two that ARE side questions: the Lawyer
            * Statement belongs to the listing side, the Invoice to the other. Only the receipt has
            * been lifted out; neither of those changes behaviour.
          */}
          {!isAgent && hasDeposit && (
            <button className="btn ghost sm" onClick={() => setDepositOpen(true)}><Icon name="receipt" size={13} /> Deposit Receipt</button>
          )}
          {!isAgent && (isListingFinancialType(form.type) ? (
            !hideStmtNos && <button className="btn ghost sm" onClick={() => setLawyerStmtOpen(true)}><Icon name="doc" size={13} /> Lawyer Statement</button>
          ) : (
            !docsOnly && !isDocumentation && <button className="btn ghost sm" style={invoicePaid ? { color: 'var(--ok-ink)', borderColor: 'var(--ok-ring-2)', background: 'var(--ok-bg)', fontWeight: 700 } : undefined} onClick={openInvoice}><Icon name="receipt" size={13} /> Invoice{invoicePaid ? ' Paid' : (invoiceSent ? ' sent' : '')}</button>
          ))}
          {!isAgent && !docsOnly && !hideTradeSheet && <button className="btn ghost sm" onClick={() => setTsOpen(true)}><Icon name="clipboard" size={13} /> Trade Sheet{tradeSheetSent ? ' sent' : ''}</button>}
          {!isAgent && !docsOnly && !hideStmtNos && <button className="btn ghost sm" style={nosSent ? { color: 'var(--ok-ink)', borderColor: 'var(--ok-ring-2)', background: 'var(--ok-bg)', fontWeight: 700 } : undefined} onClick={() => setNosOpen(true)}><Icon name="doc" size={13} /> Notice of Sale{nosSent ? ' Sent' : ''}</button>}
          <button className="btn ghost sm" onClick={() => setChatOpen(true)}><Icon name="message" size={13} /> Chat</button>
          <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} />
          {!canEdit
            ? <span className="pill info" style={{ fontSize: 10 }}>Read-only access</span>
            : isSplitViewer
            ? <span className="pill info" style={{ fontSize: 10 }} title="Shared with you via team split — view only"><Icon name="eye" size={11} /> Shared — view only</span>
            : stClosed && !isSuperAdmin
            ? <span className="pill" style={{ fontSize: 10, background: 'var(--bad-soft)', color: 'var(--warn-ink-alt)', border: '1px solid #fecaca' }} title="This transaction is Closed — only a Super Admin can edit it."><Icon name="lock" size={11} /> Closed — Super Admin only</span>
            : lockedForUser && !approvedReq
            ? (<>
                <button className="btn primary sm" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }} title="Locked (DFT) — edits need Super Admin approval"><Icon name="edit" size={13} /> Edit</button>
                {isAdminOrAbove && !pendingReq && <button className="btn ghost sm" onClick={onRequestEdit}><Icon name="unlock" size={13} /> Request Edit</button>}
                {pendingReq && <span className="pill warn" style={{ fontSize: 10 }}>Awaiting approval</span>}
              </>)
            : isDocumentation
            ? <span className="pill info" style={{ fontSize: 10 }} title="Documentation role: edit Legal & Documentation from its section. All other sections are view-only."><Icon name="doc" size={11} /> Legal &amp; Docs editable</span>
            : view
            ? <button className="btn primary sm" onClick={() => setMode('edit')}><Icon name="edit" size={13} /> Edit{lockedForUser && approvedReq ? ' (approved)' : ''}</button>
            : (<>
                {/* No Cancel here any more: with auto-save on there is nothing pending to
                    discard, so a Cancel button would only mislead. Done flushes and returns
                    to view mode. */}
                <span className={`pill ${autoPill}`} style={{ fontSize: 10 }}
                  title={autoMsg || 'Every field on this page saves by itself a moment after you stop typing.'}>{autoText}</span>
                <button className="btn primary sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : <><Icon name="check" size={13} /> Done</>}</button>
              </>)}
          {/* Agents request deletion (their own deals); admins/super admins delete via the workflow banner. */}
          {isFullAgent && !deleteReq && <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={onRequestDelete}><Icon name="trash" size={13} /> Request Deletion</button>}
        </div>
      </div>

      {/*
        TD-003 — somebody else saved this deal while this form was open.

        First banner on the page, because until it is dealt with nothing else here can be written.
        It says what happened, that the edit is still on screen, and what reloading will cost —
        the alternative was silence and a reverted price nobody noticed for weeks.

        Reloading is offered as the only action, and there is deliberately no "save anyway": a
        forced write here would put every stale field on this form back over the top of the other
        person's work, which is precisely the defect. Anyone who needs their value to win can
        reload and type it again, on top of what is actually stored.
      */}
      {conflict && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--warn-bg)' }}>
          <div style={{ fontWeight: 700, color: 'var(--warn-ink-alt)' }}><Icon name="alert" size={13} /> Not saved — someone else changed this transaction</div>
          <div style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)', marginTop: 2 }}>{conflict}</div>
          <div style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)', marginTop: 2 }}>
            Your changes are still on screen and auto-save is paused. Reloading replaces them with
            the saved version, so copy anything you need to keep before you reload.
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn primary sm" onClick={reloadTxn}><Icon name="refresh" size={13} /> Reload the saved version</button>
          </div>
        </div>
      )}

      {/* Closed — fully locked: only a Super Admin may edit (no request workflow). */}
      {stClosed && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--warn-bg)' }}>
          <div style={{ fontWeight: 700, color: 'var(--warn-ink-alt)' }}><Icon name="lock" size={13} /> Closed — the transaction is locked.</div>
          <div style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)', marginTop: 2 }}>
            {isSuperAdmin ? 'You have Super Admin access and can edit this transaction.' : 'No editing is permitted on a Closed transaction. Only a Super Admin can make changes.'}
          </div>
        </div>
      )}

      {/* §5.1 — DFT edit-approval banner (Admins request; Super Admin approves). */}
      {stDFT && !stClosed && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--warn-bg)' }}>
          <div style={{ fontWeight: 700, color: 'var(--warn-ink-alt)' }}><Icon name="lock" size={13} /> DFT — direct edits are locked.</div>
          <div style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)', marginTop: 2 }}>
            {isSuperAdmin ? 'You can edit directly, or review Admin edit requests below.' : 'Admins must request an edit; a Super Admin approves before changes can be saved.'}
          </div>
          {pendingReq && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5 }}><strong>Pending:</strong> {pendingReq.requested_by_name}{pendingReq.reason ? ` — ${pendingReq.reason}` : ''}</span>
              {isSuperAdmin && <><button className="btn primary sm" onClick={() => onApproveReq(pendingReq.id)}>Approve</button><button className="btn ghost sm" onClick={() => onRejectReq(pendingReq.id)}>Reject</button></>}
            </div>
          )}
          {approvedReq && <div className="help" style={{ marginTop: 6, color: 'var(--ok-ink)' }}><Icon name="check" size={12} /> Edit approved by {approvedReq.reviewed_by_name} — changes can now be saved.</div>}
        </div>
      )}

      {/* Transaction deletion approval workflow banner. */}
      {deleteReq && (
        <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--bad-bg)' }}>
          <div style={{ fontWeight: 700, color: 'var(--bad-ink)' }}><Icon name="trash" size={13} /> Deletion {deleteReq.status === 'forwarded' ? 'forwarded to Super Admin' : 'requested'}</div>
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
              <button className="btn sm" style={{ background: 'var(--bad)', color: '#fff' }} onClick={onApproveDelete}>Approve &amp; Delete</button>
              <button className="btn ghost sm" onClick={onRejectDelete}>Reject</button>
            </>)}
            {isAgent && <span className="pill warn" style={{ fontSize: 10 }}>Your deletion request is {deleteReq.status === 'forwarded' ? 'with the Super Admin' : 'pending admin review'}</span>}
          </div>
        </div>
      )}

      {/* Agent changes awaiting admin review (admins only). */}
      {isAdminOrAbove && agentChanges.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #d97706', background: 'var(--warn-bg-2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, color: 'var(--warn-ink)' }}><Icon name="bell" size={13} /> {agentChanges.length} change{agentChanges.length === 1 ? '' : 's'} by the agent — please review</div>
            <button className="btn primary sm" onClick={onReviewAgentChanges}><Icon name="check" size={13} /> Mark reviewed</button>
          </div>
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {agentChanges.map((c, idx) => (
              <div key={c.id ?? idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--warn-ink-deep)', padding: '5px 0', borderTop: idx ? '1px solid #fde68a' : 'none' }}>
                {c.id && (
                  <input type="checkbox" style={{ flexShrink: 0 }} checked={picked.includes(c.id)}
                    title="Select for a bulk rejection" onChange={() => togglePicked(c.id!)} />
                )}
                <div style={{ minWidth: 0 }}>
                  <strong>{c.section ? `${c.section} — ` : ''}{c.field || c.action}</strong>
                  {(c.old_value || c.new_value) && <span> : <span style={{ color: 'var(--bad-ink)' }}>{c.old_value || '—'}</span> → <span style={{ color: 'var(--ok-ink)' }}>{c.new_value || '—'}</span></span>}
                  <span style={{ color: 'var(--muted)' }}> · {c.who}{c.stamp ? ` · ${c.stamp}` : ''}</span>
                </div>
                {c.id && <button className="btn ghost sm" style={{ flexShrink: 0, color: 'var(--bad-ink)' }} title="Reject this change, with a reason the agent will be sent" onClick={() => onRejectAgentChange(c.id!)}><Icon name="undo" size={13} /> Reject</button>}
              </div>
            ))}
          </div>
          {/* Bulk rejection: one reason, one record each. Appears only once something is ticked. */}
          {picked.length > 0 && (
            <div className="rev-bulk">
              <strong style={{ fontSize: 12.5, color: 'var(--warn-ink)' }}>{picked.length} selected</strong>
              <button className="btn sm" style={{ background: 'var(--bad)', color: '#fff' }} onClick={onRejectSelected}>
                <Icon name="undo" size={12} /> Reject selected with one reason
              </button>
              <button className="btn ghost sm" onClick={() => setPicked([])}>Clear</button>
              <span className="muted">Each becomes its own record and its own lifecycle.</span>
            </div>
          )}
        </div>
      )}

      {/*
        The decision dialog. A rejection cannot be submitted without a reason — the button stays
        disabled — because the reason is the whole message the agent receives; a rejection without
        one tells them something is wrong and nothing about what.
      */}
      {decision && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !deciding) setDecision(null); }}>
          <div className="modal">
            <button className="close" onClick={() => !deciding && setDecision(null)}>✕</button>
            <div className="modal-h">{decision.kind === 'review' ? 'Mark reviewed' : decision.kind === 'reject-many' ? `Reject ${picked.length} changes` : 'Reject this change'}</div>
            <p className="help" style={{ marginTop: 0 }}>
              {decision.kind !== 'review'
                ? 'The agent is sent this reason by email and sees it on the transaction. It is kept in the review history for good.'
                : 'An optional note — what you checked, for the record. Anything the agent has already corrected is approved at the same time.'}
            </p>
            <div className="field">
              <label>{decision.kind === 'review' ? 'Note' : <>Reason <span className="req">*</span></>}</label>
              <textarea
                rows={3}
                autoFocus
                value={decision.text}
                disabled={deciding}
                placeholder={decision.kind === 'review' ? 'Verified against APS.' : 'Purchase price doesn’t match the APS.'}
                onChange={(e) => setDecision((d) => (d ? { ...d, text: e.target.value } : d))}
              />
            </div>
            <div className="actions">
              <button className="btn ghost" disabled={deciding} onClick={() => setDecision(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={deciding || (decision.kind !== 'review' && decision.text.trim() === '')}
                onClick={() => void submitDecision()}
              >
                {deciding ? 'Saving…' : decision.kind === 'review' ? 'Mark reviewed' : decision.kind === 'reject-many' ? `Reject ${picked.length} changes` : 'Reject change'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        Closing was refused because review items are still outstanding. The list is shown rather
        than a bare message, so the decision to override is made while looking at what is being
        overridden.
      */}
      {closeBlock && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setCloseBlock(null); }}>
          <div className="modal">
            <button className="close" onClick={() => !saving && setCloseBlock(null)}>✕</button>
            <div className="modal-h">Unresolved review items</div>
            <p className="help" style={{ marginTop: 0 }}>{closeBlock.message}</p>
            <ul className="tmpl-files" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {closeBlock.items.map((i) => (
                <li key={i.id}>
                  <span className={`pill ${i.resolution_status === 'Corrected' ? 'warn' : 'bad'}`} style={{ fontSize: 10 }}>{i.resolution_status}</span>
                  <span style={{ minWidth: 0 }}><strong>{i.field_label ?? 'A change'}</strong>{i.reason ? ` — ${i.reason}` : ''}</span>
                </li>
              ))}
            </ul>
            <div className="field">
              <label>Reason for closing anyway <span className="req">*</span></label>
              <textarea rows={2} autoFocus value={closeBlock.reason} disabled={saving}
                placeholder="Settled with the agent by phone; the APS was amended."
                onChange={(e) => setCloseBlock((c) => (c ? { ...c, reason: e.target.value } : c))} />
              <span className="help">Recorded on the audit trail against this transaction.</span>
            </div>
            <div className="actions">
              <button className="btn ghost" disabled={saving} onClick={() => setCloseBlock(null)}>Cancel</button>
              <button className="btn primary" disabled={saving || closeBlock.reason.trim() === ''}
                onClick={() => void save(closeBlock.reason.trim())}>
                {saving ? 'Saving…' : 'Close anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The permanent record of every decision on this deal — office and assigned agent alike. */}
      <ReviewHistoryPanel key={reviewsKey} txnId={Number(id)} />

      {/* §5.2 — Active sale listing: reminder for pending core documents */}
      {stActive && coreDocReminders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #d97706', background: 'var(--warn-bg-2)' }}>
          <div style={{ fontWeight: 700, color: 'var(--warn-ink)' }}><Icon name="clock" size={13} /> Reminder — core listing documents pending</div>
          <div style={{ fontSize: 12.5, color: 'var(--warn-900)', marginTop: 2 }}>
            The following must be received to complete the Active listing:
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5, color: 'var(--warn-900)' }}>
            {coreDocReminders.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => setDocsOpen(true)}><Icon name="folder" size={13} /> Open Legal &amp; Documentation</button>
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
                  background: s.pass ? 'var(--ok-600)' : (idx === curStage ? 'var(--brand)' : 'var(--line)'),
                  color: s.pass || idx === curStage ? '#fff' : '#6b7280' }}>{s.pass ? <Icon name="check" size={13} /> : idx + 1}</div>
                <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap',
                  color: s.pass ? 'var(--ok-ink)' : (idx === curStage ? 'var(--brand)' : '#9ca3af') }}>{s.label}</div>
              </div>
              {idx < stages.length - 1 && <div style={{ flex: 1, height: 2, background: 'var(--line)', marginTop: 13 }} />}
            </div>
          ))}
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--line)', marginTop: 12, overflow: 'hidden' }}>
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
                    style={{ cursor: ro ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, textTransform: 'none', padding: '2px 8px', borderRadius: 6, border: `1px solid ${form.mls_verified ? 'var(--ok-600)' : 'var(--brand-red)'}`, color: form.mls_verified ? 'var(--ok-600)' : 'var(--brand-red)', background: form.mls_verified ? 'var(--ok-bg)' : '#fff1f2' }}>
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
                <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: 'var(--surface-2)' }} /></Field>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: referral ? '1fr 1.5fr 1fr' : '1fr 1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Agent Name">
                {isAgent
                  ? <input value={form.agent} readOnly style={{ background: 'var(--surface-2)', cursor: 'not-allowed' }} title="The agent who creates the transaction is its primary agent." />
                  : (<>
                    {/* TD-045 - the agent is PICKED, not typed. This was an <input list> with a
                      * <datalist>, which only SUGGESTS: any text was accepted and saved, so one
                      * agent could appear several times in Analytics under different spellings.
                      * A deal may still name an external or co-op agent who has no account, so
                      * that stays possible - but as a deliberate choice rather than a typo. */}
                    <select
                      value={externalAgent || (!!form.agent && !agents.includes(form.agent)) ? '__external__' : (form.agent || '')}
                      disabled={ro}
                      onChange={(e) => {
                        if (e.target.value === '__external__') { setExternalAgent(true); set('agent', ''); }
                        else { setExternalAgent(false); set('agent', e.target.value); }
                      }}
                    >
                      <option value="">Select agent</option>
                      {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                      <option value="__external__">External / co-op agent…</option>
                    </select>
                    {(externalAgent || (!!form.agent && !agents.includes(form.agent))) && (
                      <input value={form.agent} disabled={ro} onChange={(e) => set('agent', e.target.value)} placeholder="External agent name" style={{ marginTop: 6 }} />
                    )}
                  </>)}
              </Field>
              <Field label="Property Address" req><input value={form.property} disabled={ro} onChange={(e) => set('property', e.target.value)} /></Field>
              {!hidePriceDeposit && <Field label={priceLabel}><MoneyInput value={form.price} disabled={ro} onChange={(v) => set('price', v)} /></Field>}
              {!hidePriceDeposit && !referral && <Field label="Deposit"><MoneyInput value={form.deposit} disabled={ro} onChange={(v) => set('deposit', v)} /></Field>}
            </div>
            {!OFFER_CLOSING_LISTING_TYPES.includes(form.type) && (
              <div className="g3">
                <Field label="Trade Number"><input value={form.trade_no} readOnly style={{ background: 'var(--surface-2)' }} /></Field>
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
                  <Icon name="receipt" size={13} /> {generating ? 'Creating…' : (precon ? `Create Term Invoice${(parseInt(String(form.precon_term_count), 10) || 0) === 1 ? '' : 's'}` : 'Create Invoice')}
                </button>
              )}
              {!docsOnly && !slNoSections && canEdit && form.agent && teamSplitVisible && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setTeamOpen(true)}><Icon name="users" size={13} /> Team Split</button>}
              {!docsOnly && !slHideLawyer && canEdit && !lawyerHidden && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setLawyerOpen(true)}><Icon name="scale" size={13} /> Lawyer Details</button>}
              {canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setDocsOpen(true)}><Icon name="report" size={13} /> Legal &amp; Docs</button>}
              {/* Admin Activities, Adjustment and Audit Trail are admin-only (hidden from agents). */}
              {!isAgent && !docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdminOpen(true)}><Icon name="wrench" size={13} /> Admin</button>}
              {!docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFinOpen(true)}><Icon name="dollar" size={13} /> Financial</button>}
              {!isAgent && !docsOnly && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAdjOpen(true)}><Icon name="scale" size={13} /> Adjustment</button>}
              {/*
                TD-049 — was "Agent FAQ Center", which described nothing in it. The panel is the
                agent-payment readiness workflow, and under the old name the people who needed it
                had no reason to open it.

                THE RENAME IS THE LABEL ONLY, deliberately. `AgentFaqModal`, `setFaqOpen` and the
                rest keep their names, and so do two stored strings: the audit entries written with
                section 'Quick Actions — Agent FAQ', because renaming those would leave new rows
                disagreeing with years of history in the one record that exists to be consistent;
                and the `agent_faq.batch_review` mail template, whose key identifies saved
                templates in the database.
              */}
              {!docsOnly && !slNoSections && canEdit && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setFaqOpen(true)}><Icon name="analytics" size={13} /> Agent Payment Readiness</button>}
              {!isAgent && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAuditOpen(true)}><Icon name="clipboard" size={13} /> Audit Trail</button>}
              {/*
                TD-110 — an agent can see what THEY changed on their own deal.
                The Audit Trail itself stays an office screen: it carries every field the office has
                ever touched, including commission figures. What an agent was missing is their own
                history — the thing they are asked to account for when a change is queried or
                reverted — so they get the same table over their own rows.
              */}
              {isAgent && <button className="btn ghost sm" style={{ textAlign: 'left' }} onClick={() => setAuditOpen(true)}><Icon name="clipboard" size={13} /> My Changes</button>}
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
              {/* Kept beside the field that uses it: TD-045 turned Agent Name into a <select> and
                * removed the shared <datalist> this input had been borrowing, silently breaking
                * its suggestions - so it now owns the list it points at. */}
              <datalist id="agentList">{agents.map((a) => <option key={a} value={a} />)}</datalist>
            </Field>
            <Field label="Commission Receivable in Terms">
              <input type="number" min="0" max="200" value={form.precon_term_count} disabled={ro} onChange={(e) => set('precon_term_count', e.target.value)} placeholder="e.g. 3" />
            </Field>
          </div>
          {(() => {
            const tc = parseInt(String(form.precon_term_count), 10) || 0;
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
          <span className="help">Set the number of terms and the closing date{(parseInt(String(form.precon_term_count), 10) || 0) === 1 ? '' : 's'} here; open <strong>Financial</strong> to enter each term's commission %.</span>
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
            options={brokSuggestions} getLabel={(s) => s.name || ''}
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
                      {!ro && form.brokerage.agents.length > 1 && <button className="row-rm" onClick={() => rmBrokAgent(i)}><Icon name="trash" size={13} /></button>}
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
              {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmClient(i)}><Icon name="trash" size={13} /></button>}
            </div>
          </div>
        ))}
        {!ro && <button className="btn primary sm" onClick={addClient}>+ Add Client</button>}
      </div>

      {/* Conditional Offer — hidden for preconstruction, referral, §5.2 Active/Terminated sale listings, Void / Mutual Release, Secured Firm, and once Sold/Leased */}
      {!precon && !referral && !slHideBasic && !docsOnly && !stSecuredFirm && !stSoldOrLeased && (
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Conditional Offer</div>
        <Field label="Is Offer Conditional?" style={{ maxWidth: 220 }}>
          <select value={form.conditional_offer ? 'Yes' : 'No'} disabled={ro} onChange={(e) => { const yes = e.target.value === 'Yes'; set('conditional_offer', yes); if (yes && form.conditions.length === 0) addCond(); }}>
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
                    {!ro && !isAgent && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}><Icon name="trash" size={13} /></button>}
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
                    {!ro && !isAgent && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmCond(i)}><Icon name="trash" size={13} /></button>}
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
            <select value={form.inter_board_enabled ? 'Yes' : 'No'} disabled={ro} onChange={(e) => { const yes = e.target.value === 'Yes'; set('inter_board_enabled', yes); if (yes && form.inter_board_listings.length === 0) addIb(); }}>
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
                  {!ro && <button className="row-rm" style={{ paddingBottom: 10 }} onClick={() => rmIb(i)}><Icon name="trash" size={13} /></button>}
                </div>
              ))}
              {!ro && <button className="btn primary sm" style={{ marginTop: 6 }} onClick={addIb}>+ Add Inter Board listing</button>}
            </div>
          )}
        </div>
      )}

      </div>

      {/* A section was opened with an edit still in flight — land it first, then let the
          section mount so it reads the saved values. */}
      {holdSections && (
        <div className="overlay open">
          <div className="modal" style={{ maxWidth: 320, textAlign: 'center', padding: '26px 24px' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}><Icon name="clock" size={14} /> Saving your changes…</div>
            <p className="help" style={{ marginTop: 6 }}>Opening as soon as this transaction is up to date.</p>
          </div>
        </div>
      )}

      {!holdSections && (<>
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
          termCount={parseInt(String(form.precon_term_count), 10) || 0}
          onSaved={applyUpdated}
          readOnly={teamReadOnly}
          readOnlyReason={teamReadOnlyReason}
          lockAgents={teamLockAgents}
          canManageAccess={!isAgent || isOwnerAgent}
        />
      )}
      {finOpen && txn && (
        <FinancialModal
          open={finOpen}
          onClose={() => setFinOpen(false)}
          transactionId={id}
          txn={txn}
          termCount={precon ? (parseInt(String(form.precon_term_count), 10) || 0) : undefined}
          hideClientCommission={slDepositOnly}
          dftNA={stDFT}
          readOnly={view || isAgent || (closedAndPaid && !isSuperAdmin)}
          isAgent={isAgent}
          onSaved={applyUpdated}
        />
      )}
      {docsOpen && (
        <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} transactionId={id} txn={txn} restrictTitles={docRestrict} hideTitles={stMutualRelease ? [] : ['mutual release']} readOnly={isAgent ? false : (isDocumentation ? false : view)} agentMode={isAgent} canDeleteConditionDocs={isSuperAdmin} onSaved={reloadTxn} />
      )}
      {invoiceOpen && txn && (
        <InvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} txn={txn} />
      )}
      {nosOpen && txn && (
        <NoticeOfSaleModal open={nosOpen} onClose={() => setNosOpen(false)} txn={txn} onSaved={reloadTxn} />
      )}
      {tsOpen && txn && (
        <TradeSheetModal open={tsOpen} onClose={() => setTsOpen(false)} txn={txn} />
      )}
      {lawyerOpen && txn && (
        <LawyerModal open={lawyerOpen} onClose={() => setLawyerOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} readOnly={view} isAgent={isAgent} />
      )}
      {auditOpen && txn && (
        <AuditTrailModal
          open={auditOpen}
          onClose={() => setAuditOpen(false)}
          txn={txn}
          // TD-110 — an agent's own rows, under their own heading. Office seats keep the trail.
          entries={isAgent ? (txn.my_changes ?? []) : undefined}
          title={isAgent ? 'My Changes' : undefined}
        />
      )}
      {adminOpen && txn && (
        <AdminActivitiesModal open onClose={() => setAdminOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} depositOnly={slDepositOnly} dftNA={stDFT} readOnly={view} termCount={precon ? (parseInt(String(form.precon_term_count), 10) || 0) : undefined} />
      )}
      {faqOpen && txn && (
        <AgentFaqModal open onClose={() => setFaqOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} depositSlipOnly={slDepositOnly} dftNA={stDFT} readOnly={view || isAgent} allowBatchEmail={isAgent} isAgent={isAgent} termCount={precon ? (parseInt(String(form.precon_term_count), 10) || 0) : undefined} />
      )}
      {adjOpen && txn && (
        <AdjustmentModal open onClose={() => setAdjOpen(false)} transactionId={id} txn={txn} onSaved={applyUpdated} readOnly={adjReadOnly} termCount={precon ? (parseInt(String(form.precon_term_count), 10) || 0) : undefined} />
      )}
      {chatOpen && (
        <ChatModal open onClose={() => setChatOpen(false)} transactionId={id} />
      )}
      {depositOpen && txn && (
        <DepositReceiptModal open onClose={() => setDepositOpen(false)} txn={txn} settings={invSettings} />
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
      </>)}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function Field({ label, req, children, style }: { label: ReactNode; req?: boolean; children: ReactNode; style?: CSSProperties }) {
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
function StatusMultiSelect({ options, selected, disabled, onToggle }: { options: string[]; selected: string[]; disabled?: boolean; onToggle: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
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
          padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: disabled ? 'var(--surface-2)' : '#fff',
          fontSize: 13, color: selected.length ? 'var(--text)' : 'var(--muted)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {!disabled && <span style={{ color: 'var(--muted)', flexShrink: 0 }}><Icon name="chevronDown" size={12} /></span>}
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
