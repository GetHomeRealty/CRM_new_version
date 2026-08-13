import api from './axios';
import type {
  CrmBroadcast, CrmEmailLogRow, CrmEmailSettings, CrmIntegrations, CrmProfile,
  CrmMyTriggers, CrmReferralCode, CrmSendResult, CrmSettings,
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

/** The CRM's action-dispatch endpoint, preserved verbatim (sendWeddingEmail, bulkSend, …). */
export const crmEmailAction = <T = CrmSendResult>(action: string, data: Record<string, unknown> = {}): Promise<T> =>
  api.post<T>('/api/crm-settings/email-settings', { action, ...data }).then((r) => r.data);

/** A person's OWN CRM email triggers. Gated on the `triggers` permission, not `settings`. */
export const getMyTriggers = (): Promise<CrmMyTriggers> =>
  api.get<CrmMyTriggers>('/api/crm-settings/triggers').then((r) => r.data);

export const saveMyTriggers = (triggers: Record<string, boolean>): Promise<CrmMyTriggers & { message: string }> =>
  api.put<CrmMyTriggers & { message: string }>('/api/crm-settings/triggers', { triggers }).then((r) => r.data);

export const listReferralCodes = (): Promise<CrmReferralCode[]> =>
  api.get<CrmReferralCode[]>('/api/crm-settings/referral-codes').then((r) => r.data);

export const listCrmEmailLog = (limit = 50): Promise<CrmEmailLogRow[]> =>
  api.get<CrmEmailLogRow[]>('/api/crm-settings/email-log', { params: { limit } }).then((r) => r.data);

export const sendCrmBroadcast = (message: string, type = 'info'): Promise<{ recipients: number; message: string }> =>
  api.post<{ recipients: number; message: string }>('/api/crm-settings/broadcasts', { message, type }).then((r) => r.data);

export const listCrmBroadcasts = (): Promise<CrmBroadcast[]> =>
  api.get<CrmBroadcast[]>('/api/crm-settings/broadcasts').then((r) => r.data);

export const crmIntegrations = (): Promise<CrmIntegrations> =>
  api.get<CrmIntegrations>('/api/crm-settings/integrations').then((r) => r.data);
