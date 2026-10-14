import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
import type { MobileDocument } from './transactions-api';
export type ChecklistAction = { type: 'create'; title: string } | { type: 'readiness'; ready: string | null; remarks: string | null; version: string } | { type: 'remove'; document: MobileDocument; kind: 'primary' | 'indexed'; index?: number; label: string };
export class UnconfirmedChecklistActionError extends Error {}
export function canChecklistTools(user: MobileUser | null): boolean { return canAreaScreen(user, 'desk', 'transactions') && ['admin', 'manager', 'accounting', 'documentation', 'crm', 'agent'].includes(user?.role ?? ''); }
export function canChecklistAction(user: MobileUser | null, action: ChecklistAction): boolean {
  return canChecklistTools(user) && canAreaScreen(user, 'desk', 'transactions', 'edit') && (action.type === 'create' || (user?.role !== 'agent' && (action.type !== 'remove' || action.document.validation !== 'Valid' || user?.role === 'admin')));
}
export function checklistRequest(user: MobileUser | null, transactionId: number, action: ChecklistAction): { path: string; method: string; body: object } {
  if (!canChecklistAction(user, action) || !Number.isSafeInteger(transactionId) || transactionId <= 0) throw new Error('You do not have permission for this checklist action.');
  const base = `/api/transactions/${transactionId}/documents`;
  if (action.type === 'create') { if (!action.title.trim() || action.title.trim().length > 255) throw new Error('Enter a document title of 1–255 characters.'); return { path: `${base}/manual`, method: 'POST', body: { title: action.title.trim() } }; }
  if (action.type === 'readiness') { if (![null, 'Yes', 'No'].includes(action.ready) || !/^[a-f0-9]{64}$/.test(action.version) || (action.remarks !== null && (typeof action.remarks !== 'string' || action.remarks.length > 5000))) throw new Error('Refresh and check the RECO readiness entries.'); return { path: `${base}/reco-readiness`, method: 'PUT', body: { ready: action.ready, remarks: action.ready === 'No' ? action.remarks : null, version: action.version } }; }
  const doc = action.document;
  if (!Number.isSafeInteger(doc.id) || doc.id <= 0 || !/^[a-f0-9]{64}$/.test(doc.review_version ?? '') || (action.kind === 'primary' ? !doc.has_file : !Number.isSafeInteger(action.index) || !doc.files?.some(file => file.index === action.index))) throw new Error('Refresh the document before selecting a file.');
  return { path: `${base}/${doc.id}/attachment`, method: 'DELETE', body: { kind: action.kind, ...(action.kind === 'indexed' ? { index: action.index } : {}), review_version: doc.review_version } };
}
export async function saveChecklistAction(token: string, user: MobileUser | null, transactionId: number, action: ChecklistAction, signal?: AbortSignal): Promise<void> {
  if (!token || signal?.aborted) throw new Error('Please sign in again.');
  const request = checklistRequest(user, transactionId, action); let response: Response;
  try { response = await fetch(`${environment.apiUrl}${request.path}`, { method: request.method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }); }
  catch { throw new UnconfirmedChecklistActionError('The change could not be confirmed. Close and refresh before another attempt.'); }
  if (response.ok) return;
  if (response.status === 409) throw new UnconfirmedChecklistActionError('The checklist changed. Close and refresh before another action.');
  if ([400, 401, 403, 404, 422].includes(response.status)) throw new Error('Checklist change rejected. Refresh the checklist and check your access and entries.');
  throw new UnconfirmedChecklistActionError('The change could not be confirmed. Close and refresh before another attempt.');
}
