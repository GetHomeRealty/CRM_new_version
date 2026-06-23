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

// --- Documents (Legal & Documentation) ---
export const getDocuments = (txnId) =>
  api.get(`/api/transactions/${txnId}/documents`).then((r) => r.data);

export const saveDocuments = (txnId, documents) =>
  api.put(`/api/transactions/${txnId}/documents`, { documents }).then((r) => r.data);

export const uploadDocumentFile = (txnId, docId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return api
    .post(`/api/transactions/${txnId}/documents/${docId}/file`, fd, { headers: { 'Content-Type': undefined } })
    .then((r) => r.data);
};

export const deleteDocument = (docId) => api.delete(`/api/documents/${docId}`).then((r) => r.data);

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
export const documentFileUrl = (docId) => `${apiBase}/api/documents/${docId}/file`;

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

export const getCompanySettings = () => api.get('/api/company-settings').then((r) => r.data);
export const updateCompanySettings = (payload) => api.put('/api/company-settings', payload).then((r) => r.data);

export const getCustomers = () => api.get('/api/customers').then((r) => r.data);
export const createCustomer = (payload) => api.post('/api/customers', payload).then((r) => r.data);

// --- Reference data ---
export const listAgents = () => api.get('/api/agents').then((r) => r.data);
export const registrationOpen = () => api.get('/api/registration-open').then((r) => r.data.open);

export const getTransactionTypes = () =>
  api.get('/api/transaction-types').then((r) => r.data);
