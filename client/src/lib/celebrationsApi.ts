import api from './axios';
import type {
  AiGreetingDraft, AudiencePreviewResult, CelebrationAutomation, CelebrationDetail, CelebrationDraftInput,
  CelebrationOptions, CelebrationPreview, CelebrationSummary, Flyer, PickableLead, RecipientSpec,
} from '../types/celebration';

/** Campaigns → Celebrations API. Only `sendCelebration` sends to recipients. */
const base = '/api/campaigns/celebrations';

export const celebrationOptions = (): Promise<CelebrationOptions> =>
  api.get<CelebrationOptions>(`${base}/options`).then((r) => r.data);

export const listCelebrations = (): Promise<CelebrationSummary[]> =>
  api.get<CelebrationSummary[]>(base).then((r) => r.data);

export const getCelebration = (id: number): Promise<CelebrationDetail> =>
  api.get<CelebrationDetail>(`${base}/${id}`).then((r) => r.data);

export const createCelebration = (d: CelebrationDraftInput): Promise<CelebrationDetail> =>
  api.post<CelebrationDetail>(base, d).then((r) => r.data);

export const updateCelebration = (id: number, d: CelebrationDraftInput): Promise<CelebrationDetail> =>
  api.put<CelebrationDetail>(`${base}/${id}`, d).then((r) => r.data);

export const deleteCelebration = (id: number): Promise<void> =>
  api.delete(`${base}/${id}`).then(() => undefined);

/** Who would receive it, and who is excluded and why. Sends nothing. */
export const celebrationAudience = (body: {
  occasion: string; occasion_label?: string; recipients: RecipientSpec; timezone?: string;
  schedule_date?: string; schedule_time?: string;
}): Promise<AudiencePreviewResult> =>
  api.post<AudiencePreviewResult>(`${base}/audience`, body).then((r) => r.data);

export const searchCelebrationLeads = (search: string): Promise<PickableLead[]> =>
  api.get<PickableLead[]>(`${base}/leads`, { params: { search } }).then((r) => r.data);

/** The message as one recipient would get it. Sends nothing. */
export const previewCelebration = (d: CelebrationDraftInput & { sample_lead_id?: number | null }): Promise<CelebrationPreview> =>
  api.post<CelebrationPreview>(`${base}/preview`, d).then((r) => r.data);

export const starterMessage = (occasion: string, occasion_label: string): Promise<{ subject: string; preview_text: string; message: string }> =>
  api.post(`${base}/starter`, { occasion, occasion_label }).then((r) => r.data);

export const aiDraftGreeting = (body: {
  occasion: string; occasion_label?: string; instructions?: string; tone?: string; length?: string; language?: string;
  branding?: string; previous?: Partial<AiGreetingDraft> | null; revision?: string;
}): Promise<{ draft: AiGreetingDraft; warnings: string[]; provider: string }> =>
  api.post(`${base}/ai-draft`, body).then((r) => r.data);

export const uploadFlyer = (data: string, alt_text: string): Promise<Flyer> =>
  api.post<Flyer>(`${base}/flyers/upload`, { data, alt_text }).then((r) => r.data);

export const templateFlyer = (body: Record<string, unknown>): Promise<Flyer> =>
  api.post<Flyer>(`${base}/flyers/template`, body).then((r) => r.data);

export const getFlyer = (id: number): Promise<Flyer> =>
  api.get<Flyer>(`${base}/flyers/${id}`).then((r) => r.data);

export const updateFlyerAlt = (id: number, alt_text: string): Promise<Flyer> =>
  api.patch<Flyer>(`${base}/flyers/${id}`, { alt_text }).then((r) => r.data);

export const testCelebration = (id: number, to: string, sample_lead_id: number | null): Promise<{ ok: boolean; from?: string; message_id?: string | null; diverted_to?: string | null; error?: string }> =>
  api.post(`${base}/${id}/test`, { to, sample_lead_id }).then((r) => r.data);

/** Send now or schedule — the only call here that emails recipients. */
export const sendCelebration = (id: number, body: { mode: 'now' | 'schedule'; schedule_date?: string; schedule_time?: string; timezone?: string }): Promise<CelebrationDetail> =>
  api.post<CelebrationDetail>(`${base}/${id}/send`, { ...body, confirm: true }).then((r) => r.data);

export const cancelCelebration = (id: number): Promise<CelebrationDetail> =>
  api.post<CelebrationDetail>(`${base}/${id}/cancel`).then((r) => r.data);

export const retryCelebration = (id: number): Promise<CelebrationDetail> =>
  api.post<CelebrationDetail>(`${base}/${id}/retry-failed`).then((r) => r.data);

// ------------------------------------------------------------------------------- automations
export const listAutomations = (): Promise<CelebrationAutomation[]> =>
  api.get<CelebrationAutomation[]>(`${base}/automations`).then((r) => r.data);

export const saveAutomation = (id: number | null, body: Record<string, unknown>): Promise<CelebrationAutomation> =>
  (id ? api.put<CelebrationAutomation>(`${base}/automations/${id}`, body) : api.post<CelebrationAutomation>(`${base}/automations`, body)).then((r) => r.data);

export const deleteAutomation = (id: number): Promise<void> =>
  api.delete(`${base}/automations/${id}`).then(() => undefined);

export const activateAutomation = (id: number): Promise<CelebrationAutomation> =>
  api.post<CelebrationAutomation>(`${base}/automations/${id}/activate`, { confirm: true }).then((r) => r.data);

export const pauseAutomation = (id: number): Promise<CelebrationAutomation> =>
  api.post<CelebrationAutomation>(`${base}/automations/${id}/pause`).then((r) => r.data);

export const dryRunAutomation = (id: number, date: string): Promise<{ date: string; count: number; exclusions: AudiencePreviewResult['exclusions']; over_cap: boolean; recipients: { lead_id: number; name: string; email: string }[] }> =>
  api.post(`${base}/automations/${id}/dry-run`, { date }).then((r) => r.data);
