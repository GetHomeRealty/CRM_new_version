import { environment } from '@/config/environment';
import type { InboxArea } from './inbox-api';
export interface ProviderSentRow { uid: number; subject: string; from: string; to: string; sent_at: string | null }
export interface ProviderSentReference { cursor?: number; account?: number; validity?: string }
export interface ProviderSentPage { available: boolean; data: ProviderSentRow[]; next_cursor: number | null; account_id: number | null; validity: string | null }
export interface ProviderSentDetail extends ProviderSentRow { body_text: string | null; body_html: string | null; content_available: boolean; truncated: boolean; attachments: { filename: string; size: number; content_type: string }[] }
function uid(value: number) { if (!Number.isInteger(value) || value < 1 || value > 4294967295) throw new Error('Invalid Sent reference.'); return String(value); }
function row(value: ProviderSentRow) {
  if (!value || !Number.isInteger(value.uid) || value.uid < 1 || value.uid > 4294967295 || typeof value.subject !== 'string' || value.subject.length > 255 || typeof value.from !== 'string' || value.from.length > 1024 || typeof value.to !== 'string' || value.to.length > 2048 || (value.sent_at !== null && (typeof value.sent_at !== 'string' || !Number.isFinite(Date.parse(value.sent_at))))) throw new Error('Sent message response is invalid.');
}
async function read(token: string, area: InboxArea, path: string, reference: ProviderSentReference, signal: AbortSignal) {
  if (!token || signal.aborted || !['crm','desk'].includes(area)) throw new Error('Sign in to view Sent mail.');
  const query = new URLSearchParams({ area });
  if (reference.account !== undefined) query.set('account', uid(reference.account));
  if (reference.cursor !== undefined) query.set('cursor', uid(reference.cursor));
  if (reference.validity !== undefined) { if (!/^[1-9]\d{0,9}$/.test(reference.validity) || Number(reference.validity) > 4294967295) throw new Error('Invalid Sent reference.'); query.set('validity', reference.validity); }
  const response = await fetch(`${environment.apiUrl}/api/account/provider-sent${path}?${query}`, { method: 'GET', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view Sent mail.' : response.status === 404 ? 'This Sent mailbox or message changed. Refresh the list.' : 'Sent mail could not be loaded. Refresh or review your mailbox connection.');
  return response.json();
}
export async function fetchProviderSent(token: string, area: InboxArea, reference: ProviderSentReference, signal: AbortSignal): Promise<ProviderSentPage> {
  const value = await read(token, area, '', reference, signal) as ProviderSentPage;
  if (!value || typeof value.available !== 'boolean' || !Array.isArray(value.data) || value.data.length > 30) throw new Error('Sent mailbox response is invalid.');
  value.data.forEach(row);
  if (value.available) { if (value.account_id === null || value.validity === null) throw new Error('Sent mailbox response is invalid.'); uid(value.account_id); if (typeof value.validity !== 'string' || !/^[1-9]\d{0,9}$/.test(value.validity)) throw new Error('Sent mailbox response is invalid.'); uid(Number(value.validity));
    if (new Set(value.data.map(v => v.uid)).size !== value.data.length || value.data.some((v, i) => i > 0 && v.uid >= value.data[i - 1].uid) || (reference.cursor !== undefined && value.data.some(v => v.uid >= reference.cursor!)) || (value.next_cursor !== null && value.next_cursor !== value.data.at(-1)?.uid) || (reference.account !== undefined && value.account_id !== reference.account) || (reference.validity !== undefined && value.validity !== reference.validity)) throw new Error('Sent mailbox response is invalid.'); if (value.next_cursor !== null) uid(value.next_cursor); }
  else if (value.data.length || value.next_cursor !== null) throw new Error('Unavailable mailbox returned message data.');
  return value;
}
export async function fetchProviderSentDetail(token: string, area: InboxArea, id: number, reference: ProviderSentReference, signal: AbortSignal): Promise<ProviderSentDetail> {
  if (!reference.account || !reference.validity) throw new Error('Open this message from the Sent list.');
  const value = await read(token, area, '/' + uid(id), reference, signal) as ProviderSentDetail;
  row(value);
  if (value.uid !== id || typeof value.content_available !== 'boolean' || typeof value.truncated !== 'boolean' || ![value.body_text,value.body_html].every(v => v === null || (typeof v === 'string' && v.length <= 200000)) || !Array.isArray(value.attachments) || value.attachments.length > 20 || value.attachments.some(a => !a || typeof a.filename !== 'string' || a.filename.length > 255 || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.content_type !== 'string' || a.content_type.length > 128)) throw new Error('Sent content response is invalid.');
  return value;
}
