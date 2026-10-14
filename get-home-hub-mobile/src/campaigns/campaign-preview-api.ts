import { environment } from '@/config/environment';

export interface TemplateAttachment { id: number; filename: string; content_type: string; size: number }
export interface CampaignTemplate { id: number; name: string; subject: string; category: string; is_active: boolean; attachment_count: number; content?: string; attachments?: TemplateAttachment[] }
export interface AudiencePreview { count: number; sample: { name: string; email: string }[] }
export const audienceFields = ['leadStatus', 'leadType', 'leadSource', 'clientType'] as const;
export type AudienceField = typeof audienceFields[number];
export type AudienceFilters = Partial<Record<AudienceField, string>>;
export type AudienceOptions = Record<AudienceField, string[]>;
async function request(token: string, path: '/templates' | '/preview' | '/options', signal?: AbortSignal, body?: { tag: string } & AudienceFilters) {
  if (!token) throw new Error('Please sign in to view campaign tools.');
  const response = await fetch(`${environment.apiUrl}/api/campaigns${path}`, {
    method: path === '/preview' ? 'POST' : 'GET', signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(error => {
    if (signal?.aborted) throw error;
    throw new Error('Could not connect to the server. Check your connection and retry.');
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'You do not have access to campaign tools.'
    : response.status === 401 ? 'Please sign in again.' : 'Could not load campaign tools. Please retry.');
  return response.json().catch(error => {
    if (signal?.aborted) throw error;
    throw new Error('Could not read campaign data. Please retry.');
  });
}
export async function fetchAudienceOptions(token: string, signal?: AbortSignal): Promise<AudienceOptions> {
  const data = await request(token, '/options', signal);
  const mapping = { leadStatus: 'lead_status', leadType: 'lead_type', leadSource: 'lead_source', clientType: 'client_type' } as const;
  const options = {} as AudienceOptions;
  for (const key of audienceFields) {
    const values = data?.[mapping[key]];
    if (!Array.isArray(values) || !values.every(v => typeof v === 'string' && v.length > 0)) throw new Error('Audience options are unavailable. Please retry.');
    options[key] = [...new Set<string>(values)];
  }
  return options;
}
export async function fetchCampaignTemplates(token: string, signal?: AbortSignal): Promise<CampaignTemplate[]> {
  const data = await request(token, '/templates', signal);
  if (!Array.isArray(data) || !data.every(t => t && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.name === 'string'
    && typeof t.subject === 'string' && typeof t.category === 'string' && typeof t.is_active === 'boolean'
    && (t.content === undefined || (typeof t.content === 'string' && t.content.length <= 200000))
    && (t.attachments === undefined || (Array.isArray(t.attachments) && t.attachments.length === t.attachment_count
      && t.attachments.every((a: TemplateAttachment) => a && Number.isSafeInteger(a.id) && a.id > 0
        && typeof a.filename === 'string' && typeof a.content_type === 'string' && Number.isSafeInteger(a.size) && a.size >= 0)
      && new Set(t.attachments.map((a: TemplateAttachment) => a.id)).size === t.attachments.length))
    && Number.isSafeInteger(t.attachment_count) && t.attachment_count >= 0)) throw new Error('Template data is invalid.');
  return data;
}
/** Read-only server operation: resolves eligible recipients; never creates or sends a campaign. */
export async function previewCampaignAudience(token: string, tag: string, signal?: AbortSignal, filters: AudienceFilters = {}): Promise<AudiencePreview> {
  if (tag.length > 255) throw new Error('Tag must be 255 characters or fewer.');
  const selected: AudienceFilters = {};
  for (const key of Object.keys(filters)) {
    if (!audienceFields.includes(key as AudienceField)) throw new Error('Invalid audience filter.');
    const value = filters[key as AudienceField];
    if (typeof value !== 'string' || value.length > 255) throw new Error('Invalid audience filter.');
    if (value) selected[key as AudienceField] = value;
  }
  const data = await request(token, '/preview', signal, { tag: tag.trim(), ...selected });
  if (!data || !Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.sample)
    || data.sample.length > 5 || !data.sample.every((r: { name?: unknown; email?: unknown } | null) => r && typeof r.name === 'string' && typeof r.email === 'string')) {
    throw new Error('Audience data is invalid.');
  }
  return data;
}
