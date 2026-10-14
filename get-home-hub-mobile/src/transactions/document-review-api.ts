import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileDocument } from './transactions-api';
export type DocumentReviewPatch = { status?: string; validation?: string; remarks?: string | null; reminder?: boolean; drive_uploaded?: string | null; agent_accepted?: string | null };
export function canReviewDocument(user: MobileUser | null, document: MobileDocument): boolean {
  return canAreaScreen(user, 'desk', 'transactions', 'edit') && (user?.role === 'agent' ? document.manual === true && !document.is_condition : ['admin', 'manager', 'accounting', 'documentation', 'crm'].includes(user?.role ?? ''));
}
export class RefreshDocumentReviewError extends Error {}
export function reviewBody(user: MobileUser | null, document: MobileDocument, patch: DocumentReviewPatch): Record<string, unknown> {
  if (!canReviewDocument(user, document)) throw new Error('You do not have permission to review this document.');
  if (!/^[a-f0-9]{64}$/.test(document.review_version ?? '')) throw new Error('Refresh the document list before reviewing.');
  const fields = user?.role === 'agent' ? ['agent_accepted'] : ['status', 'validation', 'remarks', 'drive_uploaded', 'reminder'];
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !fields.includes(key))) throw new Error('Invalid review changes.');
  const enums: Record<string, unknown[]> = { status: ['Pending', 'Received'], validation: ['Pending', 'Valid', 'Invalid'], drive_uploaded: ['Yes', 'No', null], agent_accepted: ['Accepted', 'Not Accepted', null], reminder: [true, false] };
  for (const [key, values] of Object.entries(enums)) if (Object.hasOwn(patch, key) && !values.includes(patch[key as keyof DocumentReviewPatch])) throw new Error(`Invalid ${key}.`);
  if (Object.hasOwn(patch, 'remarks') && patch.remarks !== null && (typeof patch.remarks !== 'string' || patch.remarks.length > 5000)) throw new Error('Remarks must be at most 5000 characters.');
  return { review_version: document.review_version, ...patch };
}
export async function saveDocumentReview(token: string, user: MobileUser | null, transactionId: number, document: MobileDocument, patch: DocumentReviewPatch, signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted) throw new Error('Please sign in again.');
  if (![transactionId, document.id].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid document.');
  const body = reviewBody(user, document, patch);
  let response: Response;
  try { response = await fetch(`${environment.apiUrl}/api/transactions/${transactionId}/documents/${document.id}/review`, { method: 'PUT', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new RefreshDocumentReviewError('Save could not be confirmed. Close and refresh the documents before reviewing again.'); }
  if (response.ok) return;
  if (response.status === 409) throw new RefreshDocumentReviewError('This document changed. Close and refresh before reviewing again.');
  if ([400, 401, 403, 404, 422].includes(response.status)) throw new Error('Review rejected. Refresh the documents and check your access and entries.');
  throw new RefreshDocumentReviewError('Save could not be confirmed. Close and refresh the documents before reviewing again.');
}
