import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
export interface LifecycleDocument { id: number; title: string; validation: string; is_condition: boolean; state: 'active' | 'pending' | 'removed'; deleted_by: string | null; has_file: boolean; review_version: string }
export interface LifecycleDocuments { documents: LifecycleDocument[]; has_more: boolean }
export class UnconfirmedDocumentLifecycleError extends Error {}
export function canManageDocuments(user: MobileUser | null): boolean { return canAreaScreen(user, 'desk', 'transactions') && ['admin', 'manager', 'accounting', 'documentation', 'crm'].includes(user?.role ?? ''); }
export function canDocumentAction(user: MobileUser | null, doc: LifecycleDocument, action: 'remove' | 'restore'): boolean {
  if (!canManageDocuments(user) || !canAreaScreen(user, 'desk', 'transactions', 'edit')) return false;
  if (doc.state === 'pending' && !['admin', 'manager'].includes(user!.role)) return false;
  return action === 'remove' ? doc.state !== 'removed' && (!(doc.is_condition || doc.validation === 'Valid') || user!.role === 'admin') : doc.state === 'removed' ? user!.role === 'admin' : doc.state === 'pending';
}
export async function fetchDocumentLifecycle(token: string, transactionId: number, signal?: AbortSignal): Promise<LifecycleDocuments> {
  if (!token || !Number.isSafeInteger(transactionId) || transactionId <= 0) throw new Error('Invalid transaction.');
  const response = await fetch(`${environment.apiUrl}/api/transactions/${transactionId}/documents/lifecycle`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not load document removal status.');
  return response.json() as Promise<LifecycleDocuments>;
}
export async function changeDocumentLifecycle(token: string, user: MobileUser | null, transactionId: number, document: LifecycleDocument, action: 'remove' | 'restore', signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted || !canDocumentAction(user, document, action)) throw new Error('You do not have permission for this document action.');
  if (![transactionId, document.id].every(id => Number.isSafeInteger(id) && id > 0) || !/^[a-f0-9]{64}$/.test(document.review_version)) throw new Error('Refresh the document list before another action.');
  let response: Response;
  try { response = await fetch(`${environment.apiUrl}/api/transactions/${transactionId}/documents/${document.id}/lifecycle`, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ action, review_version: document.review_version }) }); }
  catch { throw new UnconfirmedDocumentLifecycleError('The action could not be confirmed. Close and refresh the list before another attempt.'); }
  if (response.ok) return;
  if (response.status === 409) throw new UnconfirmedDocumentLifecycleError('This document changed. Close and refresh before another action.');
  if ([400, 401, 403, 404, 422].includes(response.status)) throw new Error('Document action rejected. Refresh the list and check your access.');
  throw new UnconfirmedDocumentLifecycleError('The action could not be confirmed. Close and refresh the list before another attempt.');
}
