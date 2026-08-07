import api from './axios';

/**
 * The Notification Centre.
 *
 * These sit alongside the four existing bell feeds (`/api/doc-notifications` and friends) rather
 * than replacing them — the bells in `DeskLayout` still call those, so nothing that worked before
 * changes. This is the merged view over the same data.
 */

export type NotificationSource = 'agent-change' | 'doc-review' | 'review-decision' | 'reminder';
export type NotificationFilter = 'all' | 'unread' | 'read';

export interface NotificationItem {
  /** `source:transaction_id` — stable, and what "mark read" is addressed to. */
  key: string;
  source: NotificationSource;
  transaction_id: number;
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

export async function markNotificationRead(source: NotificationSource, transactionId: number): Promise<void> {
  await api.post('/api/notifications/read', { source, transaction_id: transactionId });
}

export async function markAllNotificationsRead(): Promise<{ marked: number; failed: number }> {
  const { data } = await api.post<{ marked: number; failed: number }>('/api/notifications/read-all');
  return data;
}
