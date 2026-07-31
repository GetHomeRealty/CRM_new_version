import type { AxiosRequestConfig } from 'axios';
import api from './axios';
import type { EmailTemplateAttachment, AgentChangeNotif, AgentCommissionMap, AgentLoanMap, AuditLogPage, BrokerageSuggestion, ChatMessage, ClientIdentification, CompanySettings, DashboardCommissions, DealHistoryEntry, DeletionLogEntry, DocNotif, DocumentsResponse, EmailTemplate, EmailTemplatesResponse, GenerateInvoicesResult, Invoice, LawyerSuggestion, MailAccount, ManagedRole, ManagedUser, NoticeOfSaleData, SendResult, TemplatePreview, TestMailResult, Transaction, TrashedDocument, TrashedInvoice, TrashedPayment, TrashedResponse, TrashedRowItem, TrashedTransaction, UsersCatalog, CrmDashboard, DeskDashboard } from '../types';

/** Route parameter identifiers (Laravel accepts numeric or string ids). */
type Id = number | string;

/**
 * Multipart uploads: unset the JSON Content-Type so the browser sets the
 * multipart boundary itself. axios's header value type excludes `undefined`,
 * so this single shape is asserted once — the runtime value MUST remain
 * `undefined` (do not change it to a string, or the boundary is lost).
 */
const MULTIPART = { headers: { 'Content-Type': undefined } } as unknown as AxiosRequestConfig;

// --- Agent onboarding emails (Users screen) ---
export interface OnboardingPreview {
  kind: 'onboard' | 'contract';
  event_key: string;
  subject: string;
  html: string;
  to: string;
  variables: string[];
  attachments: { id: number; filename: string; size: number }[];
  /**
   * The document generated from this message and attached to the send — the agreement itself, for a
   * contract. Its size is not known until it is rendered, so only the name comes back.
   */
  generated_document: string | null;
  sender: string | null;
  /** Anything that would make the send fail or arrive incomplete. */
  warning: string | null;
  /** Which warning it is, so the screen can decide when it stops applying. */
  warning_kind: 'no_recipient' | 'template_off' | null;
}

/** The message as it would arrive for this agent — read-only, nothing is sent. */
export const getOnboardingPreview = (userId: Id, kind: 'onboard' | 'contract'): Promise<OnboardingPreview> =>
  api.get<OnboardingPreview>(`/api/users/${userId}/onboarding/${kind}`).then((r) => r.data);

/** A file attached to one send only — not stored on the template. */
export interface OnboardingAttachment {
  filename: string;
  content_type?: string;
  /** Base64, without the data: prefix. */
  data: string;
}

/** Send it. Subject/body are the reviewed version and win over the stored template. */
export const sendOnboardingEmail = (
  userId: Id,
  kind: 'onboard' | 'contract',
  edited: { subject?: string; html?: string; attachments?: OnboardingAttachment[] },
): Promise<{ message: string; to: string }> =>
  api.post(`/api/users/${userId}/onboarding/${kind}`, edited).then((r) => r.data);

// --- Transactions ---
/**
 * Every transaction the caller may see, unpaginated.
 *
 * Kept for the screens that aggregate over the whole set — Dashboard, Analytics, Commission
 * Analytics and the calendar's deal picker — which would report wrong totals from a page.
 * The transactions list itself uses `listTransactionsPage`.
 */
export const listTransactions = (): Promise<Transaction[]> =>
  api.get<{ data: Transaction[] }>('/api/transactions').then((r) => r.data.data);

/** Filters accepted by the paginated list. Names match the query string the API expects. */
export interface TransactionQuery {
  page?: number;
  per_page?: number;
  q?: string;
  year?: string;
  type?: string;
  validation?: string;
  agent?: string;
  commission?: string;
  status?: string;
  offer_from?: string;
  offer_to?: string;
  closing_from?: string;
  closing_to?: string;
  payout?: string;
  client?: string;
  brokerage?: string;
}

export interface TransactionPage {
  data: Transaction[];
  meta: {
    current_page: number;
    per_page: number;
    last_page: number;
    total: number;
    /** Ids of everything matching the filters, not just this page — for "select all". */
    ids: number[];
    years: string[];
    pending_deletions: Transaction[];
    /** Review counters for the rows on this page, keyed by transaction id. Absent on older APIs. */
    review_counts?: Record<number, { open: number; corrected: number; resolved: number }>;
  };
}

