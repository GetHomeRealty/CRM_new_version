import { environment } from '@/config/environment';

function selectedIds(ids: readonly number[]): number[] {
  if (!ids.length || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Select between 1 and 50 valid leads.');
  return [...new Set(ids)];
}
async function request(token: string, action: 'export' | 'bulk-delete', ids: readonly number[], signal?: AbortSignal): Promise<unknown> {
  if (!token || signal?.aborted) throw new Error('Sign in and review your selection.');
  const lead_ids = selectedIds(ids);
  const message = action === 'export' ? 'Export could not be loaded. Please retry.' : 'Deletion could not be confirmed. Refresh active and deleted leads before trying again.';
  const response = await fetch(`${environment.apiUrl}/api/leads/${action}`, {
    method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids }),
  }).catch(() => { throw new Error(message); });
  if (!response.ok) throw new Error(response.status === 403 ? 'You do not have permission for this lead action.' : message);
  return response.json().catch(() => { throw new Error(message); });
}
export async function moveLeadsToDeleted(token: string, ids: readonly number[], signal?: AbortSignal): Promise<number> {
  const body = await request(token, 'bulk-delete', ids, signal) as { deleted: number };
  if (!body || !Number.isSafeInteger(body.deleted) || body.deleted < 0 || body.deleted > new Set(ids).size) throw new Error('Deletion result is invalid. Refresh your leads before trying again.');
  return body.deleted;
}
export interface LeadExportData { data: Record<string, string>[]; meta: { total: number; returned: number; truncated: boolean } }
export async function exportSelectedLeads(token: string, ids: readonly number[], signal?: AbortSignal): Promise<LeadExportData> {
  const body = await request(token, 'export', ids, signal) as LeadExportData;
  if (!body?.meta || !Array.isArray(body.data) || body.data.length > new Set(ids).size || body.meta.returned !== body.data.length
    || !Number.isSafeInteger(body.meta.total) || body.meta.total < body.data.length || body.meta.total > new Set(ids).size
    || typeof body.meta.truncated !== 'boolean' || !body.data.every(row => row && typeof row === 'object' && !Array.isArray(row) && Object.values(row).every(value => typeof value === 'string'))) {
    throw new Error('Export data is invalid. Please retry.');
  }
  return body;
}
/** Quoting alone does not prevent spreadsheet formula evaluation. */
export function leadExportCsv(rows: readonly Record<string, string>[]): string {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  return [headers.map(cell).join(','), ...rows.map(row => headers.map(key => cell(row[key] ?? '')).join(','))].join('\r\n');
}
