import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { environment } from '@/config/environment';
import { accountRequest, AccountRequestError, mailboxInput, type Mailbox } from './account-api';

export interface MailboxLimit { max: number | null; used: number; canAdd: boolean }
export const emptyMailbox: Mailbox = { id: 0, name: '', from_email: '', host: '', port: 587, username: '', encryption: 'tls', imap_host: '', imap_port: 993, imap_encryption: 'ssl', inbound_enabled: false, is_active: true, is_default: false, last_synced_at: null, sync_error: null };
const active = new Set<number>();
const hash = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
async function key(userId: number) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('A verified account is required.');
  return `get-home-hub.mailbox.${await hash(`${environment.apiUrl}|${userId}`)}`;
}
export async function mailboxConnections(token: string, signal?: AbortSignal) {
  const [accounts, limit] = await Promise.all([
    accountRequest<Mailbox[]>(token, 'mail-accounts', 'GET', undefined, signal),
    accountRequest<MailboxLimit>(token, 'mail-accounts/limit?scope=crm', 'GET', undefined, signal),
  ]);
  if (!Array.isArray(accounts) || !accounts.every(a => a && Number.isSafeInteger(a.id) && a.id > 0 && typeof a.from_email === 'string')
    || !limit || typeof limit.canAdd !== 'boolean' || !Number.isSafeInteger(limit.used) || limit.used < 0
    || (limit.max !== null && (!Number.isSafeInteger(limit.max) || limit.max < 0 || limit.canAdd !== (limit.used < limit.max)))) throw new Error('Mailbox availability could not be verified.');
  return { accounts, limit };
}
export async function pendingMailbox(userId: number, accounts: Mailbox[]) {
  const storageKey = await key(userId), pending = await SecureStore.getItemAsync(storageKey);
  if (pending === null) return false;
  if (!/^[a-f0-9]{64}$/.test(pending)) throw new Error('Mailbox safety record needs administrator review.');
  for (const account of accounts) if (await hash(account.from_email.trim().toLowerCase()) === pending) {
    await SecureStore.deleteItemAsync(storageKey); return false;
  }
  return true;
}
export async function connectMailbox(userId: number, token: string, draft: Mailbox, password: string, signal?: AbortSignal) {
  if (active.has(userId)) throw new Error('A mailbox connection is already in progress.');
  active.add(userId);
  try {
    const body = mailboxInput(draft, password);
    if (!password.trim() || !body.username) throw new Error('Enter the mailbox username and provider app password.');
    const { accounts, limit } = await mailboxConnections(token, signal);
    if (await pendingMailbox(userId, accounts)) throw new Error('Previous connection is unconfirmed. Refresh or ask an administrator to reconcile it before adding another mailbox.');
    if (!limit.canAdd) throw new Error('Your Hub mailbox limit has been reached.');
    if (accounts.some(a => a.from_email.trim().toLowerCase() === body.from_email.toLowerCase())) throw new Error('This mailbox is already connected. Edit the existing connection instead.');
    const storageKey = await key(userId);
    if (signal?.aborted) throw new Error('Connection cancelled before submission.');
    await SecureStore.setItemAsync(storageKey, await hash(body.from_email.toLowerCase()));
    try {
      const saved = await accountRequest<Mailbox>(token, 'mail-accounts', 'POST', { ...body, scope: 'crm' }, signal);
      if (!saved || !Number.isSafeInteger(saved.id) || saved.id < 1 || saved.from_email?.toLowerCase() !== body.from_email.toLowerCase()) throw new Error('Connection result not confirmed. Refresh before trying again.');
      await SecureStore.deleteItemAsync(storageKey);
      return saved;
    } catch (error) {
      if (error instanceof AccountRequestError && [400, 401, 403, 404, 422, 429].includes(error.status)) await SecureStore.deleteItemAsync(storageKey);
      throw error;
    }
  } finally { active.delete(userId); }
}
export function trustedGoogleUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Google authorization URL is missing.');
  const url = new URL(value);
  if (url.origin !== 'https://accounts.google.com' || !['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(url.pathname) || url.username || url.password || !url.searchParams.get('state') || url.searchParams.get('response_type') !== 'code') throw new Error('Untrusted Google authorization URL.');
  const callback = new URL(url.searchParams.get('redirect_uri') || '');
  if (callback.origin !== new URL(environment.apiUrl).origin || callback.pathname !== '/api/google/callback') throw new Error('Google callback does not match this Hub server.');
  return url.toString();
}
export async function gmailConnectUrl(token: string, signal?: AbortSignal) {
  if (!token || signal?.aborted) throw new Error('Sign in before connecting Gmail.');
  const response = await fetch(`${environment.apiUrl}/api/google/mail/connect?scope=crm`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not start Gmail connection. Sign in and try again.');
  const body = await response.json();
  if (body?.configured !== true) throw new Error('Gmail connection is not configured on this Hub server. Ask your administrator.');
  return trustedGoogleUrl(body.url);
}
