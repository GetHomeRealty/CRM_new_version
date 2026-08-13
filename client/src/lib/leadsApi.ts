import api from './axios';
import type {
  DeletedLead, Lead, LeadCall, LeadCallRecording, LeadDetail, LeadEmail, LeadFilters,
  LeadImportResult, LeadListResponse,
  LeadMessage, LeadNote, LeadOptions, LeadShowing, LeadShowingRow, LeadTagCounts, LeadTask, LeadTaskRow,
  MessageStatus, SmsGatewayStatus,
} from '../types';

/** Leads API. */

/** Drop empty filters so the query string only carries what is actually filtering. */
const params = (filters: Partial<LeadFilters>, extra: Record<string, string | number> = {}): Record<string, string | number> => {
  const out: Record<string, string | number> = { ...extra };
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v != null) out[k] = v;
  return out;
};

export const leadOptions = (): Promise<LeadOptions> =>
  api.get<LeadOptions>('/api/leads/options').then((r) => r.data);

export const listLeads = (filters: Partial<LeadFilters>, page = 1, limit = 50): Promise<LeadListResponse> =>
  api.get<LeadListResponse>('/api/leads', { params: params(filters, { page, limit }) }).then((r) => r.data);

export const getLead = (id: number): Promise<LeadDetail> =>
  api.get<LeadDetail>(`/api/leads/${id}`).then((r) => r.data);

export const createLead = (body: Partial<Lead>): Promise<Lead> =>
  api.post<Lead>('/api/leads', body).then((r) => r.data);

export const updateLead = (id: number, body: Partial<Lead>): Promise<Lead> =>
  api.put<Lead>(`/api/leads/${id}`, body).then((r) => r.data);

export const deleteLead = (id: number): Promise<void> =>
  api.delete(`/api/leads/${id}`).then(() => undefined);

export const bulkDeleteLeads = (leadIds: number[]): Promise<{ deleted: number }> =>
  api.post<{ deleted: number }>('/api/leads/bulk-delete', { lead_ids: leadIds }).then((r) => r.data);

/**
 * Rows for a CSV export — the checked leads, or everything matching the filters.
 *
 * `meta.truncated` says whether the server had more to give. It used to return a bare array, so a
 * capped export was indistinguishable from a complete one and the screen reported the truncated
 * count as a success.
 */
export interface LeadExportResult {
  data: Record<string, string>[];
  meta: { total: number; returned: number; limit: number; truncated: boolean };
}

export const exportLeads = (leadIds: number[], filters: Partial<LeadFilters>): Promise<LeadExportResult> =>
  api.post<LeadExportResult>('/api/leads/export', { lead_ids: leadIds, filters }).then((r) => r.data);

export const importLeadsCsv = (csv: string, tag: string): Promise<LeadImportResult> =>
  api.post<LeadImportResult>('/api/leads/import', { csv, tag }).then((r) => r.data);

// ---- recently deleted ----
export interface DeletedLeadPage {
  count: number;
  data: DeletedLead[];
  meta: { page: number; per_page: number; total: number; last_page: number };
}

/**
 * The recycle bin, a page at a time.
 *
 * `meta` matters here more than on the live list: this screen used to return at most 200 rows with
 * no indication there were more, so past that point somebody's deleted lead was simply not on the
 * screen they had opened specifically to find it.
 */
export const listDeletedLeads = (opts: { page?: number; limit?: number; search?: string } = {}): Promise<DeletedLeadPage> => {
  const q = new URLSearchParams();
  if (opts.page) q.set('page', String(opts.page));
  if (opts.limit) q.set('limit', String(opts.limit));
  // Matched on name or email server-side, within the caller's own leads.
  if (opts.search?.trim()) q.set('search', opts.search.trim());
  const qs = q.toString();
  return api.get<DeletedLeadPage>(`/api/leads/deleted${qs ? `?${qs}` : ''}`).then((r) => r.data);
};

export const restoreLead = (id: number): Promise<void> =>
  api.post(`/api/leads/deleted/${id}/restore`).then(() => undefined);

export const purgeLead = (id: number): Promise<void> =>
  api.delete(`/api/leads/deleted/${id}`).then(() => undefined);

// ---- tags ----
/**
 * A page of lead tasks across the caller's leads — the Dashboard panel.
 *
 * `summary` is counted across the WHOLE set, not the page, because the panel heading reads
 * "N open of M" and computing that from twenty-five rows would be a different, wrong number.
 * These feeds were unpaginated and reached 1.67 MB in a single response on a real book.
 */
export interface LeadFeedPage<T> {
  data: T[];
  meta: { page: number; per_page: number; total: number; last_page: number };
  summary: Record<string, number>;
}

