import { environment } from '@/config/environment';
import type { InboxArea } from './inbox-api';
import type { ReplyAttachment } from './reply-attachments';

export interface ReplyReceipt { request_key: string; message_id: number; status: 'pending' | 'accepted' | 'uncertain' }
export class UnconfirmedReplyError extends Error {}
const unknownOutcome = () => new UnconfirmedReplyError('Reply status is unknown. Recover its status; do not send again.');
function validateIdentity(token: string, area: InboxArea, messageId: number, key: string, signal?: AbortSignal) {
  if (!token || !['crm', 'desk'].includes(area) || !Number.isSafeInteger(messageId) || messageId < 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) || signal?.aborted) {
    throw new Error('A valid message, saved submission key and sign-in are required.');
  }
}
function receipt(value: unknown, messageId: number, key: string): ReplyReceipt {
  const row = value as Partial<ReplyReceipt> | null;
  if (!row || row.request_key !== key || row.message_id !== messageId || !['pending', 'accepted', 'uncertain'].includes(row.status ?? '')) throw unknownOutcome();
  return { request_key: key, message_id: messageId, status: row.status as ReplyReceipt['status'] };
}

/** Caller must persist the key BEFORE invoking this and obtain explicit send confirmation.
 * No automatic retries or fallback to older, non-idempotent endpoints.
 */
export async function submitInboxReply(token: string, area: InboxArea, messageId: number, key: string, bodyText: string, attachments: readonly ReplyAttachment[], signal?: AbortSignal, compose?: { to: string; subject: string }): Promise<ReplyReceipt> {
  validateIdentity(token, area, messageId, key, signal);
  if (!bodyText.trim() || bodyText.length > 20000 || bodyText.includes('\0')) throw new Error('Enter a message of 1–20,000 characters.');
  if (attachments.length > 5 || attachments.some(file => !Number.isSafeInteger(file.size) || file.size <= 0)
    || attachments.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) throw new Error('Choose up to five files, no more than 5 MB combined.');
  if (messageId === 0 && (!compose?.to.trim() || !compose.subject.trim())) throw new Error('Enter a recipient and subject.');
  const body = { request_key: key, body_text: bodyText, ...(messageId === 0 ? compose : {}), attachments: attachments.map(file => ({ filename: file.filename, content_type: file.content_type, data: file.data })) };
  try {
    const response = await fetch(`${environment.apiUrl}/api/account/inbox-replies/${messageId}?${new URLSearchParams({ area })}`, {
      method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw unknownOutcome();
    return receipt(await response.json(), messageId, key);
  } catch { throw unknownOutcome(); }
}

/** Always GET. A missing receipt does not establish that an in-flight send was cancelled. */
export async function recoverInboxReply(token: string, area: InboxArea, messageId: number, key: string, signal?: AbortSignal): Promise<ReplyReceipt> {
  validateIdentity(token, area, messageId, key, signal);
  try {
    const response = await fetch(`${environment.apiUrl}/api/account/inbox-replies/submissions/${key}?${new URLSearchParams({ area })}`, {
      method: 'GET', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) throw unknownOutcome();
    return receipt(await response.json(), messageId, key);
  } catch { throw unknownOutcome(); }
}
