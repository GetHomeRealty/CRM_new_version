import api from './axios';
import type {
  AudienceFilter, AudiencePreview, CampaignDetail, CampaignOptions,
  CampaignSummary, SuppressionPage, TrackingHealth,
} from '../types';

/** Campaigns API. */

/** One authentication mechanism, as DNS currently answers for it. */
export interface AuthCheck {
  name: 'SPF' | 'DKIM' | 'DMARC';
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  detail: string;
  /** The record to publish, when there is a concrete one worth naming. */
  fix?: string;
}

export interface DeliverabilityReport {
  domain: string;
  auth: AuthCheck[];
  content: { links: number; images: number; textRatio: number; imageOnly: boolean; signals: string[] } | null;
  risk: 'low' | 'medium' | 'high';
  checked_at: string;
  /** Present instead of a report when no sending mailbox is connected. */
  error?: string;
}

/**
 * Check what DNS says about the sending domain.
 *
 * The domain is omitted deliberately: the server defaults it to the address this user's campaigns
 * would actually leave from, and a report about a domain nobody sends from is a report about
 * nothing.
 */
export const deliverabilityReport = (): Promise<DeliverabilityReport> =>
  api.get<DeliverabilityReport>('/api/campaigns/deliverability').then((r) => r.data);

export const campaignOptions = (): Promise<CampaignOptions> =>
  api.get<CampaignOptions>('/api/campaigns/options').then((r) => r.data);

export const listCampaigns = (): Promise<CampaignSummary[]> =>
  api.get<CampaignSummary[]>('/api/campaigns').then((r) => r.data);

export const getCampaign = (id: number): Promise<CampaignDetail> =>
  api.get<CampaignDetail>(`/api/campaigns/${id}`).then((r) => r.data);

export const deleteCampaign = (id: number): Promise<void> =>
  api.delete(`/api/campaigns/${id}`).then(() => undefined);

/** Live recipient count for the builder. Sends nothing. */
export const previewAudience = (filter: AudienceFilter): Promise<AudiencePreview> =>
  api.post<AudiencePreview>('/api/campaigns/preview', filter).then((r) => r.data);

/**
 * Create the campaign and send it to the resolved audience.
 *
 * `scheduled_for` is an ISO instant. Omitted or in the past means send now — the server treats a
 * time that has just passed as "now" rather than refusing it, so a 9:00 send confirmed at 9:00:04
 * goes out instead of erroring about a moment that has gone.
 */
export const sendCampaign = (
  body: AudienceFilter & {
    name: string; template_id: number; tags?: string[]; scheduled_for?: string | null;
    /**
     * Names THIS commit attempt, so a repeat cannot become a second campaign.
     *
     * The server keys on it and hands back the original rather than creating again — see
     * `CampaignsService.createOnce`. Generate it once when the builder opens and send the SAME value
     * for every retry of that commit; a genuinely new campaign gets a new one, which is what keeps
     * two deliberately identical campaigns a week apart from collapsing into one.
     */
    idempotency_key?: string;
  },
): Promise<CampaignSummary> =>
  api.post<CampaignSummary>('/api/campaigns', body).then((r) => r.data);

/** Call off a campaign that has not gone out yet. Only possible while it is still `scheduled`. */
export const cancelScheduledCampaign = (id: number): Promise<{ cancelled: boolean }> =>
  api.post<{ cancelled: boolean }>(`/api/campaigns/${id}/cancel`, {}).then((r) => r.data);

// ---- suppression list ----
/**
 * Addresses the brokerage may no longer email. Brokerage-wide, not per agent: a suppression is the
 * recipient's decision about the brokerage, so every agent sees the same list.
 */
export const listSuppressions = (q: { page?: number; limit?: number; search?: string } = {}): Promise<SuppressionPage> =>
  api.get<SuppressionPage>('/api/campaigns/suppressions', {
    params: { page: q.page ?? 1, limit: q.limit ?? 50, search: q.search || undefined },
  }).then((r) => r.data);

/**
 * Resume mail to a suppressed address.
 *
 * The address is a path segment, so it is encoded — an unencoded `+` in a Gmail alias would
 * otherwise arrive as a space and delete nothing, or delete the wrong row.
 */
/**
 * Record an opt-out somebody gave by telephone, in person, or in a reply.
 *
 * The only route onto this list used to be the client clicking the unsubscribe link, so a brokerage
 * asked to stop by any other means had no way to comply.
 */
export const addSuppression = (email: string, reason: string): Promise<{ added: boolean; already: boolean }> =>
  api.post<{ added: boolean; already: boolean }>('/api/campaigns/suppressions', { email, reason })
    .then((r) => r.data);

export const removeSuppression = (email: string): Promise<{ removed: boolean }> =>
  api.delete<{ removed: boolean }>(`/api/campaigns/suppressions/${encodeURIComponent(email)}`).then((r) => r.data);

export const trackingHealth = (): Promise<TrackingHealth> =>
  api.get<TrackingHealth>('/api/campaigns/tracking-health').then((r) => r.data);

/** Pre-flight: send one test email through the account a campaign would use, to verify SMTP creds. */
export const sendTestEmail = (to: string): Promise<{ ok: boolean; from?: string; account?: string; error?: string }> =>
  api.post<{ ok: boolean; from?: string; account?: string; error?: string }>('/api/campaigns/test-send', { to }).then((r) => r.data);

// ---- leads (the campaign audience) ----
export const leadTags = (): Promise<string[]> =>
  api.get<{ tags: string[] }>('/api/campaigns/leads/tags').then((r) => r.data.tags);

export const importLeads = (csv: string, tag: string): Promise<{ imported: number; tagged: number; invalid: number }> =>
  api.post('/api/campaigns/leads/import', { csv, tag }).then((r) => r.data);

export const previewSegment = (filter: AudienceFilter): Promise<{ count: number }> =>
  api.post<{ count: number }>('/api/campaigns/leads/tag', { ...filter, preview: true }).then((r) => r.data);

export const tagSegment = (filter: AudienceFilter, tagToApply: string, mode: 'add' | 'remove'): Promise<{ count: number; message: string }> =>
  api.post('/api/campaigns/leads/tag', { ...filter, tagToApply, mode }).then((r) => r.data);
