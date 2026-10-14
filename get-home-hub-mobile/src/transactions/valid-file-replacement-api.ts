import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileDocument } from './transactions-api';
import { validateDocumentFile, type SelectedDocumentFile } from './document-upload';
export interface ValidFileTarget { kind: 'primary' | 'indexed'; index?: number; label: string }
export class UnconfirmedValidReplacementError extends Error {}
export function canReplaceValidFile(user: MobileUser | null, document: MobileDocument): boolean { return user?.role === 'admin' && document.validation === 'Valid' && document.agent_accepted !== 'Not Accepted' && canAreaScreen(user, 'desk', 'transactions', 'edit'); }
export function validateReplacementTarget(document: MobileDocument, target: ValidFileTarget): void {
  if (!Number.isSafeInteger(document.id) || document.id <= 0 || !/^[a-f0-9]{64}$/.test(document.review_version ?? '') || (target.kind === 'primary' ? !document.has_file : !Number.isSafeInteger(target.index) || !document.files?.some(file => file.index === target.index))) throw new Error('Refresh and select the existing file to replace.');
}
export async function replaceValidFile(token: string, user: MobileUser | null, txnId: number, document: MobileDocument, target: ValidFileTarget, file: SelectedDocumentFile, signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted || !canReplaceValidFile(user, document) || !Number.isSafeInteger(txnId) || txnId <= 0) throw new Error('You do not have permission for this replacement.');
  validateReplacementTarget(document, target); validateDocumentFile(file);
  const body = new FormData(); body.append('kind', target.kind); if (target.kind === 'indexed') body.append('index', String(target.index)); body.append('review_version', document.review_version!); body.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as unknown as Blob);
  let response: Response;
  try { response = await fetch(`${environment.apiUrl}/api/transactions/${txnId}/documents/${document.id}/valid-file-replacement`, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body }); }
  catch { throw new UnconfirmedValidReplacementError('Replacement could not be confirmed. Close and refresh before another attempt.'); }
  if (response.ok) return;
  if (response.status === 409) throw new UnconfirmedValidReplacementError('The document changed. Close and refresh before replacing its file.');
  if ([400, 401, 403, 404, 413, 422].includes(response.status)) throw new Error('Replacement rejected. Refresh and check your access and file.');
  throw new UnconfirmedValidReplacementError('Replacement could not be confirmed. Close and refresh before another attempt.');
}
