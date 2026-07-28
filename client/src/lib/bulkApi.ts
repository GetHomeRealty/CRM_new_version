import api from './axios';
import type { BulkSelection, BulkSummary } from '../types';

/** Bulk transaction data export and document ZIP download. */

export const bulkSummary = (sel: BulkSelection): Promise<BulkSummary> =>
  api.post<BulkSummary>('/api/transactions/bulk/summary', sel).then((r) => r.data);

/** POST a selection and download whatever the server streams back. */
async function downloadPost(url: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await api.post(url, body, { responseType: 'blob' });
  const dispo = String(res.headers['content-disposition'] ?? '');
  const m = /filename="?([^";]+)"?/i.exec(dispo);
  const objectUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
}

export const exportTransactionsXlsx = (sel: BulkSelection): Promise<void> =>
  downloadPost('/api/transactions/bulk/export/xlsx', sel, 'Transaction_Data.xlsx');

/** The same data as one flat CSV table — one row per transaction. */
export const exportTransactionsCsv = (sel: BulkSelection): Promise<void> =>
  downloadPost('/api/transactions/bulk/export/csv', sel, 'Transaction_Data.csv');

/**
 * The complete export: one row per transaction carrying every detail — Basic Info, team
 * split, clients, lawyer, co-op brokerage, financial, adjustments and conditions.
 */
export const exportCompleteXlsx = (sel: BulkSelection): Promise<void> =>
  downloadPost('/api/transactions/bulk/export/complete/xlsx', sel, 'All_Transactions.xlsx');

export const exportCompleteCsv = (sel: BulkSelection): Promise<void> =>
  downloadPost('/api/transactions/bulk/export/complete/csv', sel, 'All_Transactions.csv');

/** Everything the user is entitled to see, with no filters applied. */
export const ALL_TRANSACTIONS: BulkSelection = { transaction_ids: [], all_matching: true, filters: {} };

/** `mode: 'zip'` yields one PDF per transaction in a ZIP; otherwise one consolidated PDF. */
export const exportTransactionsPdf = (sel: BulkSelection, mode?: 'zip'): Promise<void> =>
  downloadPost('/api/transactions/bulk/export/pdf', { ...sel, mode }, mode === 'zip' ? 'Transaction_PDFs.zip' : 'Transaction_Data.pdf');

export const downloadDocumentsZip = (sel: BulkSelection): Promise<void> =>
  downloadPost('/api/transactions/bulk/documents/zip', sel, 'Bulk_Transaction_Documents.zip');
