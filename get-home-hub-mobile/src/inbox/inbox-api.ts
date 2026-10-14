import { environment } from '@/config/environment';

export type InboxArea = 'crm' | 'desk';
export interface InboxMessage {
  id: number;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string;
  seen: boolean;
  lead_id: number | null;
  lead_name: string | null;
}
export interface InboxPage {
  data: InboxMessage[];
  meta: { page: number; per_page: number; total: number; last_page: number };
  unread: number;
  mailbox: { address: string; is_primary: boolean; auto_sync: boolean } | null;
}
export interface InboxDetail extends Omit<InboxMessage, 'snippet'> {
  attachments?: import('./mail-archive-api').ArchiveAttachments;
  to_email: string;
  body_text: string | null;
  body_html: string | null;
}

function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid inbox identifier.');
  return value;
}

async function request<T>(token: string, path: string, signal?: AbortSignal, seen?: boolean): Promise<T> {
  const response = await fetch(`${environment.apiUrl}/api/account/inbox${path}`, {
    method: seen === undefined ? 'GET' : 'PUT',
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(seen === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(seen === undefined ? {} : { body: JSON.stringify({ seen }) }),
  });
  if (!response.ok) {
    // Do not surface arbitrary server/HTML content or accidentally expose mailbox details.
    throw new Error(response.status === 401 ? 'Please sign in again to open your inbox.'
      : response.status === 403 ? 'You do not have access to this inbox.'
      : response.status === 404 ? 'This message is no longer available.'
      : 'Could not load your inbox. Please retry.');
  }
  return response.json() as Promise<T>;
}

export function fetchInbox(token: string, area: InboxArea, options: {
  page?: number; unread?: boolean; leadId?: number; signal?: AbortSignal;
} = {}): Promise<InboxPage> {
  const query = new URLSearchParams({ area, page: String(positiveId(options.page ?? 1)) });
  if (options.unread) query.set('unread', '1');
  if (options.leadId !== undefined) query.set('lead', String(positiveId(options.leadId)));
  return request(token, `?${query}`, options.signal);
}

/** Explicit user-open action only: the server marks the message read. Never prefetch. */
export function openInboxMessage(token: string, area: InboxArea, id: number, signal?: AbortSignal): Promise<InboxDetail> {
  return request(token, `/${positiveId(id)}?${new URLSearchParams({ area })}`, signal);
}

export function setInboxMessageSeen(token: string, area: InboxArea, id: number, seen: boolean): Promise<{ seen: boolean }> {
  return request(token, `/${positiveId(id)}/seen?${new URLSearchParams({ area })}`, undefined, seen);
}

export interface InboxReplyContext {
  message_id: number;
  from: string;
  to: string;
  subject: string;
  recipient_source: 'sender' | 'reply-to' | 'compose';
  sending_enabled: boolean;
}

/** Read-only: never marks a message seen or sends mail. Older servers fail closed. */
export async function fetchInboxReplyContext(token: string, area: InboxArea, id: number, signal?: AbortSignal): Promise<InboxReplyContext> {
  const result = id === 0
    ? await fetch(`${environment.apiUrl}/api/account/inbox-replies/compose-context?${new URLSearchParams({ area })}`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }).then(response => { if (!response.ok) throw new Error('Mailbox unavailable.'); return response.json() as Promise<InboxReplyContext>; })
    : await request<InboxReplyContext>(token, `/${positiveId(id)}/reply-context?${new URLSearchParams({ area })}`, signal);
  if (!result || result.message_id !== id || typeof result.from !== 'string' || !result.from
    || typeof result.to !== 'string' || (id !== 0 && !result.to) || typeof result.subject !== 'string'
    || result.subject.length > 255 || !(id === 0 ? ['compose'] : ['sender', 'reply-to']).includes(result.recipient_source) || typeof result.sending_enabled !== 'boolean') {
    throw new Error('Reply preparation is unavailable. No email has been sent.');
  }
  return result;
}
