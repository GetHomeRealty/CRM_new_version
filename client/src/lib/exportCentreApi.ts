import api from './axios';
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
  const dispo = String(res.headers['content-disposition'] ?? '');
  const m = /filename="?([^";]+)"?/i.exec(dispo);
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
