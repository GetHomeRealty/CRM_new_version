import { environment } from '@/config/environment';

export interface SuppressionPage {
  data: { id: number; email: string; reason: string | null; updated_at: string | null }[];
  meta: { page: number; per_page: number; total: number; last_page: number };
}
export async function fetchSuppressions(token: string, page: number, signal?: AbortSignal): Promise<SuppressionPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid suppression page.');
  const value = await read(token, `/suppressions?page=${page}&limit=50`, signal) as SuppressionPage;
  const meta = value?.meta;
  if (!meta || meta.page !== page || meta.per_page !== 50
    || !Number.isSafeInteger(meta.total) || meta.total < 0
    || !Number.isSafeInteger(meta.last_page) || meta.last_page !== Math.max(1, Math.ceil(meta.total / 50))
    || !Array.isArray(value.data) || value.data.length > 50
    || !value.data.every(row => row && Number.isSafeInteger(row.id) && row.id > 0
      && typeof row.email === 'string' && row.email.length > 0
      && (row.reason === null || typeof row.reason === 'string')
      && (row.updated_at === null || (typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at)))))) {
    throw new Error('Suppression data is invalid. Please retry.');
  }
  return value;
}

export interface CampaignSummary {
  id: number; name: string; status: string;
  stats: { total: number; sent: number; failed: number; opened: number; unsubscribed: number; bounced: number };
}
export interface CampaignRecipient {
  id: number; name: string | null; email: string; status: string; opened: boolean; bounced: boolean; unsubscribed: boolean;
  bounce_type?: string | null; retry_count?: number; next_retry_at?: string | null;
}
export interface CampaignDetail extends CampaignSummary {
  subject: string;
  recipients: CampaignRecipient[];
}
function validSummary(value: unknown): value is CampaignSummary {
  if (!value || typeof value !== 'object') return false;
  const c = value as CampaignSummary;
  return Number.isSafeInteger(c.id) && c.id > 0 && typeof c.name === 'string' && typeof c.status === 'string'
    && Boolean(c.stats) && ['total', 'sent', 'failed', 'opened', 'unsubscribed', 'bounced'].every(key => {
      const count = c.stats[key as keyof CampaignSummary['stats']];
      return Number.isSafeInteger(count) && count >= 0;
    });
}
async function read(token: string, path: string, signal?: AbortSignal): Promise<unknown> {
  if (!token) throw new Error('Please sign in to view campaigns.');
  const response = await fetch(`${environment.apiUrl}/api/campaigns${path}`, {
    method: 'GET', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).catch(error => {
    if (signal?.aborted) throw error;
    throw new Error('Could not connect to the server. Check your connection and retry.');
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again to view campaigns.'
    : response.status === 403 ? 'You do not have access to campaigns.'
    : response.status === 404 ? 'This campaign is no longer available.' : 'Could not load campaigns. Please retry.');
  return response.json().catch(error => {
    if (signal?.aborted) throw error;
    throw new Error('Could not read campaign data. Please retry.');
  });
}
export async function fetchCampaigns(token: string, signal?: AbortSignal): Promise<CampaignSummary[]> {
  const data = await read(token, '?limit=100', signal);
  if (!Array.isArray(data) || !data.every(validSummary)) throw new Error('Campaign data is invalid. Please retry.');
  return data;
}
export async function fetchCampaign(token: string, id: number, signal?: AbortSignal): Promise<CampaignDetail> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid campaign identifier.');
  const data = await read(token, `/${id}`, signal);
  const c = data as CampaignDetail;
  if (!validSummary(data) || c.id !== id || typeof c.subject !== 'string' || !Array.isArray(c.recipients)
    || !c.recipients.every(r => r && Number.isSafeInteger(r.id) && r.id > 0 && typeof r.email === 'string'
      && (r.name === null || typeof r.name === 'string') && typeof r.status === 'string'
      && typeof r.opened === 'boolean' && typeof r.bounced === 'boolean' && typeof r.unsubscribed === 'boolean'
      && (r.bounce_type == null || typeof r.bounce_type === 'string')
      && (r.retry_count === undefined || (Number.isSafeInteger(r.retry_count) && r.retry_count >= 0))
      && (r.next_retry_at == null || (typeof r.next_retry_at === 'string' && Number.isFinite(Date.parse(r.next_retry_at)))))) {
    throw new Error('Campaign data is invalid. Please retry.');
  }
  return c;
}