/**
 * Coerce a feed response into a whole `LeadFeedPage`, whatever arrived.
 *
 * WHY THIS IS HERE. These two endpoints used to return a bare array and now return
 * `{ data, meta, summary }`. The panels read all three, so against the older shape every one of
 * them was `undefined` — and `const { open } = feed.summary` threw, which the error boundary turned
 * into a blank CRM Dashboard. A whole screen was lost because one aggregate was missing.
 *
 * An API server left running across the change serves the old shape from memory, which is exactly
 * when somebody is looking at the screen. But the deeper point is that a panel should not be able
 * to take the page down over a field it does not own, so the shape is settled once, here, rather
 * than defended in each panel.
 *
 * The derived values are CORRECT rather than placeholders: a bare array was the complete,
 * unpaginated set, so counting it gives the same answer the server would. They are computed with
 * the same definitions the server uses — see `allTasks`/`allShowings` — so the number does not
 * change depending on which shape came back.
 */
function toFeedPage<T>(raw: unknown, summarise: (rows: T[]) => Record<string, number>): LeadFeedPage<T> {
  const whole = (data: T[]): LeadFeedPage<T> => ({
    data,
    meta: { page: 1, per_page: data.length, total: data.length, last_page: 1 },
    summary: summarise(data),
  });

  if (Array.isArray(raw)) return whole(raw as T[]);

  const page = (raw ?? {}) as Partial<LeadFeedPage<T>>;
  const data = Array.isArray(page.data) ? page.data : [];
  return {
    data,
    meta: page.meta ?? whole(data).meta,
    summary: page.summary ?? summarise(data),
  };
}

/** Open, overdue and total — the same definitions `allTasks` counts with. */
const taskSummary = (rows: LeadTaskRow[]): Record<string, number> => {
  const today = new Date().toISOString().slice(0, 10);
  return {
    total: rows.length,
    open: rows.filter((t) => t.status === 'pending').length,
    overdue: rows.filter((t) => t.status === 'pending' && t.due_date < today).length,
  };
};

/** Upcoming and total — the same definitions `allShowings` counts with. */
const showingSummary = (rows: LeadShowingRow[]): Record<string, number> => ({
  total: rows.length,
  upcoming: rows.filter((s) => s.status === 'scheduled').length,
});

export const listAllLeadTasks = (page = 1, limit?: number): Promise<LeadFeedPage<LeadTaskRow>> =>
  api.get<unknown>('/api/leads/tasks', { params: { page, limit } })
    .then((r) => toFeedPage<LeadTaskRow>(r.data, taskSummary));

/** A page of upcoming showings across the caller's leads, for the Dashboard. */
export const listAllLeadShowings = (page = 1, limit?: number): Promise<LeadFeedPage<LeadShowingRow>> =>
  api.get<unknown>('/api/leads/showings', { params: { page, limit } })
    .then((r) => toFeedPage<LeadShowingRow>(r.data, showingSummary));

export const listLeadTags = (): Promise<LeadTagCounts> =>
  api.get<LeadTagCounts>('/api/leads/tags').then((r) => r.data);

export const createLeadTag = (tag: string): Promise<{ tag: string }> =>
  api.post<{ tag: string }>('/api/leads/tags', { tag }).then((r) => r.data);

export const deleteLeadTag = (tag: string): Promise<{ tag: string; removed: number; lead_ids: number[] }> =>
  api.delete<{ tag: string; removed: number; lead_ids: number[] }>('/api/leads/tags', { params: { tag } }).then((r) => r.data);

export const tagLeads = (leadIds: number[], tag: string, mode: 'add' | 'remove'): Promise<{ changed: number; message: string }> =>
  api.post<{ changed: number; message: string }>('/api/leads/tag', { lead_ids: leadIds, tag, mode }).then((r) => r.data);

// ---- activity ----
export const addLeadNote = (leadId: number, content: string): Promise<LeadNote> =>
  api.post<LeadNote>(`/api/leads/${leadId}/notes`, { content }).then((r) => r.data);

export const updateLeadNote = (leadId: number, noteId: number, body: Partial<LeadNote>): Promise<LeadNote> =>
  api.put<LeadNote>(`/api/leads/${leadId}/notes/${noteId}`, body).then((r) => r.data);

export const deleteLeadNote = (leadId: number, noteId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/notes/${noteId}`).then(() => undefined);

export const addLeadTask = (leadId: number, body: Partial<LeadTask>): Promise<LeadTask> =>
  api.post<LeadTask>(`/api/leads/${leadId}/tasks`, body).then((r) => r.data);

export const updateLeadTask = (leadId: number, taskId: number, body: Partial<LeadTask>): Promise<LeadTask> =>
  api.put<LeadTask>(`/api/leads/${leadId}/tasks/${taskId}`, body).then((r) => r.data);

export const deleteLeadTask = (leadId: number, taskId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/tasks/${taskId}`).then(() => undefined);

