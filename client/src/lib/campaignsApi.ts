import api from './axios';
import type {
  AudienceFilter, AudiencePreview, CampaignDetail, CampaignOptions,
  CampaignSummary, TrackingHealth,
} from '../types';

/** Campaigns API. */

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

/** Create the campaign and send it to the resolved audience. */
export const sendCampaign = (body: AudienceFilter & { name: string; template_id: number; tags?: string[] }): Promise<CampaignSummary> =>
  api.post<CampaignSummary>('/api/campaigns', body).then((r) => r.data);

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
