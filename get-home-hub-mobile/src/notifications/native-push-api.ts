import { environment } from '@/config/environment';
export async function nativePushRequest(token: string, method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal, body?: { token: string; platform: 'ios' | 'android' }): Promise<{ enabled: boolean; registered: boolean }> {
  if (!token || signal.aborted) throw new Error('A current mobile session is required.');
  const response = await fetch(`${environment.apiUrl}/api/mobile/push`, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Device notification settings could not be confirmed.');
  const result = await response.json();
  if (typeof result?.registered !== 'boolean' || (method === 'GET' && typeof result.enabled !== 'boolean')) throw new Error('Invalid device notification response.');
  return { enabled: result.enabled === true, registered: result.registered };
}
/** Push data may open only this account's authenticated notification feed, never arbitrary URLs or records. */
export function isCurrentPush(value: unknown, userId: number): boolean {
  const data = value as { kind?: unknown; userId?: unknown } | null;
  return data?.kind === 'hub-update' && data.userId === userId;
}