/**
 * One filtered page. Filtering runs in the database, so the counts and the "select all N
 * matching" action describe the entire result set rather than the rows currently on screen.
 * Blank filter values are dropped so they never reach the API as empty strings.
 */
export const listTransactionsPage = (query: TransactionQuery): Promise<TransactionPage> => {
  const params: Record<string, string | number> = { page: query.page ?? 1, per_page: query.per_page ?? 25 };
  for (const [k, v] of Object.entries(query)) {
    if (k === 'page' || k === 'per_page') continue;
    if (typeof v === 'string' && v.trim() !== '') params[k] = v.trim();
  }
  return api.get<TransactionPage>('/api/transactions', { params }).then((r) => r.data);
};

export const getDashboardCommissions = (): Promise<DashboardCommissions> =>
  api.get<DashboardCommissions>('/api/dashboard/commissions').then((r) => r.data);

/**
 * The two dashboards, as two calls. Each reads only its own area's tables on the server, so neither
 * one pays for the other's queries — which is the point of section 10.
 */
export const getCrmDashboard = (): Promise<CrmDashboard> =>
  api.get<CrmDashboard>('/api/dashboard/crm').then((r) => r.data);

export const getDeskDashboard = (): Promise<DeskDashboard> =>
  api.get<DeskDashboard>('/api/dashboard/desk').then((r) => r.data);

export const getTransaction = (id: Id): Promise<Transaction> =>
  api.get<{ data: Transaction }>(`/api/transactions/${id}`).then((r) => r.data.data);

export const createTransaction = (payload: unknown): Promise<Transaction> =>
  api.post<{ data: Transaction }>('/api/transactions', payload).then((r) => r.data.data);

export const updateTransaction = (id: Id, payload: unknown): Promise<Transaction> =>
  api.put<{ data: Transaction }>(`/api/transactions/${id}`, payload).then((r) => r.data.data);

export const deleteTransaction = (id: Id): Promise<unknown> =>
  api.delete(`/api/transactions/${id}`).then((r) => r.data);

// --- Transaction deletion approval workflow ---
export const requestTransactionDeletion = (id: Id, reason: string): Promise<unknown> =>
  api.post(`/api/transactions/${id}/delete-requests`, { reason }).then((r) => r.data);
export const forwardDeleteRequest = (reqId: Id, reason: string): Promise<unknown> =>
  api.post(`/api/delete-requests/${reqId}/forward`, { reason }).then((r) => r.data);
export const approveDeleteRequest = (reqId: Id): Promise<unknown> =>
  api.post(`/api/delete-requests/${reqId}/approve`).then((r) => r.data);
export const rejectDeleteRequest = (reqId: Id): Promise<unknown> =>
  api.post(`/api/delete-requests/${reqId}/reject`).then((r) => r.data);

export const getTransactionMessages = (id: Id): Promise<ChatMessage[]> =>
  api.get<ChatMessage[]>(`/api/transactions/${id}/messages`).then((r) => r.data);

// --- §5.1 edit-approval workflow (DFT / Closed) ---
export const requestTransactionEdit = (id: Id, reason: string, scope: string | null = null): Promise<unknown> =>
  api.post(`/api/transactions/${id}/edit-requests`, { reason, scope }).then((r) => r.data);
export const approveEditRequest = (reqId: Id): Promise<unknown> =>
  api.post(`/api/edit-requests/${reqId}/approve`).then((r) => r.data);
export const rejectEditRequest = (reqId: Id): Promise<unknown> =>
  api.post(`/api/edit-requests/${reqId}/reject`).then((r) => r.data);
/** `note` is optional — what was checked, kept on the review record. */
export const reviewAgentChanges = (id: Id, note?: string): Promise<Transaction> =>
  api.post<{ data: Transaction }>(`/api/transactions/${id}/review-agent-changes`, { note: note ?? '' }).then((r) => r.data.data);
/** `reason` is required — the server refuses a rejection without one. */
export const rejectAgentChange = (id: Id, auditId: Id, reason: string): Promise<Transaction> =>
  api.post<{ data: Transaction }>(`/api/transactions/${id}/reject-agent-change`, { audit_id: auditId, reason }).then((r) => r.data.data);

