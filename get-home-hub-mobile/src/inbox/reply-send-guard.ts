import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { environment } from '@/config/environment';
import type { InboxArea } from './inbox-api';
import type { ReplyAttachment } from './reply-attachments';
import { recoverInboxReply, submitInboxReply, type ReplyReceipt } from './reply-send-api';

export interface ReplyAttempt {
  version: 1;
  key: string;
  messageId: number;
  area: InboxArea;
  status: ReplyReceipt['status'];
}
const active = new Set<number>();
async function storageKey(userId: number) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('A verified account is required.');
  const scope = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${environment.apiUrl}|${userId}`);
  return `get-home-hub.reply-attempt.${scope}`;
}
function parse(raw: string | null): ReplyAttempt | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.key)
      && Number.isSafeInteger(value.messageId) && value.messageId >= 0 && ['crm', 'desk'].includes(value.area)
      && ['pending', 'accepted', 'uncertain'].includes(value.status)) return value;
  } catch { /* Corruption cannot be treated as an empty record. */ }
  throw new Error('Reply safety record is unreadable. Do not send again; ask your administrator to reconcile it.');
}
export async function readReplyAttempt(userId: number) {
  return parse(await SecureStore.getItemAsync(await storageKey(userId)));
}
async function exclusive<T>(userId: number, action: () => Promise<T>): Promise<T> {
  if (active.has(userId)) throw new Error('A reply operation is already in progress.');
  active.add(userId);
  try { return await action(); } finally { active.delete(userId); }
}

/** Explicit user confirmation is required before calling. Stores no body or attachment bytes. */
export async function guardedSubmitReply(userId: number, token: string, area: InboxArea, messageId: number, body: string, attachments: readonly ReplyAttachment[], signal?: AbortSignal, compose?: { to: string; subject: string }) {
  return exclusive(userId, async () => {
    if (!token || signal?.aborted || !Number.isSafeInteger(messageId) || messageId < 0 || !['crm', 'desk'].includes(area)
      || !body.trim() || body.length > 20000 || body.includes('\0') || attachments.length > 5
      || attachments.some(file => !Number.isSafeInteger(file.size) || file.size <= 0)
      || attachments.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024) throw new Error('Review your reply before submitting.');
    const key = await storageKey(userId);
    if (messageId === 0 && (!compose || compose.to.length > 254 || !/^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(compose.to.trim()) || !compose.subject.trim() || compose.subject.length > 255 || /[\x00-\x1f\x7f]/.test(compose.to + compose.subject))) throw new Error('Enter one valid recipient and a subject without line breaks.');
    if (parse(await SecureStore.getItemAsync(key))) throw new Error('Recover the previous reply status before starting another.');
    if (signal?.aborted) throw new Error('Cancelled before submission.');
    const attempt: ReplyAttempt = { version: 1, key: Crypto.randomUUID(), area, messageId, status: 'pending' };
    await SecureStore.setItemAsync(key, JSON.stringify(attempt));
    // Do not clear pending on ANY failure; even client cancellation can race remote acceptance.
    const result = await submitInboxReply(token, area, messageId, attempt.key, body, attachments, signal, compose);
    await SecureStore.setItemAsync(key, JSON.stringify({ ...attempt, status: result.status }));
    return result;
  });
}
export async function recoverReplyAttempt(userId: number, token: string, signal?: AbortSignal) {
  return exclusive(userId, async () => {
    const key = await storageKey(userId);
    const attempt = parse(await SecureStore.getItemAsync(key));
    if (!attempt) throw new Error('No saved reply submission is available.');
    const result = await recoverInboxReply(token, attempt.area, attempt.messageId, attempt.key, signal);
    if (signal?.aborted) throw new Error('Recovery cancelled.');
    await SecureStore.setItemAsync(key, JSON.stringify({ ...attempt, status: result.status }));
    return result;
  });
}
/** Pending/uncertain states are deliberately not clearable through this API. */
export async function acknowledgeAcceptedReply(userId: number, requestKey: string) {
  return exclusive(userId, async () => {
    const key = await storageKey(userId);
    const attempt = parse(await SecureStore.getItemAsync(key));
    if (!attempt || attempt.key !== requestKey || attempt.status !== 'accepted') throw new Error('This reply has not been confirmed as accepted.');
    await SecureStore.deleteItemAsync(key);
  });
}
