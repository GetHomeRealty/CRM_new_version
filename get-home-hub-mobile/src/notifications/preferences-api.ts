import { environment } from '@/config/environment';

export type NotificationChannel = 'in_app' | 'email' | 'push';
export interface NotificationCategory {
  key: string; label: string; description: string;
  channels: Record<NotificationChannel, 'live' | 'pending' | 'unsupported'>;
  enabled: Record<NotificationChannel, boolean>;
  areas?: ('crm' | 'desk')[];
}
export interface NotificationPreferences { channels: NotificationChannel[]; categories: NotificationCategory[] }
export type PreferenceChanges = Record<string, Partial<Record<NotificationChannel, boolean>>>;

/** Only changed live pairs are sent, preserving other settings and hidden areas. */
export function preferenceChanges(current: NotificationPreferences, draft: PreferenceChanges): PreferenceChanges {
  const result: PreferenceChanges = {};
  for (const [key, choices] of Object.entries(draft)) {
    const category = current.categories.find((item) => item.key === key);
    if (!category) throw new Error('This notification category is no longer available. Refresh settings.');
    for (const [name, enabled] of Object.entries(choices)) {
      const channel = name as NotificationChannel;
      if (!current.channels.includes(channel) || category.channels[channel] !== 'live' || typeof enabled !== 'boolean') {
        throw new Error('This notification channel cannot be changed.');
      }
      if (enabled !== category.enabled[channel]) (result[key] ??= {})[channel] = enabled;
    }
  }
  return result;
}

async function request(token: string, signal?: AbortSignal, changes?: PreferenceChanges): Promise<NotificationPreferences> {
  const response = await fetch(`${environment.apiUrl}/api/account/notification-preferences`, {
    method: changes === undefined ? 'GET' : 'PUT', signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(changes === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(changes === undefined ? {} : { body: JSON.stringify(changes) }),
  });
  if (!response.ok) throw new Error('Could not load or save notification preferences. Please retry.');
  return response.json() as Promise<NotificationPreferences>;
}
export function fetchNotificationPreferences(token: string, signal?: AbortSignal) { return request(token, signal); }
export function saveNotificationPreferences(token: string, current: NotificationPreferences, draft: PreferenceChanges) {
  return request(token, undefined, preferenceChanges(current, draft));
}
