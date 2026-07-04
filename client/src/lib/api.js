import api from './axios';

// --- Transactions ---
export const listTransactions = () =>
  api.get('/api/transactions').then((r) => r.data.data);

export const getTransaction = (id) =>
  api.get(`/api/transactions/${id}`).then((r) => r.data.data);

export const createTransaction = (payload) =>
  api.post('/api/transactions', payload).then((r) => r.data.data);

export const updateTransaction = (id, payload) =>
  api.put(`/api/transactions/${id}`, payload).then((r) => r.data.data);

export const deleteTransaction = (id) =>
  api.delete(`/api/transactions/${id}`).then((r) => r.data);

// --- Transaction deletion approval workflow ---
export const requestTransactionDeletion = (id, reason) =>
  api.post(`/api/transactions/${id}/delete-requests`, { reason }).then((r) => r.data);
export const forwardDeleteRequest = (reqId, reason) =>
  api.post(`/api/delete-requests/${reqId}/forward`, { reason }).then((r) => r.data);
export const approveDeleteRequest = (reqId) =>
  api.post(`/api/delete-requests/${reqId}/approve`).then((r) => r.data);
export const rejectDeleteRequest = (reqId) =>
  api.post(`/api/delete-requests/${reqId}/reject`).then((r) => r.data);

export const getTransactionMessages = (id) =>
  api.get(`/api/transactions/${id}/messages`).then((r) => r.data);

// --- §5.1 edit-approval workflow (DFT / Closed) ---
export const requestTransactionEdit = (id, reason) =>
  api.post(`/api/transactions/${id}/edit-requests`, { reason }).then((r) => r.data);
export const approveEditRequest = (reqId) =>
  api.post(`/api/edit-requests/${reqId}/approve`).then((r) => r.data);
export const rejectEditRequest = (reqId) =>
  api.post(`/api/edit-requests/${reqId}/reject`).then((r) => r.data);
export const reviewAgentChanges = (id) =>
  api.post(`/api/transactions/${id}/review-agent-changes`).then((r) => r.data.data);
export const rejectAgentChange = (id, auditId) =>
  api.post(`/api/transactions/${id}/reject-agent-change`, { audit_id: auditId }).then((r) => r.data.data);
export const getAgentChangeNotifications = () =>
  api.get('/api/agent-change-notifications').then((r) => r.data);
export const postTransactionMessage = (id, body) =>
  api.post(`/api/transactions/${id}/messages`, { body }).then((r) => r.data);

// --- Documents (Legal & Documentation) ---
export const getDocuments = (txnId) =>
  api.get(`/api/transactions/${txnId}/documents`).then((r) => r.data);

export const saveDocuments = (txnId, documents, extra = {}) =>
  api.put(`/api/transactions/${txnId}/documents`, { documents, ...extra }).then((r) => r.data);

export const uploadDocumentFile = (txnId, docId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return api
    .post(`/api/transactions/${txnId}/documents/${docId}/file`, fd, { headers: { 'Content-Type': undefined } })
    .then((r) => r.data);
};

export const deleteDocument = (docId) => api.delete(`/api/documents/${docId}`).then((r) => r.data);
export const restoreDocument = (docId) => api.post(`/api/documents/${docId}/restore`).then((r) => r.data);

// --- Notice of Sale ---
export const getNoticeOfSale = (txnId) => api.get(`/api/transactions/${txnId}/notice-of-sale`).then((r) => r.data);
export const saveNoticeOfSale = (txnId, payload) => api.put(`/api/transactions/${txnId}/notice-of-sale`, payload).then((r) => r.data);
export const sendNoticeOfSale = (txnId, agents) => api.post(`/api/transactions/${txnId}/notice-of-sale/send`, { agents }).then((r) => r.data);

// --- Deposit Receipt ---
export const sendDepositReceipt = (txnId, email, cc) => api.post(`/api/transactions/${txnId}/deposit-receipt/send`, { email, cc }).then((r) => r.data);
export const sendTradeSheet = (txnId, email) => api.post(`/api/transactions/${txnId}/trade-sheet/send`, { email }).then((r) => r.data);

// §13 multi-file / per-client uploads (clientName optional)
export const uploadDocClientFile = (txnId, docId, file, clientName) => {
  const fd = new FormData();
  fd.append('file', file);
  if (clientName) fd.append('client_name', clientName);
  return api.post(`/api/transactions/${txnId}/documents/${docId}/files`, fd, { headers: { 'Content-Type': undefined } }).then((r) => r.data);
};
export const deleteDocClientFile = (txnId, docId, index) =>
  api.delete(`/api/transactions/${txnId}/documents/${docId}/files/${index}`).then((r) => r.data);

