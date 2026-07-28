import api from './axios';

/** A user's own Settings — profile, mail accounts, email preferences, integrations. */

export interface AccountProfile {
  id: number | null;
  name: string;
  username: string;
  email: string;
  phone: string;
  role: string;
  status: string;
}

export interface AccountMailAccount {
  id: number;
  name: string;
  from_name: string | null;
  from_email: string;
  host: string;
  port: number;
  username: string | null;
  encryption: string | null;
  is_active: boolean;
  is_default: boolean;
  has_password: boolean;
  /** 'crm' | 'desk' | null. Null pre-dates the CRM/Transaction-Desk split and shows on both. */
  scope: 'crm' | 'desk' | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_encryption: string | null;
  inbound_enabled: boolean;
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string | null;
}

export interface AccountEmailPrefs {
  signature: string;
  replyTemplate: string;
  autoSync: boolean;
  autoResponder: { enabled: boolean; message: string };
  forwardingAddress: string;
}

export interface IntegrationStatus { connected: boolean; detail: string }
export interface AccountIntegrations {
  email: IntegrationStatus;
  google_calendar: IntegrationStatus;
  meta: IntegrationStatus;
  mail_redirect: { active: boolean; detail: string };
}

export const getAccountProfile = (): Promise<AccountProfile> =>
  api.get<AccountProfile>('/api/account/profile').then((r) => r.data);

export const saveAccountProfile = (body: { name: string; username: string; phone: string }): Promise<AccountProfile> =>
  api.put<AccountProfile>('/api/account/profile', body).then((r) => r.data);

export const getAccountSettings = (): Promise<{ emailSettings: AccountEmailPrefs; integrations: AccountIntegrations }> =>
  api.get('/api/account/settings').then((r) => r.data);

export const saveAccountEmailPrefs = (emailSettings: Partial<AccountEmailPrefs>): Promise<unknown> =>
  api.put('/api/account/settings', { emailSettings }).then((r) => r.data);

/**
 * Which area an integration belongs to. CRM Settings and Transaction Desk Settings keep
 * separate connections, so an address added on one side never appears on the other.
 */
export type IntegrationScope = 'crm' | 'desk';

/** Omit the scope to list every account (the personal Settings screen). */
export const listMyMailAccounts = (scope?: IntegrationScope): Promise<AccountMailAccount[]> =>
  api.get<AccountMailAccount[]>('/api/account/mail-accounts', { params: scope ? { scope } : undefined })
    .then((r) => r.data);

/** Assign an existing account to an area, or null to leave it available to both. */
export const setMyMailAccountScope = (id: number, scope: IntegrationScope | null): Promise<AccountMailAccount> =>
  api.put<AccountMailAccount>(`/api/account/mail-accounts/${id}/scope`, { scope }).then((r) => r.data);

export interface MailAccountInput {
  name: string; from_name?: string; from_email: string; host: string; port: number;
  username?: string; password?: string; encryption?: string; is_active?: boolean; is_default?: boolean;
  imap_host?: string; imap_port?: number | null; imap_encryption?: string; inbound_enabled?: boolean;
}

// ---- Inbox (mail pulled from connected accounts over IMAP) ----
export interface InboxMessageRow {
  id: number; from_email: string | null; from_name: string | null; subject: string | null;
  snippet: string | null; received_at: string; seen: boolean; lead_id: number | null; lead_name: string | null;
}
export interface InboxMessage extends InboxMessageRow {
  to_email: string | null; body_text: string | null; body_html: string | null;
}
export interface InboxList {
  data: InboxMessageRow[];
  meta: { page: number; per_page: number; total: number; last_page: number };
  unread: number;
}

export const listInbox = (opts: { unread?: boolean; lead?: number; page?: number } = {}): Promise<InboxList> => {
  const params: Record<string, string | number> = {};
  if (opts.unread) params.unread = 1;
  if (opts.lead) params.lead = opts.lead;
  if (opts.page) params.page = opts.page;
  return api.get<InboxList>('/api/account/inbox', { params }).then((r) => r.data);
};

export const getInboxMessage = (id: number): Promise<InboxMessage> =>
  api.get<InboxMessage>(`/api/account/inbox/${id}`).then((r) => r.data);

export const markInboxSeen = (id: number, seen: boolean): Promise<{ seen: boolean }> =>
  api.put<{ seen: boolean }>(`/api/account/inbox/${id}/seen`, { seen }).then((r) => r.data);

export interface SyncResult { fetched: number; matched: number; error: string | null; message: string }
export const syncMailAccount = (accountId: number): Promise<SyncResult> =>
  api.post<SyncResult>(`/api/account/inbox/sync/${accountId}`, {}).then((r) => r.data);

// ---- Google Calendar (real OAuth) ----
export interface GoogleCalendarStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  last_sync: string | null;
  error: string | null;
  setup_hint: string | null;
}

export const googleCalendarStatus = (scope?: IntegrationScope): Promise<GoogleCalendarStatus> =>
  api.get<GoogleCalendarStatus>('/api/google/calendar/status', { params: scope ? { scope } : undefined }).then((r) => r.data);

/** Returns Google's consent-screen URL; the caller navigates the browser there. */
export const googleCalendarConnect = (scope?: IntegrationScope): Promise<{ configured: boolean; url?: string; message?: string }> =>
  api.get('/api/google/calendar/connect', { params: scope ? { scope } : undefined }).then((r) => r.data);

export const googleCalendarSync = (scope?: IntegrationScope): Promise<{ pulled: number; error: string | null; message: string }> =>
  api.post('/api/google/calendar/sync', {}, { params: scope ? { scope } : undefined }).then((r) => r.data);

export const googleCalendarDisconnect = (scope?: IntegrationScope): Promise<{ disconnected: boolean }> =>
  api.post('/api/google/calendar/disconnect', {}, { params: scope ? { scope } : undefined }).then((r) => r.data);

/**
 * Start connecting a Gmail account with OAuth ("Sign in with Google"). Returns Google's consent-URL;
 * the caller navigates the browser there. After consent the server stores the account and redirects
 * back with `mail_connected=1`. Works once the server has Google OAuth credentials + Gmail scope.
 */
export const mailGoogleConnect = (scope?: IntegrationScope): Promise<{ configured: boolean; url?: string; message?: string }> =>
  api.get('/api/google/mail/connect', { params: scope ? { scope } : undefined }).then((r) => r.data);

/** `scope` on the body stamps the new account with the area that created it. */
export const addMyMailAccount = (body: MailAccountInput & { scope?: IntegrationScope }): Promise<AccountMailAccount> =>
  api.post<AccountMailAccount>('/api/account/mail-accounts', body).then((r) => r.data);

export const updateMyMailAccount = (id: number, body: Partial<MailAccountInput>): Promise<AccountMailAccount> =>
  api.put<AccountMailAccount>(`/api/account/mail-accounts/${id}`, body).then((r) => r.data);

export const deleteMyMailAccount = (id: number): Promise<void> =>
  api.delete(`/api/account/mail-accounts/${id}`).then(() => undefined);

export const setMyDefaultMailAccount = (id: number): Promise<AccountMailAccount> =>
  api.post<AccountMailAccount>(`/api/account/mail-accounts/${id}/default`, {}).then((r) => r.data);

export const testMyMailAccount = (id: number, to?: string): Promise<{ message: string }> =>
  api.post<{ message: string }>(`/api/account/mail-accounts/${id}/test`, to ? { to } : {}).then((r) => r.data);
