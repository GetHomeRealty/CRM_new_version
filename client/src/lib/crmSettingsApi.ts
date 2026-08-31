import api from './axios';
import type {
  CrmBroadcast, CrmEmailLogRow, CrmEmailSettings, CrmIntegrations, CrmProfile,
  CrmReferralCode, CrmSendResult, CrmSettings,
} from '../types';

/** CRM Settings API (migrated). Separate from Transaction Desk's own settings endpoints. */

export const crmOptions = (): Promise<{ seasons: string[]; broadcast_types: string[] }> =>
  api.get<{ seasons: string[]; broadcast_types: string[] }>('/api/crm-settings/options').then((r) => r.data);

export const getCrmSettings = (): Promise<CrmSettings> =>
  api.get<CrmSettings>('/api/crm-settings').then((r) => r.data);

export const saveCrmSettings = (body: Record<string, unknown>): Promise<CrmSettings & { message: string }> =>
  api.put<CrmSettings & { message: string }>('/api/crm-settings', body).then((r) => r.data);

export const getCrmProfile = (): Promise<CrmProfile> =>
  api.get<CrmProfile>('/api/crm-settings/profile').then((r) => r.data);

export const saveCrmProfile = (body: Partial<CrmProfile>): Promise<CrmProfile & { message: string }> =>
  api.put<CrmProfile & { message: string }>('/api/crm-settings/profile', body).then((r) => r.data);

export const getCrmEmailSettings = (): Promise<CrmEmailSettings> =>
  api.get<CrmEmailSettings>('/api/crm-settings/email-settings').then((r) => r.data);

export const saveCrmEmailSettings = (body: Record<string, unknown>): Promise<CrmEmailSettings & { message: string }> =>
  api.put<CrmEmailSettings & { message: string }>('/api/crm-settings/email-settings', body).then((r) => r.data);

/** The CRM's action-dispatch endpoint, preserved verbatim (sendSeasonalEmail, bulkSend, …). */
export const crmEmailAction = <T = CrmSendResult>(action: string, data: Record<string, unknown> = {}): Promise<T> =>
  api.post<T>('/api/crm-settings/email-settings', { action, ...data }).then((r) => r.data);

/*
 * `getMyTriggers` / `saveMyTriggers` stood here, wrapping `GET|PUT /api/crm-settings/triggers`.
 *
 * Both are gone with the CRM Triggers screen, and so are the routes behind them. The per-user
 * switches they set are still stored in exactly the same place — `crm_trigger_settings`, for
 * Welcome and the three manual emails — but they are written through
 * `PUT /api/crm-communications/preferences/:key/:channel` now, which calls the same
 * `CrmTriggersService.saveForUser` and writes the same audit trail. One switch per request, merged
 * into what is stored, rather than a whole screen posted back.
 */

export const listReferralCodes = (): Promise<CrmReferralCode[]> =>
  api.get<CrmReferralCode[]>('/api/crm-settings/referral-codes').then((r) => r.data);

/**
 * One page of the CRM send log, with the count the screen needs to say what it is NOT showing.
 *
 * The endpoint used to answer with a bare array, so a capped request looked identical to a complete
 * one - which on this brokerage's data hid a fortnight, failures included.
 */
export interface CrmEmailLogPage {
  data: CrmEmailLogRow[];
  meta: { total: number; limit: number; offset: number; complete: boolean; kind?: string | null };
}

export const listCrmEmailLog = (limit = 50, offset = 0, kind = ''): Promise<CrmEmailLogPage> =>
  api.get<CrmEmailLogPage>('/api/crm-settings/email-log', { params: { limit, offset, kind: kind || undefined } })
    .then((r) => r.data);

export const sendCrmBroadcast = (message: string, type = 'info'): Promise<{ recipients: number; message: string }> =>
  api.post<{ recipients: number; message: string }>('/api/crm-settings/broadcasts', { message, type }).then((r) => r.data);

export const listCrmBroadcasts = (): Promise<CrmBroadcast[]> =>
  api.get<CrmBroadcast[]>('/api/crm-settings/broadcasts').then((r) => r.data);

/** Removes the row for good — there is no soft delete behind this. The server refuses a send still
 *  in flight, and records the deletion in the audit trail. */
export const deleteCrmBroadcast = (id: number): Promise<{ deleted: boolean }> =>
  api.delete<{ deleted: boolean }>(`/api/crm-settings/broadcasts/${id}`).then((r) => r.data);

/** Same: permanent, audited, and refused for a row the caller cannot see in the log. */
export const deleteCrmEmailLog = (id: number): Promise<{ deleted: boolean }> =>
  api.delete<{ deleted: boolean }>(`/api/crm-settings/email-log/${id}`).then((r) => r.data);

export const crmIntegrations = (): Promise<CrmIntegrations> =>
  api.get<CrmIntegrations>('/api/crm-settings/integrations').then((r) => r.data);