// §13 Invalid-validation supporting attachment
export const uploadDocValidationFile = (txnId, docId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return api.post(`/api/transactions/${txnId}/documents/${docId}/validation-file`, fd, { headers: { 'Content-Type': undefined } }).then((r) => r.data);
};
export const deleteDocValidationFile = (txnId, docId) =>
  api.delete(`/api/transactions/${txnId}/documents/${docId}/validation-file`).then((r) => r.data);

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
export const documentFileUrl = (docId) => `${apiBase}/api/documents/${docId}/file`;
export const docClientFileUrl = (docId, index) => `${apiBase}/api/documents/${docId}/files/${index}`;
export const docValidationFileUrl = (docId) => `${apiBase}/api/documents/${docId}/validation-file`;

// --- Users / RBAC (admin) ---
export const getUsers = () => api.get('/api/users').then((r) => r.data);
export const getUsersCatalog = () => api.get('/api/users/catalog').then((r) => r.data);
export const createUser = (payload) => api.post('/api/users', payload).then((r) => r.data);
export const updateUser = (id, payload) => api.put(`/api/users/${id}`, payload).then((r) => r.data);
export const deleteUser = (id) => api.delete(`/api/users/${id}`).then((r) => r.data);

// --- Invoice module ---
export const getInvoices = () => api.get('/api/invoices').then((r) => r.data);
export const getInvoice = (id) => api.get(`/api/invoices/${id}`).then((r) => r.data);
export const createInvoice = (payload) => api.post('/api/invoices', payload).then((r) => r.data);
export const generateTransactionInvoices = (txnId) => api.post(`/api/transactions/${txnId}/invoices`).then((r) => r.data);
export const updateInvoice = (id, payload) => api.put(`/api/invoices/${id}`, payload).then((r) => r.data);
export const deleteInvoice = (id) => api.delete(`/api/invoices/${id}`).then((r) => r.data);
export const recordInvoicePayment = (id, payload) => api.post(`/api/invoices/${id}/payments`, payload).then((r) => r.data);
export const deleteInvoicePayment = (id, paymentId) => api.delete(`/api/invoices/${id}/payments/${paymentId}`).then((r) => r.data);
export const recordInvoiceReminder = (id) => api.post(`/api/invoices/${id}/reminders`).then((r) => r.data);
export const sendInvoice = (id) => api.post(`/api/invoices/${id}/send`).then((r) => r.data);

export const changePassword = (payload) => api.post('/api/user/password', payload).then((r) => r.data);

export const getCompanySettings = () => api.get('/api/company-settings').then((r) => r.data);
export const updateCompanySettings = (payload) => api.put('/api/company-settings', payload).then((r) => r.data);

export const getCustomers = () => api.get('/api/customers').then((r) => r.data);
export const createCustomer = (payload) => api.post('/api/customers', payload).then((r) => r.data);

// --- Global Audit Trail (admin) ---
export const getAuditLogs = (params = {}) =>
  api.get('/api/audit-logs', { params }).then((r) => r.data);

// --- Reference data ---
export const listAgents = () => api.get('/api/agents').then((r) => r.data);
export const getAgentCommissions = () => api.get('/api/agent-commissions').then((r) => r.data);
export const getAgentEmails = () => api.get('/api/agent-emails').then((r) => r.data);
export const registrationOpen = () => api.get('/api/registration-open').then((r) => r.data.open);

export const getTransactionTypes = () =>
  api.get('/api/transaction-types').then((r) => r.data);

// Type-ahead suggestions from previously saved records.
export const getLawyerSuggestions = () => api.get('/api/suggestions/lawyers').then((r) => r.data);
export const getBrokerageSuggestions = () => api.get('/api/suggestions/brokerages').then((r) => r.data);

// --- Email settings (Super Admin): SMTP accounts + per-event templates ---
export const getMailAccounts = () => api.get('/api/mail-accounts').then((r) => r.data.data ?? r.data);
export const createMailAccount = (payload) => api.post('/api/mail-accounts', payload).then((r) => r.data.data ?? r.data);
export const updateMailAccount = (id, payload) => api.put(`/api/mail-accounts/${id}`, payload).then((r) => r.data.data ?? r.data);
export const deleteMailAccount = (id) => api.delete(`/api/mail-accounts/${id}`).then((r) => r.data);
export const setDefaultMailAccount = (id) => api.post(`/api/mail-accounts/${id}/default`).then((r) => r.data.data ?? r.data);
export const testMailAccount = (id, to) => api.post(`/api/mail-accounts/${id}/test`, { to }).then((r) => r.data);

export const getEmailTemplates = () => api.get('/api/email-templates').then((r) => r.data);
export const updateEmailTemplate = (id, payload) => api.put(`/api/email-templates/${id}`, payload).then((r) => r.data.data ?? r.data);
export const previewEmailTemplate = (id) => api.post(`/api/email-templates/${id}/preview`).then((r) => r.data);
export const getMailEvents = () => api.get('/api/mail-events').then((r) => r.data);
