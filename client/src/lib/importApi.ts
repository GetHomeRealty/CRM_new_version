import api from './axios';
import type { ImportPreview, ImportResult, ImportBatch } from '../types';

/** Bulk transaction import API. Files are sent base64-encoded in JSON. */

/** Trigger a browser download for a blob response. */
async function download(url: string, fallbackName: string): Promise<void> {
  const res = await api.get(url, { responseType: 'blob' });
  const dispo = String(res.headers['content-disposition'] ?? '');
  const m = /filename="?([^";]+)"?/i.exec(dispo);
  const objectUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export const downloadImportTemplate = (): Promise<void> =>
  download('/api/transaction-imports/template', 'transaction-import-template.xlsx');

export const downloadImportErrors = (batchId: string): Promise<void> =>
  download(`/api/transaction-imports/${batchId}/errors`, `import-errors-${batchId}.xlsx`);

/** Read a File into the base64 payload the API expects. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Validate an uploaded file. Creates nothing — returns what WOULD be imported. */
export const validateImport = (fileName: string, content: string): Promise<ImportPreview> =>
  api.post<ImportPreview>('/api/transaction-imports/validate', { file_name: fileName, content }).then((r) => r.data);

/** Create the rows that passed validation. */
export const confirmImport = (batchId: string): Promise<ImportResult> =>
  api.post<ImportResult>(`/api/transaction-imports/${batchId}/confirm`).then((r) => r.data);

export const importHistory = (): Promise<ImportBatch[]> =>
  api.get<ImportBatch[]>('/api/transaction-imports').then((r) => r.data);
