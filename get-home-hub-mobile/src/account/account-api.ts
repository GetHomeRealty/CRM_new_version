import { environment } from '@/config/environment';

export interface Profile { name: string; username: string; email: string; phone: string; role: string; status: string }
export interface EmailPreferences { signature: string; replyTemplate: string; autoSync: boolean; autoResponder: { enabled: boolean; message: string }; forwardingAddress: string }
export interface Mailbox { id: number; name: string; from_email: string; is_active: boolean; is_default: boolean; inbound_enabled: boolean; last_synced_at: string | null; sync_error: string | null; host: string; port: number; username: string | null; encryption: string | null; imap_host: string | null; imap_port: number | null; imap_encryption: string | null }
export class AccountRequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function accountRequest<T>(token: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!token || signal?.aborted) throw new Error('Sign in again to manage your account.');
  const response = await fetch(`${environment.apiUrl}/api/account/${path}`, { method, signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new Error(method === 'GET' ? 'Could not load account settings.' : 'Result not confirmed. Reload settings before trying again.'); });
  if (!response.ok) throw new AccountRequestError(response.status === 401 ? 'Your session expired. Sign in again.' : response.status === 403 ? 'Access denied.' : 'Account request failed. Check your entries and reload before retrying.', response.status);
  return response.json();
}
export function profileInput(profile: Profile) {
  const name = profile.name.trim(), username = profile.username.trim(), phone = profile.phone.trim();
  if (!name || name.length > 255 || username.length > 255 || phone.length > 64) throw new Error('Enter a name (up to 255 characters) and a valid username/phone length.');
  return { name, username, phone };
}
export function preferencesInput(prefs: EmailPreferences): EmailPreferences {
  if (prefs.signature.length > 5000 || prefs.replyTemplate.length > 5000 || prefs.autoResponder.message.length > 5000) throw new Error('Email text must be 5,000 characters or fewer per field.');
  const forwardingAddress = prefs.forwardingAddress.trim();
  if (forwardingAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardingAddress)) throw new Error('Enter a valid forwarding email address.');
  return { ...prefs, forwardingAddress };
}
export function mailboxInput(mailbox: Mailbox, password: string) {
  if (!mailbox.name.trim() || !mailbox.host.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox.from_email.trim())) throw new Error('Mailbox name, SMTP host and a valid sender email are required.');
  for (const port of [mailbox.port, ...(mailbox.imap_port === null ? [] : [mailbox.imap_port])]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ports must be between 1 and 65535.');
  if (!['tls', 'ssl'].includes(mailbox.encryption ?? '') || (mailbox.inbound_enabled && (!mailbox.imap_host?.trim() || !mailbox.imap_port || !['tls', 'ssl'].includes(mailbox.imap_encryption ?? '')))) throw new Error('Choose TLS or SSL and supply complete incoming settings when sync is enabled.');
  if (password.length > 1000) throw new Error('Password is too long.');
  return { name: mailbox.name.trim(), from_email: mailbox.from_email.trim(), host: mailbox.host.trim(), port: mailbox.port, username: mailbox.username?.trim() ?? '', encryption: mailbox.encryption, imap_host: mailbox.imap_host?.trim() ?? '', imap_port: mailbox.imap_port, imap_encryption: mailbox.imap_encryption, is_active: mailbox.is_active, inbound_enabled: mailbox.inbound_enabled, ...(password ? { password } : {}) };
}
