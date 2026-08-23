import type { Area } from '../desk/area';
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

/**
 * One switchable push notification.
 *
 * `readiness` is here because most of these categories do not have a push sender yet — only the
 * calendar's reminders do. The screen says so rather than presenting seven identical toggles, six
 * of which would appear to do nothing. `current_channel` is how the user is told today.
 */
/** The ways the application can reach somebody. */
export type NotificationChannel = 'in_app' | 'email' | 'push';

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
  push: 'Push',
};

/**
 * Whether a (category, channel) pair actually has a sender.
 *
 *   live         something sends it and honours the choice now.
 *   pending      the event happens and reaches you another way; no sender on this channel yet.
 *   unsupported  the channel makes no sense for this event and is not offered.
 */
export type ChannelReadiness = 'live' | 'pending' | 'unsupported';

export interface NotificationCategory {
  key: string;
  label: string;
  description: string;
  /** Readiness per channel — what the matrix renders each cell from. */
  channels: Record<NotificationChannel, ChannelReadiness>;
  /** This person's answer per channel. */
  enabled: Record<NotificationChannel, boolean>;
  /**
   * Which area's screen offers this category. Absent means both — the server omits it for anything
   * not tied to one side of the product, so absence must be read as "show it", never as "hide it".
   */
  areas?: ('crm' | 'desk')[];
}

export interface NotificationPreferences {
  channels: NotificationChannel[];
  categories: NotificationCategory[];
}

export const getNotificationPreferences = (): Promise<NotificationPreferences> =>
  api.get('/api/account/notification-preferences').then((r) => r.data);

/** Saves the whole matrix: a `{ category: { channel: enabled } }` map. */
export const saveNotificationPreferences = (
  prefs: Record<string, Record<string, boolean>>,
): Promise<NotificationPreferences> =>
  api.put('/api/account/notification-preferences', prefs).then((r) => r.data);

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
/**
 * How many email accounts this user may connect in one area — the server's rule, not a guess from
 * the role. Section 7 requires the limit on both sides, and asking keeps the button's explanation
 * and the POST's validation from ever disagreeing.
 */
export interface EmailAccountLimit { max: number | null; used: number; canAdd: boolean }
export const mailAccountLimit = (scope: IntegrationScope): Promise<EmailAccountLimit> =>
  api.get<EmailAccountLimit>('/api/account/mail-accounts/limit', { params: { scope } }).then((r) => r.data);

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
  /**
   * The mailbox on screen — the account marked primary for this area. Null when none is marked, in
   * which case the list falls back to every account the area can see.
   */
  mailbox: { address: string; is_primary: boolean; auto_sync: boolean } | null;
}

/**
 * The inbox is per-area: the CRM's shows mail from accounts connected under CRM Settings, the
 * Transaction Desk's from accounts connected under Transaction Desk Settings. Every call carries
 * the area, because the server — not the caller — decides which accounts are in scope, and a read
 * that forgot to say would silently fall back to the Transaction Desk's mail.
 */
export const listInbox = (area: Area, opts: { unread?: boolean; lead?: number; page?: number } = {}): Promise<InboxList> => {
  const params: Record<string, string | number> = { area };
  if (opts.unread) params.unread = 1;
  if (opts.lead) params.lead = opts.lead;
  if (opts.page) params.page = opts.page;
  return api.get<InboxList>('/api/account/inbox', { params }).then((r) => r.data);
};

export const getInboxMessage = (area: Area, id: number): Promise<InboxMessage> =>
  api.get<InboxMessage>(`/api/account/inbox/${id}`, { params: { area } }).then((r) => r.data);

export const markInboxSeen = (area: Area, id: number, seen: boolean): Promise<{ seen: boolean }> =>
  api.put<{ seen: boolean }>(`/api/account/inbox/${id}/seen`, { seen }, { params: { area } }).then((r) => r.data);

/* ------------------------------------------------------------------ mailbox */
/**
 * The WRITABLE mailbox — compose, reply, forward, drafts, sent, search, archive and trash.
 *
 * Separate from `listInbox` above, which is the original read-only list and stays as it is. Every
 * call carries the AREA, because the CRM and Transaction Desk mailboxes are two views over two sets
 * of connected accounts even when the same address serves both. The server scopes by the signed-in
 * user and by that area; nothing here identifies a user, and there is no administrator override.
 */