// --- Review history (loaded on its own, so the transaction screen is not made heavier by it) ---
export interface TransactionReview {
  id: number;
  audit_log_id: number | null;
  decision: 'Reviewed' | 'Rejected';
  reason: string | null;
  field_label: string | null;
  old_value: string | null;
  new_value: string | null;
  agent_name: string | null;
  actor_name: string | null;
  auto_reverted: boolean;
  auto_revert_result: string | null;
  resolution_status: 'Open' | 'Corrected' | 'Resolved';
  corrected_at: string | null;
  corrected_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string | null;
}

export interface ReviewHistoryPage {
  data: TransactionReview[];
  meta: { total: number; page: number; per_page: number; last_page: number; open_count: number; can_decide: boolean };
}

export interface ReviewHistoryQuery {
  resolution?: string;
  decision?: string;
  reviewer?: string;
  agent?: string;
  field?: string;
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}

export const listTransactionReviews = (id: Id, query: ReviewHistoryQuery = {}): Promise<ReviewHistoryPage> => {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params[k] = v as string | number;
  return api.get<ReviewHistoryPage>(`/api/transactions/${id}/reviews`, { params }).then((r) => r.data);
};

/** Opening the deal clears the agent's review notifications for it. */
export const markTransactionReviewsSeen = (id: Id): Promise<unknown> =>
  api.post(`/api/transactions/${id}/reviews/seen`).then((r) => r.data);

export const getReviewNotifications = (): Promise<DocNotif> =>
  api.get<DocNotif>('/api/review-notifications').then((r) => r.data);

export interface ReviewStats {
  open: number;
  corrected: number;
  overdue: number;
  overdue_after_hours: number;
  average_resolution_hours: number | null;
  resolved_sampled: number;
  by_agent: { name: string; count: number }[];
  by_staff: { name: string; count: number }[];
  scope: 'own' | 'brokerage';
}

/** Dashboard figures. Its own endpoint — the desk dashboard does not pay for them. */
export const getReviewStats = (): Promise<ReviewStats> =>
  api.get<ReviewStats>('/api/dashboard/reviews').then((r) => r.data);

export interface OpenReviewItem {
  id: number;
  field_label: string | null;
  reason: string | null;
  resolution_status: string;
  created_at: string | null;
}

/** What is still unresolved on a deal — read before offering to close it. */
export const getOpenReviews = (id: Id): Promise<{ data: OpenReviewItem[]; meta: { total: number; open: number; corrected: number; blocks_closing: boolean } }> =>
  api.get(`/api/transactions/${id}/reviews/open`).then((r) => r.data);

/** Reject several changes under one reason, or approve several corrections at once. */
export const bulkReviewAction = (
  id: Id,
  action: 'reject' | 'approve',
  ids: number[],
  text: string,
): Promise<{ rejected?: number; resolved?: number; skipped?: unknown }> =>
  api.post(`/api/transactions/${id}/reviews/bulk`, { action, ids, reason: text, note: text }).then((r) => r.data);
export const getAgentChangeNotifications = (): Promise<AgentChangeNotif> =>
  api.get<AgentChangeNotif>('/api/agent-change-notifications').then((r) => r.data);
export const postTransactionMessage = (id: Id, body: string): Promise<ChatMessage[]> =>
  api.post<ChatMessage[]>(`/api/transactions/${id}/messages`, { body }).then((r) => r.data);

// --- Documents (Legal & Documentation) ---
export const getDocuments = (txnId: Id): Promise<DocumentsResponse> =>
  api.get<DocumentsResponse>(`/api/transactions/${txnId}/documents`).then((r) => r.data);

export const saveDocuments = (txnId: Id, documents: unknown[], extra: Record<string, unknown> = {}): Promise<DocumentsResponse> =>
  api.put<DocumentsResponse>(`/api/transactions/${txnId}/documents`, { documents, ...extra }).then((r) => r.data);

export const sendDocumentReminders = (txnId: Id): Promise<{ message?: string; count?: number; recipients?: string[] }> =>
  api.post<{ message?: string; count?: number; recipients?: string[] }>(`/api/transactions/${txnId}/documents/send-reminders`).then((r) => r.data);

