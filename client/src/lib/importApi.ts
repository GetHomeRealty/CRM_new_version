import api from './axios';
import { filenameFromDisposition, saveBlob } from './download';
import type { ImportPreview, ImportResult, ImportBatch } from '../types';

/** Bulk transaction import API. Files are sent base64-encoded in JSON. */

/** Trigger a browser download for a blob response. */
async function download(url: string, fallbackName: string): Promise<void> {
  const res = await api.get(url, { responseType: 'blob' });
  // TD-046 — one reader for the server's filename, shared with every other download path.
  saveBlob(res.data as Blob, filenameFromDisposition(res.headers, fallbackName), 60_000);
}

export const downloadImportTemplate = (): Promise<void> =>
  download('/api/transaction-imports/template', 'transaction-import-template.xlsx');

/** A filled example — the same sheets as the template, with four worked transactions. */
export const downloadImportSample = (): Promise<void> =>
  download('/api/transaction-imports/sample', 'transaction-import-sample.xlsx');

export const downloadImportErrors = (batchId: string): Promise<void> =>
  download(`/api/transaction-imports/${batchId}/errors`, `import-errors-${batchId}.xlsx`);

/**
 * 2026-10-07 - the user's own uploaded file back, with an App Trade Number column holding the
 * number the app gave each row.
 */
export const downloadNumberedImport = (batchId: string): Promise<void> =>
  download(`/api/transaction-imports/${batchId}/numbered-file`, `import-${batchId}-with-app-trade-numbers.xlsx`);

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

/** TD-212 - progress of an import that is running on the server, and its result once finished. */
export interface ImportStatus {
  batch_id: string; status: string; done: boolean;
  total_rows: number; valid_rows: number; imported_rows: number; failed_rows: number; duplicate_rows: number;
  result: ImportResult | null;
}
export const importStatus = (batchId: string): Promise<ImportStatus> =>
  api.get<ImportStatus>(`/api/transaction-imports/${batchId}/status`).then((r) => r.data);

/**
 * Create the rows that passed validation.
 *
 * TD-212 - the server STARTS the import and answers at once; this then follows it every two seconds
 * until it is finished, and resolves with the same result as before. A long import used to outlive
 * the browser's wait and be reported as failed while it was in fact succeeding.
 */
export const confirmImport = async (batchId: string, onProgress?: (s: ImportStatus) => void): Promise<ImportResult> => {
  // ?follow=1 asks for the background import; without it the server waits and answers with the
  // result, which is what a tab still holding the screen from before TD-212 expects.
  await api.post(`/api/transaction-imports/${batchId}/confirm?follow=1`);
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let st: ImportStatus;
    try { st = await importStatus(batchId); misses = 0; } catch (e) {
      // A dropped check is not a failed import - keep following it for a while before giving up.
      if (++misses >= 15) throw e;
      continue;
    }
    onProgress?.(st);
    if (st.done && st.result) return st.result;
  }
};

/**
 * TD-142 — put one import back. Its deals move to the Recycle Bin, where they can be restored, so
 * the undo is itself undoable.
 */
export const undoTransactionImport = (batchId: string): Promise<{ removed: number; message: string }> =>
  api.post<{ removed: number; message: string }>(`/api/transaction-imports/${batchId}/undo`).then((r) => r.data);

export const importHistory = (): Promise<ImportBatch[]> =>
  api.get<ImportBatch[]>('/api/transaction-imports').then((r) => r.data);