export type MailboxFolder = 'inbox' | 'archive' | 'trash' | 'drafts' | 'sent';

export interface MailboxRow {
  id: number;
  kind: 'received' | 'draft' | 'sent';
  from_email?: string | null;
  from_name?: string | null;
  to_email?: string | null;
  subject: string | null;
  snippet?: string | null;
  date: string | null;
  seen?: boolean;
  status?: string;
  error?: string | null;
  thread_key?: string | null;
  has_attachments?: boolean;
}

export interface MailboxList {
  data: MailboxRow[];
  meta: { page: number; per_page: number; total: number; last_page: number };
  unread: number;
  folder: MailboxFolder;
  /** The primary account for this area, so the screen can name the mailbox it is showing. */
  mailbox: { address: string; is_primary: boolean; auto_sync: boolean } | null;
}

export interface MailboxAttachment { id: number; filename: string; mime: string | null; size_bytes: number }

/**
 * An image the body refers to by `cid:` — a signature logo, an embedded photo.
 *
 * Deliberately not a `MailboxAttachment`: it carries no size because nothing offers it as a
 * download, and it carries `content_id` because that string is the only thing that ties it to the
 * `<img src="cid:…">` in the HTML.
 */
export interface MailboxInlineImage { id: number; content_id: string | null; mime: string | null; filename: string }

export interface MailboxMessage extends MailboxRow {
  body_text?: string | null;
  body_html?: string | null;
  lead_id?: number | null;
  lead_name?: string | null;
  attachments?: MailboxAttachment[];
  inline_images?: MailboxInlineImage[];
  archived?: boolean;
  deleted?: boolean;
}

export interface MailboxDraft {
  id: number;
  status: string;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  body_html: string | null;
  in_reply_to: string | null;
  sent_at: string | null;
  error: string | null;
  attachments: MailboxAttachment[];
}

/** What the composer opens with for a reply, reply-all or forward — built on the server. */
export interface ComposePrefill {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body_html: string;
  in_reply_to_id: number | null;
  attachments: MailboxAttachment[];
}

export interface ComposeBody {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body_html?: string;
  in_reply_to_id?: number | null;
  /** Base64, without the data: prefix. Bounded by the server at 10 MB each and 25 MB in total. */
  attachments?: { filename: string; mime: string; data: string }[];
}

export const listMailbox = (
  area: Area,
  opts: { folder?: MailboxFolder; page?: number; q?: string; unread?: boolean; accountId?: number | null } = {},
): Promise<MailboxList> => {
  const params: Record<string, string | number> = { area, folder: opts.folder ?? 'inbox' };
  if (opts.page) params.page = opts.page;
  if (opts.q && opts.q.trim()) params.q = opts.q.trim();
  if (opts.unread) params.unread = 1;
  /*
   * Omitted means "the default mailbox", which is what the server does with no `accountId`. Sending
   * nothing is therefore the correct request for the unswitched Inbox — there is deliberately no
   * value meaning "every account".
   */
  if (opts.accountId) params.accountId = opts.accountId;
  return api.get<MailboxList>('/api/account/mailbox', { params }).then((r) => r.data);
};

export const getMailboxMessage = (area: Area, id: number): Promise<MailboxMessage> =>
  api.get<MailboxMessage>(`/api/account/mailbox/message/${id}`, { params: { area } }).then((r) => r.data);

export const getComposePrefill = (area: Area, id: number, mode: 'reply' | 'reply_all' | 'forward'): Promise<ComposePrefill> =>
  api.get<ComposePrefill>(`/api/account/mailbox/message/${id}/${mode}`, { params: { area } }).then((r) => r.data);

export const moveMailboxMessage = (area: Area, id: number, action: 'archive' | 'unarchive' | 'trash' | 'restore'): Promise<unknown> =>
  api.post(`/api/account/mailbox/message/${id}/${action}`, {}, { params: { area } }).then((r) => r.data);

