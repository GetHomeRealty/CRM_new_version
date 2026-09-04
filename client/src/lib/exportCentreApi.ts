import api from './axios';
import { filenameFromDisposition, saveBlob } from './download';
import type { BulkSelection, ExportJob } from '../types';

/** Export & Download Centre — queue background exports and fetch their status. */

export type ExportAction =
  | 'transaction-complete-xlsx' | 'transaction-complete-csv'
  | 'transaction-data-xlsx' | 'transaction-data-csv' | 'transaction-data-pdf'
  | 'transaction-pdf-zip' | 'documents-zip';

/** Queue an export. Returns immediately; the file is generated in the background. */
export const queueExport = (action: ExportAction, sel: BulkSelection): Promise<ExportJob> =>
  api.post<ExportJob>(`/api/export-centre/queue/${action}`, sel).then((r) => r.data);

export const exportHistory = (): Promise<ExportJob[]> =>
  api.get<ExportJob[]>('/api/export-centre').then((r) => r.data);

export const exportJob = (exportId: string): Promise<ExportJob> =>
  api.get<ExportJob>(`/api/export-centre/job/${exportId}`).then((r) => r.data);

export const deleteExport = (exportId: string): Promise<void> =>
  api.delete(`/api/export-centre/${exportId}`).then(() => undefined);

export const sweepExports = (): Promise<{ swept: number }> =>
  api.post<{ swept: number }>('/api/export-centre/sweep').then((r) => r.data);

/** Download a completed export through its expiring token. */
export async function downloadExport(token: string, fallbackName = 'export'): Promise<void> {
  const res = await api.get(`/api/export-centre/download/${token}`, { responseType: 'blob' });
  // TD-046 — one reader for the server's filename, shared with every other download path.
  saveBlob(res.data as Blob, filenameFromDisposition(res.headers, fallbackName), 120_000);
}