export const uploadDocumentFile = (txnId: Id, docId: Id, file: File): Promise<DocumentsResponse> => {
  const fd = new FormData();
  fd.append('file', file);
  return api
    .post<DocumentsResponse>(`/api/transactions/${txnId}/documents/${docId}/file`, fd, MULTIPART)
    .then((r) => r.data);
};

export const deleteDocument = (docId: Id): Promise<unknown> => api.delete(`/api/documents/${docId}`).then((r) => r.data);
export const restoreDocument = (docId: Id): Promise<unknown> => api.post(`/api/documents/${docId}/restore`).then((r) => r.data);

// --- Notice of Sale ---
export const getNoticeOfSale = (txnId: Id): Promise<NoticeOfSaleData> => api.get<NoticeOfSaleData>(`/api/transactions/${txnId}/notice-of-sale`).then((r) => r.data);
export const saveNoticeOfSale = (txnId: Id, payload: unknown): Promise<NoticeOfSaleData> => api.put<NoticeOfSaleData>(`/api/transactions/${txnId}/notice-of-sale`, payload).then((r) => r.data);
export const sendNoticeOfSale = (txnId: Id, agents: unknown, extra: Record<string, unknown> = {}): Promise<NoticeOfSaleData> => api.post<NoticeOfSaleData>(`/api/transactions/${txnId}/notice-of-sale/send`, { agents, ...extra }).then((r) => r.data);

// --- Deposit Receipt ---
export const sendDepositReceipt = (txnId: Id, email: string, cc?: unknown): Promise<SendResult> => api.post<SendResult>(`/api/transactions/${txnId}/deposit-receipt/send`, { email, cc }).then((r) => r.data);
export const sendTradeSheet = (txnId: Id, email: string, extra: Record<string, unknown> = {}): Promise<SendResult> => api.post<SendResult>(`/api/transactions/${txnId}/trade-sheet/send`, { email, ...extra }).then((r) => r.data);

// --- FINTRAC per-client identity (Form 630 auto-fill) ---
export const getClientIdentification = (txnId: Id, clientName: string): Promise<ClientIdentification | null> =>
  api.get<ClientIdentification | null>(`/api/transactions/${txnId}/identifications`, { params: { client_name: clientName } }).then((r) => r.data);
export const saveClientIdentification = (txnId: Id, payload: unknown): Promise<ClientIdentification> =>
  api.put<ClientIdentification>(`/api/transactions/${txnId}/identifications`, payload).then((r) => r.data);
export const extractClientIdentification = (txnId: Id, clientName: string, documentId: Id): Promise<unknown> =>
  api.post(`/api/transactions/${txnId}/identifications/extract`, { client_name: clientName, document_id: documentId }).then((r) => r.data);

// §13 multi-file / per-client uploads (clientName optional)
export const uploadDocClientFile = (txnId: Id, docId: Id, file: File, clientName?: string): Promise<DocumentsResponse> => {
  const fd = new FormData();
  fd.append('file', file);
  if (clientName) fd.append('client_name', clientName);
  return api.post<DocumentsResponse>(`/api/transactions/${txnId}/documents/${docId}/files`, fd, MULTIPART).then((r) => r.data);
};
export const deleteDocClientFile = (txnId: Id, docId: Id, index: number): Promise<DocumentsResponse> =>
  api.delete<DocumentsResponse>(`/api/transactions/${txnId}/documents/${docId}/files/${index}`).then((r) => r.data);

// §13 Invalid-validation supporting attachment
export const uploadDocValidationFile = (txnId: Id, docId: Id, file: File): Promise<DocumentsResponse> => {
  const fd = new FormData();
  fd.append('file', file);
  return api.post<DocumentsResponse>(`/api/transactions/${txnId}/documents/${docId}/validation-file`, fd, MULTIPART).then((r) => r.data);
};
export const deleteDocValidationFile = (txnId: Id, docId: Id): Promise<DocumentsResponse> =>
  api.delete<DocumentsResponse>(`/api/transactions/${txnId}/documents/${docId}/validation-file`).then((r) => r.data);

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
export const documentFileUrl = (docId: Id): string => `${apiBase}/api/documents/${docId}/file`;
export const docClientFileUrl = (docId: Id, index: number): string => `${apiBase}/api/documents/${docId}/files/${index}`;
export const documentsDownloadAllUrl = (txnId: Id): string => `${apiBase}/api/transactions/${txnId}/documents/download-all`;
export const docValidationFileUrl = (docId: Id): string => `${apiBase}/api/documents/${docId}/validation-file`;