export const saveMailboxDraft = (area: Area, body: ComposeBody, id?: number): Promise<MailboxDraft> =>
  (id
    ? api.put<MailboxDraft>(`/api/account/mailbox/drafts/${id}`, body, { params: { area } })
    : api.post<MailboxDraft>('/api/account/mailbox/drafts', body, { params: { area } })
  ).then((r) => r.data);

export const getMailboxDraft = (area: Area, id: number): Promise<MailboxDraft> =>
  api.get<MailboxDraft>(`/api/account/mailbox/drafts/${id}`, { params: { area } }).then((r) => r.data);

export const deleteMailboxDraft = (area: Area, id: number): Promise<unknown> =>
  api.delete(`/api/account/mailbox/drafts/${id}`, { params: { area } }).then((r) => r.data);

export const sendMailboxMessage = (area: Area, body: ComposeBody, draftId?: number): Promise<MailboxDraft> =>
  (draftId
    ? api.post<MailboxDraft>(`/api/account/mailbox/drafts/${draftId}/send`, body, { params: { area } })
    : api.post<MailboxDraft>('/api/account/mailbox/send', body, { params: { area } })
  ).then((r) => r.data);

/** Download one attachment. The server checks the message belongs to this user before reading it. */
export const downloadMailboxAttachment = async (area: Area, kind: 'received' | 'draft', id: number, filename: string): Promise<void> => {
  const res = await api.get(`/api/account/mailbox/attachment/${kind}/${id}`, { params: { area }, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * One attachment's bytes, to RENDER rather than to save — the inline images in a message body.
 *
 * The same route as the download above, which is the point: the ownership check that decides who
 * may read an attachment stays in one place on the server. Only what the caller does with the
 * bytes differs.
 */
export const fetchMailboxAttachmentBlob = (area: Area, kind: 'received' | 'draft', id: number): Promise<Blob> =>
  api.get(`/api/account/mailbox/attachment/${kind}/${id}`, { params: { area }, responseType: 'blob' })
    .then((r) => r.data as Blob);

export interface SyncResult { fetched: number; matched: number; error: string | null; message: string }
export const syncMailAccount = (area: Area, accountId: number): Promise<SyncResult> =>
  api.post<SyncResult>(`/api/account/inbox/sync/${accountId}`, {}, { params: { area } }).then((r) => r.data);

// ---- Google Calendar (real OAuth) ----
export interface GoogleCalendarStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  last_sync: string | null;
  error: string | null;
  setup_hint: string | null;
  /**
   * Appointments this user has changed that Google has not received (CRM-GCAL-M01).
   *
   * Separate from `error`: the connection can look healthy right now and still owe Google a viewing
   * that failed to push during an outage half an hour ago.
   */
  pending_sync: number;
}

export const googleCalendarStatus = (scope?: IntegrationScope): Promise<GoogleCalendarStatus> =>
  api.get<GoogleCalendarStatus>('/api/google/calendar/status', { params: scope ? { scope } : undefined }).then((r) => r.data);

/** Returns Google's consent-screen URL; the caller navigates the browser there. */
export const googleCalendarConnect = (scope?: IntegrationScope): Promise<{ configured: boolean; url?: string; message?: string }> =>
  api.get('/api/google/calendar/connect', { params: scope ? { scope } : undefined }).then((r) => r.data);

export const googleCalendarSync = (scope?: IntegrationScope): Promise<{ pulled: number; error: string | null; message: string }> =>
  api.post('/api/google/calendar/sync', {}, { params: scope ? { scope } : undefined }).then((r) => r.data);

/** Try this user's outstanding pushes again, resetting the automatic attempt count. */
export const googleCalendarRetrySync = (scope?: IntegrationScope): Promise<{
  attempted: number; recovered: number;
  /** Refused permanently by Google (e.g. a Contact birthday): no longer outstanding, never synced. */
  released?: number;
  pending_sync: number; message: string;
}> => api.post('/api/google/calendar/retry', {}, { params: scope ? { scope } : undefined }).then((r) => r.data);

export const googleCalendarDisconnect = (scope?: IntegrationScope): Promise<{ disconnected: boolean }> =>
  api.post('/api/google/calendar/disconnect', {}, { params: scope ? { scope } : undefined }).then((r) => r.data);

/**
 * Start connecting a Gmail account with OAuth ("Connect Gmail"). Returns Google's consent-URL;
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
