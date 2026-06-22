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

// --- Reference data ---
export const listAgents = () => api.get('/api/agents').then((r) => r.data);

export const getTransactionTypes = () =>
  api.get('/api/transaction-types').then((r) => r.data);
