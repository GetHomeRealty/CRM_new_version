import { environment } from '@/config/environment';

export type NotificationSource = 'agent-change' | 'doc-review' | 'review-decision' | 'reminder' | 'direct';
export type NotificationFilter = 'all' | 'unread' | 'read';
export interface NotificationItem {
  key: string; source: NotificationSource; transaction_id: number; notification_id?: number;
  trade_no: string | null; property: string | null; title: string; summary: string | null;
  unread: boolean; at: string | null; link: string;
}
export interface NotificationFeed {
  items: NotificationItem[]; total: number; unread: number; limit: number; offset: number;
}
const sources: NotificationSource[] = ['agent-change', 'doc-review', 'review-decision', 'reminder', 'direct'];

async function request<T>(token: string, path: string, signal?: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(`${environment.apiUrl}/api/notifications${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again to access notifications.' : 'Could not update notifications. Please retry.');
  return response.json() as Promise<T>;
}

export function fetchNotifications(token: string, options: {
  filter?: NotificationFilter; source?: NotificationSource; search?: string; offset?: number; signal?: AbortSignal;
} = {}): Promise<NotificationFeed> {
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid notification page.');
  if (options.filter && !['all', 'unread', 'read'].includes(options.filter)) throw new Error('Invalid notification filter.');
  if (options.source && !sources.includes(options.source)) throw new Error('Invalid notification source.');
  const query = new URLSearchParams({ filter: options.filter ?? 'all', limit: '30', offset: String(offset) });
  if (options.source) query.set('source', options.source);
  if (options.search?.trim()) query.set('search', options.search.trim());
  return request(token, `?${query}`, options.signal);
}

export async function markNotificationRead(token: string, item: Pick<NotificationItem, 'source' | 'transaction_id' | 'notification_id'>): Promise<void> {
  const id = item.source === 'direct' ? item.notification_id : item.transaction_id;
  if (!sources.includes(item.source) || !Number.isSafeInteger(id) || !id || id < 1) throw new Error('Invalid notification identifier.');
  const result = await request<{ ok?: boolean }>(token, '/read', undefined, { source: item.source, transaction_id: id });
  if (result.ok !== true) throw new Error('That notification could not be marked read.');
}

/** Caller must confirm this action; it affects all unread records, not only the visible page. */
export async function markAllNotificationsRead(token: string): Promise<{ marked: number; failed: number }> {
  const result = await request<{ marked: number; failed: number }>(token, '/read-all', undefined, {});
  if (!Number.isSafeInteger(result.marked) || result.marked < 0 || !Number.isSafeInteger(result.failed) || result.failed < 0) {
    throw new Error('Could not verify the notification update. Refresh before retrying.');
  }
  return result;
}
