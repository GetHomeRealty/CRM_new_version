import { environment } from '@/config/environment';

export interface DeletedLeadsPage {
  data: { id: number; name: string; email: string | null; deleted_at: string | null }[];
  meta: { page: number; per_page: number; total: number; last_page: number };
}

export async function restoreDeletedLead(token: string, id: number, signal?: AbortSignal): Promise<void> {
  if (!token) throw new Error('Please sign in again.');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid lead.');
  if (signal?.aborted) throw new Error('Restore was cancelled before sending.');
  const uncertain = 'Restore could not be confirmed. Check the active lead list before trying again.';
  const response = await fetch(`${environment.apiUrl}/api/leads/deleted/${id}/restore`, {
    method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).catch(() => { throw new Error(uncertain); });
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again before restoring leads.'
    : response.status === 403 ? 'You do not have permission to restore this lead.'
    : response.status === 404 ? 'This deleted lead is no longer available. Check the active lead list.'
    : 'Restore could not be confirmed. Check the active lead list before trying again.');
  const body = await response.json().catch(() => { throw new Error(uncertain); });
  if (body?.restored !== true) throw new Error('Restore could not be confirmed. Check the active lead list.');
}

export async function fetchDeletedLeads(token: string, page: number, search: string, signal?: AbortSignal): Promise<DeletedLeadsPage> {
  if (!token) throw new Error('Please sign in again.');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid page.');
  const query = new URLSearchParams({ page: String(page), limit: '50', search: search.trim() });
  const response = await fetch(`${environment.apiUrl}/api/leads/deleted?${query}`, {
    method: 'GET', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'You do not have access to deleted leads.' : 'Could not load deleted leads. Please retry.');
  const value = await response.json() as DeletedLeadsPage;
  const meta = value?.meta;
  if (!meta || meta.page !== page || meta.per_page !== 50 || !Number.isSafeInteger(meta.total) || meta.total < 0
    || meta.last_page !== Math.max(1, Math.ceil(meta.total / 50)) || !Array.isArray(value.data) || value.data.length > 50
    || !value.data.every(row => row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.name === 'string'
      && (row.email === null || typeof row.email === 'string')
      && (row.deleted_at === null || (typeof row.deleted_at === 'string' && Number.isFinite(Date.parse(row.deleted_at)))))) {
    throw new Error('Deleted lead data is invalid. Please retry.');
  }
  return value;
}
