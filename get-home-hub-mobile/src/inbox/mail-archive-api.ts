import { environment } from '@/config/environment';
import type { InboxArea } from './inbox-api';
export interface ArchiveAttachments { available: boolean; total: number; files: { id: number; name: string; size: number; available: boolean; reason: string | null }[] }
export interface SentMessage { id: string; to_email: string | null; subject: string | null; sent_at: string; content_available: boolean }
export interface SentDetail extends SentMessage { body_text: string | null; attachments: ArchiveAttachments }
const nullableText = (value: unknown) => value === null || typeof value === 'string';
function validMessage(value: SentMessage) {
  return value && typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id)
    && nullableText(value.to_email) && nullableText(value.subject)
    && typeof value.sent_at === 'string' && Number.isFinite(Date.parse(value.sent_at))
    && typeof value.content_available === 'boolean';
}
export function validAttachments(value: ArchiveAttachments): boolean {
  return Boolean(value && typeof value.available === 'boolean' && Number.isSafeInteger(value.total) && value.total >= 0
    && Array.isArray(value.files) && value.files.length <= 20 && value.total >= value.files.length
    && value.files.every((file, index) => file && file.id === index && typeof file.name === 'string'
      && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.available === 'boolean' && nullableText(file.reason)));
}
export async function archiveRequest<T>(token: string, area: InboxArea, path: string, signal?: AbortSignal): Promise<T> {
  if (!token || !['crm', 'desk'].includes(area) || signal?.aborted) throw new Error('Sign in to access this mailbox.');
  const response = await fetch(`${environment.apiUrl}/api/account/mail-archive/${path}${path.includes('?') ? '&' : '?'}area=${area}`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 503 || response.status === 404 ? 'Mail archive or attachment is unavailable on this server.' : 'Could not load this mail item. Check your access and retry.');
  return response.json();
}
export async function sentPage(token: string, area: InboxArea, page: number, signal?: AbortSignal) {
  if (!Number.isInteger(page) || page < 1 || page > 20000) throw new Error('Invalid page.');
  const value = await archiveRequest<{ data: SentMessage[]; page: number; has_more: boolean }>(token, area, `sent?page=${page}`, signal);
  if (!Array.isArray(value?.data) || value.data.length > 20 || value.page !== page || typeof value.has_more !== 'boolean' || !value.data.every(validMessage)) throw new Error('Invalid sent-mail response.');
  return value;
}
export async function sentDetail(token: string, area: InboxArea, key: string, signal?: AbortSignal) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('Invalid sent message.');
  const value = await archiveRequest<SentDetail>(token, area, `sent/${key}`, signal);
  if (!validMessage(value) || value.id !== key || !nullableText(value.body_text) || !validAttachments(value.attachments)) throw new Error('Invalid sent message response.');
  return value;
}
export function attachmentPath(kind: 'sent' | 'inbound', id: string | number, index: number) {
  if (!['sent', 'inbound'].includes(kind) || !Number.isInteger(index) || index < 0 || index >= 20 || (kind === 'sent' ? typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) : !Number.isSafeInteger(id) || Number(id) < 1)) throw new Error('Invalid attachment.');
  return `${kind}/${id}/attachments/${index}`;
}