export const addLeadShowing = (leadId: number, body: Partial<LeadShowing>): Promise<LeadShowing> =>
  api.post<LeadShowing>(`/api/leads/${leadId}/showings`, body).then((r) => r.data);

export const updateLeadShowing = (leadId: number, showingId: number, body: Partial<LeadShowing>): Promise<LeadShowing> =>
  api.put<LeadShowing>(`/api/leads/${leadId}/showings/${showingId}`, body).then((r) => r.data);

export const deleteLeadShowing = (leadId: number, showingId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/showings/${showingId}`).then(() => undefined);

export const addLeadCall = (leadId: number, body: Partial<LeadCall>): Promise<LeadCall> =>
  api.post<LeadCall>(`/api/leads/${leadId}/calls`, body).then((r) => r.data);

export const deleteLeadCall = (leadId: number, callId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/calls/${callId}`).then(() => undefined);

/**
 * Click-to-call: Twilio rings the agent's own phone, then bridges the lead. Only works when the
 * server's Twilio voice gateway is configured (see `smsGatewayStatus().voice`). Logs the attempt.
 */
export const placeLeadCall = (leadId: number): Promise<LeadCall> =>
  api.post<LeadCall>(`/api/leads/${leadId}/call`, {}).then((r) => r.data);

// ---- In-browser (Voice SDK) calling ----
/** Whether the server can hand the browser a Voice token (API key/secret + TwiML app all set). */
export const voiceCallStatus = (): Promise<{ configured: boolean }> =>
  api.get<{ configured: boolean }>('/api/twilio/voice/status').then((r) => r.data);

/** A short-lived Twilio Voice access token for this browser to place a call. */
export const voiceToken = (): Promise<{ token: string; identity: string; ttl: number }> =>
  api.get<{ token: string; identity: string; ttl: number }>('/api/twilio/voice/token').then((r) => r.data);

/** Log the call up front + get the E.164 number for the Voice SDK to dial. */
export const startBrowserCall = (leadId: number): Promise<{ callId: number; to: string; leadName: string }> =>
  api.post<{ callId: number; to: string; leadName: string }>(`/api/leads/${leadId}/browser-call`, {}).then((r) => r.data);

/** Audio a user attaches to a logged call — nothing records it automatically. */
export const addCallRecording = (
  leadId: number, callId: number, body: { filename: string; content_type: string; data: string },
): Promise<LeadCallRecording> =>
  api.post<LeadCallRecording>(`/api/leads/${leadId}/calls/${callId}/recording`, body).then((r) => r.data);

export const deleteCallRecording = (leadId: number, callId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/calls/${callId}/recording`).then(() => undefined);

/**
 * Where the <audio> element points. The stream is behind the same session cookie as everything
 * else, which the browser sends automatically on a media request to our own origin.
 */
export const callRecordingUrl = (leadId: number, callId: number): string =>
  `${api.defaults.baseURL ?? ''}/api/leads/${leadId}/calls/${callId}/recording`;

/**
 * Records a message in the SMS conversation. Pass `send: true` to have the server deliver it
 * through the SMS gateway; without that it only records what the agent sent by other means.
 */
export const addLeadMessage = (leadId: number, body: Partial<LeadMessage> & { send?: boolean }): Promise<LeadMessage> =>
  api.post<LeadMessage>(`/api/leads/${leadId}/messages`, body).then((r) => r.data);

/**
 * Emails this one lead through the configured SMTP account. Not a campaign: no tracking pixel,
 * no unsubscribe footer, no audience. Rejected outright if the lead has unsubscribed.
 */
export const sendLeadEmail = (leadId: number, body: { subject: string; body: string; account_id?: number | null }): Promise<LeadEmail> =>
  api.post<LeadEmail>(`/api/leads/${leadId}/email`, body).then((r) => r.data);

/** Draft an email with AI from a plain-language prompt. Returns a subject + styled HTML; sends nothing. */
export const generateLeadEmail = (leadId: number, prompt: string): Promise<{ subject: string; html: string }> =>
  api.post<{ subject: string; html: string }>(`/api/leads/${leadId}/email/generate`, { prompt }).then((r) => r.data);

/** Whether the server can send SMS for real. No credentials are ever returned. */
export const smsGatewayStatus = (): Promise<SmsGatewayStatus> =>
  api.get<SmsGatewayStatus>('/api/sms/status').then((r) => r.data);

/** Marks an outbound message read or failed. Set by hand — there is no delivery receipt. */
export const updateLeadMessage = (leadId: number, messageId: number, body: { status: MessageStatus }): Promise<LeadMessage> =>
  api.put<LeadMessage>(`/api/leads/${leadId}/messages/${messageId}`, body).then((r) => r.data);

export const deleteLeadMessage = (leadId: number, messageId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/messages/${messageId}`).then(() => undefined);
