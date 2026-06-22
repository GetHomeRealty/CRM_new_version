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

// --- Reference data ---
export const listAgents = () => api.get('/api/agents').then((r) => r.data);

export const getTransactionTypes = () =>
  api.get('/api/transaction-types').then((r) => r.data);
