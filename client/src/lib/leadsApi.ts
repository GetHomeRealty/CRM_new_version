import api from './axios';
import type {
  DeletedLead, Lead, LeadCall, LeadCallRecording, LeadDetail, LeadEmail, LeadFilters,
  LeadImportResult, LeadListResponse,
  LeadMessage, LeadNote, LeadOptions, LeadShowing, LeadTagCounts, LeadTask, LeadTaskRow,
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

/** Rows for a CSV export — the checked leads, or everything matching the filters. */
export const exportLeads = (leadIds: number[], filters: Partial<LeadFilters>): Promise<Record<string, string>[]> =>
  api.post<Record<string, string>[]>('/api/leads/export', { lead_ids: leadIds, filters }).then((r) => r.data);

export const importLeadsCsv = (csv: string, tag: string): Promise<LeadImportResult> =>
  api.post<LeadImportResult>('/api/leads/import', { csv, tag }).then((r) => r.data);

// ---- recently deleted ----
export const listDeletedLeads = (): Promise<{ count: number; data: DeletedLead[] }> =>
  api.get<{ count: number; data: DeletedLead[] }>('/api/leads/deleted').then((r) => r.data);

export const restoreLead = (id: number): Promise<void> =>
  api.post(`/api/leads/deleted/${id}/restore`).then(() => undefined);

export const purgeLead = (id: number): Promise<void> =>
  api.delete(`/api/leads/deleted/${id}`).then(() => undefined);

// ---- tags ----
/** Every lead task the caller can see, across all their leads — used by the Dashboard. */
export const listAllLeadTasks = (): Promise<LeadTaskRow[]> =>
  api.get<LeadTaskRow[]>('/api/leads/tasks').then((r) => r.data);

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

/** Whether the server can send SMS for real. No credentials are ever returned. */
export const smsGatewayStatus = (): Promise<SmsGatewayStatus> =>
  api.get<SmsGatewayStatus>('/api/sms/status').then((r) => r.data);

/** Marks an outbound message read or failed. Set by hand — there is no delivery receipt. */
export const updateLeadMessage = (leadId: number, messageId: number, body: { status: MessageStatus }): Promise<LeadMessage> =>
  api.put<LeadMessage>(`/api/leads/${leadId}/messages/${messageId}`, body).then((r) => r.data);

export const deleteLeadMessage = (leadId: number, messageId: number): Promise<void> =>
  api.delete(`/api/leads/${leadId}/messages/${messageId}`).then(() => undefined);
