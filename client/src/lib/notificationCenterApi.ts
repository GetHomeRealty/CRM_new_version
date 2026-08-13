import api from './axios';

/**
 * The Notification Centre.
 *
 * These sit alongside the four existing bell feeds (`/api/doc-notifications` and friends) rather
 * than replacing them — the bells in `DeskLayout` still call those, so nothing that worked before
 * changes. This is the merged view over the same data.
 */

export type NotificationSource = 'agent-change' | 'doc-review' | 'review-decision' | 'reminder' | 'direct';
export type NotificationFilter = 'all' | 'unread' | 'read';

export interface NotificationItem {
  /** `source:transaction_id` — stable, and what "mark read" is addressed to. */
  key: string;
  source: NotificationSource;
  transaction_id: number;
  /**
   * Present on `direct` rows only, and the ONLY way to clear one.
   *
   * A direct notification need not be about a deal at all — "you have a new email" is not — so the
   * feed sends `transaction_id: 0` and the row's own id here. The server addresses it by that id.
   * It was missing from this interface, so the page had nothing to send and cleared nothing.
   */
  notification_id?: number;
  trade_no: string | null;
  property: string | null;
  title: string;
  summary: string | null;
  unread: boolean;
  at: string | null;
  /** Where "open the related record" goes. */
  link: string;
}

export interface NotificationFeed {
  items: NotificationItem[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

export interface UnreadCount {
  unread: number;
  by_source: Record<NotificationSource, number>;
}

export const SOURCE_LABEL: Record<NotificationSource, string> = {
  'agent-change': 'Agent changes',
  'doc-review': 'Document reviews',
  'review-decision': 'Review decisions',
  reminder: 'Reminders',
  direct: 'Alerts',
};

export async function getNotifications(params: {
  filter?: NotificationFilter;
  source?: NotificationSource;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<NotificationFeed> {
  const { data } = await api.get<NotificationFeed>('/api/notifications', { params });
  return data;
}

/** Just the badge number — cheap enough to poll. */
export async function getUnreadCount(): Promise<UnreadCount> {
  const { data } = await api.get<UnreadCount>('/api/notifications/count');
  return data;
}

/**
 * Clear one line.
 *
 * TAKES THE ITEM, not a source and a number, because which number to send depends on the source and
 * that is exactly what went wrong. A `direct` row is addressed by its OWN id and carries
 * `transaction_id: 0`; every other source is addressed by its transaction. The caller was sending
 * `transaction_id` for all of them, so `direct` rows were addressed as transaction 0, matched
 * nothing, and stayed unread. The server's own `markAllRead` has always made this distinction —
 * which is why "Mark all as read" cleared them and the per-row button did not. Keeping the rule in
 * one place is the point of passing the whole item.
 *
 * The endpoint answers `{ ok: false }` with HTTP 200 when nothing matched, so a failure is NOT an
 * axios error and was being swallowed silently. Turned into a throw here so the page can say so.
 */
export async function markNotificationRead(
  item: Pick<NotificationItem, 'source' | 'transaction_id' | 'notification_id'>,
): Promise<void> {
  const handle = item.source === 'direct' ? (item.notification_id ?? 0) : item.transaction_id;
  const { data } = await api.post<{ ok?: boolean }>(
    '/api/notifications/read',
    { source: item.source, transaction_id: handle },
  );
  if (data?.ok === false) throw new Error('That notification could not be cleared.');
}

export async function markAllNotificationsRead(): Promise<{ marked: number; failed: number }> {
  const { data } = await api.post<{ marked: number; failed: number }>('/api/notifications/read-all');
  return data;
}
