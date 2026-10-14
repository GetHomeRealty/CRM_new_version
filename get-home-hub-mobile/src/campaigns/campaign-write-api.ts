import { environment } from '@/config/environment';
import { audienceFields, type AudienceFilters } from './campaign-preview-api';

export class UnconfirmedCampaignError extends Error {}
export interface CampaignDraft {
  name: string;
  templateId: number;
  tag: string;
  filters: AudienceFilters;
  scheduledFor?: string;
}

/** Run again immediately before submission: an expired schedule must never become send-now. */
export function campaignPayload(draft: CampaignDraft, now = Date.now()) {
  if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.trim().length > 255) throw new Error('Enter a campaign name of 1–255 characters.');
  if (!Number.isSafeInteger(draft.templateId) || draft.templateId < 1) throw new Error('Choose a template.');
  if (typeof draft.tag !== 'string' || draft.tag.length > 255) throw new Error('Invalid audience tag.');
  const filters: AudienceFilters = {};
  for (const key of Object.keys(draft.filters)) {
    if (!audienceFields.includes(key as typeof audienceFields[number])) throw new Error('Invalid audience filter.');
    const value = draft.filters[key as keyof AudienceFilters];
    if (typeof value !== 'string' || value.length > 255) throw new Error('Invalid audience filter.');
    if (value.trim()) filters[key as keyof AudienceFilters] = value.trim();
  }
  let scheduled_for: string | undefined;
  if (draft.scheduledFor !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(draft.scheduledFor)) throw new Error('Schedule must include a timezone.');
    const time = Date.parse(draft.scheduledFor);
    if (!Number.isFinite(time) || time < now + 60000) throw new Error('Schedule at least one minute in the future.');
    scheduled_for = new Date(time).toISOString();
  }
  return { name: draft.name.trim(), template_id: draft.templateId, tag: draft.tag.trim(), ...filters, ...(scheduled_for ? { scheduled_for } : {}) };
}

async function write(token: string, path: string, body: object, signal?: AbortSignal): Promise<unknown> {
  if (!token) throw new Error('Please sign in again.');
  if (signal?.aborted) throw new Error('Cancelled before submission.');
  let response: Response;
  try {
    response = await fetch(`${environment.apiUrl}/api/campaigns${path}`, { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // Aborting the client does not prove that the server stopped sending.
    throw new UnconfirmedCampaignError('Outcome unknown. Check campaign history before doing anything again; do not resubmit.');
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Please sign in again.');
    if (response.status === 403) throw new Error('You do not have permission to change campaigns.');
    if (response.status === 400 || response.status === 404) throw new Error('The request was rejected. Refresh the audience, template and campaign status.');
    throw new UnconfirmedCampaignError('Outcome unknown. Check campaign history; do not resubmit.');
  }
  try { return await response.json(); } catch { throw new UnconfirmedCampaignError('Could not confirm the result. Check campaign history; do not resubmit.'); }
}

/** No automatic retries. Caller must present recipient/content review and explicit confirmation. */
export async function submitCampaign(token: string, draft: CampaignDraft, signal?: AbortSignal, requestKey?: string): Promise<{ id: number; status: string }> {
  if (!requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestKey)) throw new Error('A durable submission key is required.');
  // Dedicated endpoint fails closed against servers without duplicate protection.
  const value = await write(token, '/submissions', { ...campaignPayload(draft), request_key: requestKey }, signal) as { id?: unknown; status?: unknown } | null;
  if (!value || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || typeof value.status !== 'string') throw new UnconfirmedCampaignError('Invalid confirmation. Check campaign history; do not resubmit.');
  return { id: Number(value.id), status: value.status };
}

export async function recoverCampaignSubmission(token: string, requestKey: string, signal?: AbortSignal): Promise<{ id: number; status: string }> {
  if (!token || signal?.aborted || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestKey)) throw new Error('A valid submission and sign-in are required.');
  const response = await fetch(`${environment.apiUrl}/api/campaigns/submissions/${requestKey}`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error('Submission is not confirmed. It may still be processing; do not resend.');
  const value = await response.json();
  if (!Number.isSafeInteger(value?.id) || value.id < 1 || typeof value.status !== 'string') throw new Error('Invalid recovery response. Do not resend.');
  return { id: value.id, status: value.status };
}

export async function cancelScheduledCampaign(token: string, id: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid campaign.');
  const value = await write(token, `/${id}/cancel`, {}, signal) as { cancelled?: unknown } | null;
  if (value?.cancelled !== true) throw new UnconfirmedCampaignError('Cancellation not confirmed. Refresh campaign status.');
}
