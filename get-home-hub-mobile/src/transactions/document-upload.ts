import { environment } from '@/config/environment';
import type { MobileDocument } from './transactions-api';
export const documentUploadLimit = 20 * 1024 * 1024;
export type SelectedDocumentFile = { uri: string; name: string; size: number; mimeType?: string };
export class UnconfirmedDocumentUploadError extends Error {}
export function documentUploadPath(transactionId: number, document: MobileDocument, clientName?: string): string {
  if (![transactionId, document.id].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid document or transaction.');
  if (document.agent_accepted === 'Not Accepted') throw new Error('Uploads are disabled for this document.');
  if (document.validation === 'Valid') throw new Error('This document is marked Valid.');
  if (!['single', 'condition', 'multi', 'per_client'].includes(document.kind ?? '')) throw new Error('Refresh the document list before uploading.');
  if (document.kind === 'per_client' && (!clientName?.trim() || clientName.length > 255)) throw new Error('Choose the client for this file.');
  return `/api/transactions/${transactionId}/documents/${document.id}/${document.kind === 'multi' || document.kind === 'per_client' ? 'files' : 'file'}`;
}
export function validateDocumentFile(file: SelectedDocumentFile): void {
  if (!file.uri.startsWith('file://') || !file.name.trim() || file.name.length > 255 || /[\/\\\x00-\x1f]/.test(file.name)) throw new Error('Choose a local file with a valid filename.');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > documentUploadLimit) throw new Error('Choose a non-empty file of no more than 20 MB.');
}
/** A single attempt: review uncertain persistence before another upload. */
export async function uploadTransactionDocument(token: string, transactionId: number, document: MobileDocument, file: SelectedDocumentFile, clientName?: string, signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted) throw new Error('Please sign in again before uploading.');
  const path = documentUploadPath(transactionId, document, clientName);
  validateDocumentFile(file);
  const body = new FormData();
  body.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as unknown as Blob);
  if (document.kind === 'per_client') body.append('client_name', clientName!);
  let response: Response;
  try {
    response = await fetch(`${environment.apiUrl}${path}`, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body });
  } catch { throw new UnconfirmedDocumentUploadError('Upload could not be confirmed. Close this screen and refresh the documents before uploading again.'); }
  if (response.ok) return;
  if ([400, 401, 403, 404, 413, 422].includes(response.status)) throw new Error(response.status === 401 ? 'Please sign in again.' : response.status === 413 ? 'The file exceeds the 20 MB limit.' : 'Upload rejected. Refresh the documents and check your access and file.');
  throw new UnconfirmedDocumentUploadError('Upload could not be confirmed. Close this screen and refresh the documents before uploading again.');
}
