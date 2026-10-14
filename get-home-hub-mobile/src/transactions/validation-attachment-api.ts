import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileDocument } from './transactions-api';
import { validateDocumentFile, type SelectedDocumentFile } from './document-upload';
export class UnconfirmedValidationAttachmentError extends Error {}
export function canEditValidationAttachment(user: MobileUser | null, document: MobileDocument): boolean {
  return document.validation === 'Invalid' && canAreaScreen(user, 'desk', 'transactions', 'edit') && ['admin', 'manager', 'accounting', 'documentation', 'crm'].includes(user?.role ?? '');
}
export async function changeValidationAttachment(token: string, user: MobileUser | null, transactionId: number, document: MobileDocument, file: SelectedDocumentFile | null, signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted || !canEditValidationAttachment(user, document)) throw new Error('You do not have permission to change this attachment.');
  if (![transactionId, document.id].every(id => Number.isSafeInteger(id) && id > 0) || !/^[a-f0-9]{64}$/.test(document.review_version ?? '')) throw new Error('Refresh the document before changing its attachment.');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let body: FormData | string;
  if (file) { validateDocumentFile(file); body = new FormData(); body.append('review_version', document.review_version!); body.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as unknown as Blob); }
  else { if (!document.has_validation_file) throw new Error('No validation attachment to remove.'); headers['Content-Type'] = 'application/json'; body = JSON.stringify({ review_version: document.review_version }); }
  let response: Response;
  try { response = await fetch(`${environment.apiUrl}/api/transactions/${transactionId}/documents/${document.id}/validation-attachment`, { method: file ? 'POST' : 'DELETE', headers, body, signal }); }
  catch { throw new UnconfirmedValidationAttachmentError('The change could not be confirmed. Close and refresh the documents before another attempt.'); }
  if (response.ok) return;
  if (response.status === 409) throw new UnconfirmedValidationAttachmentError('This document changed. Close and refresh before changing its attachment.');
  if ([400, 401, 403, 404, 413, 422].includes(response.status)) throw new Error('Attachment change rejected. Refresh the documents and check your access and file.');
  throw new UnconfirmedValidationAttachmentError('The change could not be confirmed. Close and refresh the documents before another attempt.');
}