// Fetch a protected file through the authenticated axios instance (sends the Sanctum
// session cookie + XSRF), then view it in a new tab or trigger a download. A bare
// <a href> to the cross-origin API doesn't carry that auth, which is why plain links
// failed to view/download after deployment.
const fetchFileBlob = async (path: string, { inline = false }: { inline?: boolean } = {}): Promise<void> => {
  const res = await api.get<Blob>(path, { responseType: 'blob' });
  const dispo = String(res.headers['content-disposition'] ?? '');
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(dispo);
  const name = m ? decodeURIComponent(m[1]) : 'download';
  const url = URL.createObjectURL(res.data);
  if (inline) {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
export const viewDocumentFile = (docId: Id): Promise<void> => fetchFileBlob(`/api/documents/${docId}/file?inline=1`, { inline: true });
export const downloadDocumentFile = (docId: Id): Promise<void> => fetchFileBlob(`/api/documents/${docId}/file`);
export const viewDocClientFile = (docId: Id, index: number): Promise<void> => fetchFileBlob(`/api/documents/${docId}/files/${index}?inline=1`, { inline: true });
export const downloadDocClientFile = (docId: Id, index: number): Promise<void> => fetchFileBlob(`/api/documents/${docId}/files/${index}`);
export const viewDocValidationFile = (docId: Id): Promise<void> => fetchFileBlob(`/api/documents/${docId}/validation-file?inline=1`, { inline: true });
export const downloadAllDocuments = (txnId: Id): Promise<void> => fetchFileBlob(`/api/transactions/${txnId}/documents/download-all`);

/**
 * The bytes of one file that goes out with the onboarding email or contract agreement, so the review
 * screen can show it in place rather than in another tab. Returns the blob instead of opening it,
 * unlike the viewers above; it still has to come through the authenticated instance, because a plain
 * cross-origin link carries no session.
 */
export const fetchOnboardingAttachment = (kind: 'onboard' | 'contract', attachmentId: Id): Promise<Blob> =>
  api.get<Blob>(`/api/onboarding/${kind}/attachments/${attachmentId}`, { responseType: 'blob' }).then((r) => r.data);

/**
 * The document that will be attached, rendered from the message as it currently stands — so the copy
 * read here is the copy the agent receives, including an edit made a moment ago. The body is sent
 * with the request, which is why this is a POST; nothing is stored and nothing is sent.
 */
export const fetchOnboardingDocument = (userId: Id, kind: 'onboard' | 'contract', html: string): Promise<Blob> =>
  api.post<Blob>(`/api/users/${userId}/onboarding/${kind}/document`, { html }, { responseType: 'blob' }).then((r) => r.data);

// --- Document notifications (agent upload → admin; admin review → agent) ---
export const getDocNotifications = (): Promise<DocNotif> => api.get<DocNotif>('/api/doc-notifications').then((r) => r.data);
export const markDocNotificationsSeen = (txnId: Id): Promise<unknown> => api.post(`/api/transactions/${txnId}/doc-notifications/seen`).then((r) => r.data);

// --- Users / RBAC (admin) ---
export const getUsers = (): Promise<ManagedUser[]> => api.get('/api/users').then((r) => r.data);
export const getUsersCatalog = (): Promise<UsersCatalog> => api.get('/api/users/catalog').then((r) => r.data);
export const getUserDealHistory = (id: Id): Promise<DealHistoryEntry[]> => api.get(`/api/users/${id}/deal-history`).then((r) => r.data);
export const createUser = (payload: unknown): Promise<ManagedUser> => api.post('/api/users', payload).then((r) => r.data);
export const updateUser = (id: Id, payload: unknown): Promise<ManagedUser> => api.put(`/api/users/${id}`, payload).then((r) => r.data);
export const deleteUser = (id: Id): Promise<unknown> => api.delete(`/api/users/${id}`).then((r) => r.data);

// --- Roles & Permissions (Settings) ---
export const getRoles = (): Promise<ManagedRole[]> => api.get('/api/roles').then((r) => r.data);
export const createRole = (payload: { key: string; label: string; copy_from?: string }): Promise<ManagedRole> =>
  api.post('/api/roles', payload).then((r) => r.data);
export const updateRole = (id: Id, payload: { label?: string; is_active?: boolean }): Promise<ManagedRole> =>
  api.patch(`/api/roles/${id}`, payload).then((r) => r.data);
export const setRolePermissions = (id: Id, permissions: Record<string, string>): Promise<ManagedRole> =>
  api.put(`/api/roles/${id}/permissions`, { permissions }).then((r) => r.data);
export const deleteRole = (id: Id): Promise<{ message: string }> => api.delete(`/api/roles/${id}`).then((r) => r.data);

// --- Lead books (Super Admin) ---
export interface LeadBook { user_id: number; name: string; role: string; leads: number }
export const getLeadBooks = (): Promise<LeadBook[]> => api.get('/api/leads/books').then((r) => r.data);
export const transferLeadBook = (fromUserId: Id, toUserId: Id): Promise<{ moved: number; from: string; to: string }> =>
  api.post('/api/leads/transfer-ownership', { from_user_id: fromUserId, to_user_id: toUserId }).then((r) => r.data);

// --- Invoice module ---
export const getInvoices = (): Promise<Invoice[]> => api.get<Invoice[]>('/api/invoices').then((r) => r.data);
export const getInvoice = (id: Id): Promise<Invoice> => api.get<Invoice>(`/api/invoices/${id}`).then((r) => r.data);
export const createInvoice = (payload: unknown): Promise<Invoice> => api.post<Invoice>('/api/invoices', payload).then((r) => r.data);
export const generateTransactionInvoices = (txnId: Id): Promise<GenerateInvoicesResult> => api.post<GenerateInvoicesResult>(`/api/transactions/${txnId}/invoices`).then((r) => r.data);
export const updateInvoice = (id: Id, payload: unknown): Promise<Invoice> => api.put<Invoice>(`/api/invoices/${id}`, payload).then((r) => r.data);
export const deleteInvoice = (id: Id, reason?: string): Promise<unknown> => api.delete(`/api/invoices/${id}`, { data: { reason } }).then((r) => r.data);
export const recordInvoicePayment = (id: Id, payload: unknown): Promise<Invoice> => api.post<Invoice>(`/api/invoices/${id}/payments`, payload).then((r) => r.data);
export const deleteInvoicePayment = (id: Id, paymentId: Id): Promise<unknown> => api.delete(`/api/invoices/${id}/payments/${paymentId}`).then((r) => r.data);
export const recordInvoiceReminder = (id: Id, payload: unknown = {}): Promise<Invoice> => api.post<Invoice>(`/api/invoices/${id}/reminders`, payload).then((r) => r.data);
export const sendInvoice = (id: Id, payload: unknown = {}): Promise<Invoice> => api.post<Invoice>(`/api/invoices/${id}/send`, payload).then((r) => r.data);

export const changePassword = (payload: unknown): Promise<unknown> => api.post('/api/user/password', payload).then((r) => r.data);

export const getCompanySettings = (): Promise<CompanySettings> => api.get<CompanySettings>('/api/company-settings').then((r) => r.data);
export const updateCompanySettings = (payload: unknown): Promise<CompanySettings> => api.put<CompanySettings>('/api/company-settings', payload).then((r) => r.data);

/**
 * The brand logo endpoint. Absolute (not a relative path) because it is rendered by plain
 * <img> tags — including inside the print window, which has no page origin of its own.
 * The `v` cache-buster changes whenever the logo does, so a replacement shows immediately.
 */
export const companyLogoUrl = (version?: string | number | null): string =>
  `${(import.meta.env.VITE_API_URL ?? 'http://localhost:8000') as string}/api/company-settings/logo`
  + (version ? `?v=${encodeURIComponent(String(version))}` : '');

/** Upload a new brand logo (admin only). Returns the updated settings. */
export const uploadCompanyLogo = (fileName: string, base64: string): Promise<CompanySettings> =>
  api.post<CompanySettings>('/api/company-settings/logo', { file_name: fileName, content: base64 }).then((r) => r.data);

/** Remove the brand logo (admin only); every surface reverts to the text wordmark. */
export const deleteCompanyLogo = (): Promise<CompanySettings> =>
  api.delete<CompanySettings>('/api/company-settings/logo').then((r) => r.data);

// ---- profile pictures (every user, whatever their role) ----

/** What the photo endpoints report back. */
export interface UserPhotoInfo { id: number; name: string; has_photo: boolean; photo_version: number | null }

/**
 * A user's profile picture. Absolute, because it is rendered by plain <img> tags. Unlike
 * the brand logo this route requires a session, so the tag must be marked
 * crossOrigin="use-credentials" for the cookie to travel in development, where the SPA and
 * the API sit on different ports.
 */
export const userPhotoUrl = (userId: number, version?: string | number | null): string =>
  `${(import.meta.env.VITE_API_URL ?? 'http://localhost:8000') as string}/api/users/${userId}/photo`
  + (version ? `?v=${encodeURIComponent(String(version))}` : '');

export const getMyPhoto = (): Promise<UserPhotoInfo> =>
  api.get<UserPhotoInfo>('/api/account/photo').then((r) => r.data);

export const uploadMyPhoto = (fileName: string, base64: string): Promise<UserPhotoInfo> =>
  api.post<UserPhotoInfo>('/api/account/photo', { file_name: fileName, content: base64 }).then((r) => r.data);

export const deleteMyPhoto = (): Promise<UserPhotoInfo> =>
  api.delete<UserPhotoInfo>('/api/account/photo').then((r) => r.data);

/** Set a picture for any user — administrators, or the user themselves. */
export const uploadUserPhoto = (userId: number, fileName: string, base64: string): Promise<UserPhotoInfo> =>
  api.post<UserPhotoInfo>(`/api/users/${userId}/photo`, { file_name: fileName, content: base64 }).then((r) => r.data);

export const deleteUserPhoto = (userId: number): Promise<UserPhotoInfo> =>
  api.delete<UserPhotoInfo>(`/api/users/${userId}/photo`).then((r) => r.data);

export const getCustomers = (): Promise<unknown[]> => api.get<unknown[]>('/api/customers').then((r) => r.data);
export const createCustomer = (payload: unknown): Promise<unknown> => api.post('/api/customers', payload).then((r) => r.data);

// --- Recycle Bin (Super Admin) ---
export const getTrashedTransactions = (): Promise<TrashedResponse<TrashedTransaction>> => api.get('/api/trash/transactions').then((r) => r.data);
export const restoreTransaction = (id: Id): Promise<unknown> => api.post(`/api/trash/transactions/${id}/restore`).then((r) => r.data);
export const forceDeleteTransaction = (id: Id): Promise<unknown> => api.delete(`/api/trash/transactions/${id}`).then((r) => r.data);
export const getTrashedDocuments = (): Promise<TrashedResponse<TrashedDocument>> => api.get('/api/trash/documents').then((r) => r.data);
export const restoreTrashedDocument = (id: Id): Promise<unknown> => api.post(`/api/trash/documents/${id}/restore`).then((r) => r.data);
export const forceDeleteTrashedDocument = (id: Id): Promise<unknown> => api.delete(`/api/trash/documents/${id}`).then((r) => r.data);
export const getTrashedInvoices = (): Promise<TrashedResponse<TrashedInvoice>> => api.get('/api/trash/invoices').then((r) => r.data);
export const restoreTrashedInvoice = (id: Id): Promise<unknown> => api.post(`/api/trash/invoices/${id}/restore`).then((r) => r.data);
export const forceDeleteTrashedInvoice = (id: Id): Promise<unknown> => api.delete(`/api/trash/invoices/${id}`).then((r) => r.data);
export const getTrashedPayments = (): Promise<TrashedResponse<TrashedPayment>> => api.get('/api/trash/payments').then((r) => r.data);
export const restoreTrashedPayment = (id: Id): Promise<unknown> => api.post(`/api/trash/payments/${id}/restore`).then((r) => r.data);
export const forceDeleteTrashedPayment = (id: Id): Promise<unknown> => api.delete(`/api/trash/payments/${id}`).then((r) => r.data);
export const getTrashedRowItems = (): Promise<TrashedResponse<TrashedRowItem>> => api.get('/api/trash/row-items').then((r) => r.data);
export const restoreTrashedRowItem = (id: Id): Promise<unknown> => api.post(`/api/trash/row-items/${id}/restore`).then((r) => r.data);
export const forceDeleteTrashedRowItem = (id: Id): Promise<unknown> => api.delete(`/api/trash/row-items/${id}`).then((r) => r.data);
export const getDeletionLog = (): Promise<TrashedResponse<DeletionLogEntry>> => api.get('/api/trash/deletions').then((r) => r.data);

// --- Global Audit Trail (admin) ---
export const getAuditLogs = (params: Record<string, unknown> = {}): Promise<AuditLogPage> =>
  api.get<AuditLogPage>('/api/audit-logs', { params }).then((r) => r.data);

// --- Reference data ---
export const listAgents = (): Promise<string[]> => api.get<string[]>('/api/agents').then((r) => r.data);
export const getAgentCommissions = (): Promise<AgentCommissionMap> => api.get<AgentCommissionMap>('/api/agent-commissions').then((r) => r.data);
export const getAgentEmails = (): Promise<Record<string, string>> => api.get<Record<string, string>>('/api/agent-emails').then((r) => r.data);
export const getAgentLoans = (): Promise<AgentLoanMap> => api.get<AgentLoanMap>('/api/agent-loans').then((r) => r.data);
export const registrationOpen = (): Promise<boolean> => api.get<{ open: boolean }>('/api/registration-open').then((r) => r.data.open);

export const getTransactionTypes = (): Promise<unknown> =>
  api.get('/api/transaction-types').then((r) => r.data);

// Type-ahead suggestions from previously saved records.
export const getLawyerSuggestions = (): Promise<LawyerSuggestion[]> => api.get<LawyerSuggestion[]>('/api/suggestions/lawyers').then((r) => r.data);
export const getBrokerageSuggestions = (): Promise<BrokerageSuggestion[]> => api.get<BrokerageSuggestion[]>('/api/suggestions/brokerages').then((r) => r.data);

// --- Email settings (Super Admin): SMTP accounts + per-event templates ---
export const getMailAccounts = (): Promise<MailAccount[]> => api.get('/api/mail-accounts').then((r) => r.data.data ?? r.data);
export const createMailAccount = (payload: unknown): Promise<MailAccount> => api.post('/api/mail-accounts', payload).then((r) => r.data.data ?? r.data);
export const updateMailAccount = (id: Id, payload: unknown): Promise<MailAccount> => api.put(`/api/mail-accounts/${id}`, payload).then((r) => r.data.data ?? r.data);
export const deleteMailAccount = (id: Id): Promise<unknown> => api.delete(`/api/mail-accounts/${id}`).then((r) => r.data);
export const setDefaultMailAccount = (id: Id): Promise<MailAccount> => api.post(`/api/mail-accounts/${id}/default`).then((r) => r.data.data ?? r.data);
export const testMailAccount = (id: Id, to: string): Promise<TestMailResult> => api.post(`/api/mail-accounts/${id}/test`, { to }).then((r) => r.data);

export const getEmailTemplates = (): Promise<EmailTemplatesResponse> => api.get('/api/email-templates').then((r) => r.data);
export const updateEmailTemplate = (id: Id, payload: unknown): Promise<EmailTemplate> => api.put(`/api/email-templates/${id}`, payload).then((r) => r.data.data ?? r.data);

/**
 * Template attachments — files sent with every email from that template.
 *
 * Uploaded as base64 in JSON rather than multipart, matching how campaign template attachments
 * and document uploads already work here, so the 12 MB body limit set in main.ts applies.
 */
export const addEmailTemplateAttachment = (
  id: Id, filename: string, contentType: string, base64: string,
): Promise<EmailTemplateAttachment> =>
  api.post(`/api/email-templates/${id}/attachments`, { filename, content_type: contentType, data: base64 }).then((r) => r.data);

export const deleteEmailTemplateAttachment = (id: Id, attachmentId: number): Promise<{ deleted: boolean }> =>
  api.delete(`/api/email-templates/${id}/attachments/${attachmentId}`).then((r) => r.data);

/** Download URL — relative, so it resolves against whatever host serves the app. */
export const emailTemplateAttachmentUrl = (id: Id, attachmentId: number): string =>
  `${api.defaults.baseURL ?? ''}/api/email-templates/${id}/attachments/${attachmentId}`;
export const previewEmailTemplate = (id: Id): Promise<TemplatePreview> => api.post(`/api/email-templates/${id}/preview`).then((r) => r.data);
export const getMailEvents = (): Promise<unknown> => api.get('/api/mail-events').then((r) => r.data);
