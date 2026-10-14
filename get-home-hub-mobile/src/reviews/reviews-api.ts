import { environment } from '@/config/environment';
export interface ClientReview { id: number; transaction_id: number; client_name: string; client_email: string; status: string; rating: number | null; comment: string | null; created_at: string; expires_at: string; submitted_at: string | null }
export interface ReviewPage { data: ClientReview[]; next: number | null; email_enabled: boolean }
export interface ReviewDeal { id: number; trade_no: string; property: string | null; clients: { id: number; name: string; email: string | null }[] }
export interface ReviewRequestInput { transaction_id: number; client_id: number; submission_id: string; send_email: boolean; account_id?: number }
async function request<T>(token: string, path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`${environment.apiUrl}/api/client-reviews${path}`, { signal, method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.message === 'string' ? result.message : 'Client reviews unavailable.');
  return result as T;
}
export async function fetchReviews(token: string, before: number | null, signal?: AbortSignal): Promise<ReviewPage> {
  const page = await request<ReviewPage>(token, before ? `?before=${before}` : '', signal);
  if (!Array.isArray(page.data) || page.data.length > 30 || typeof page.email_enabled !== 'boolean' || (page.next !== null && (!Number.isSafeInteger(page.next) || page.next < 1)) || page.data.some(r => !Number.isSafeInteger(r.id) || r.id < 1 || typeof r.client_name !== 'string' || typeof r.client_email !== 'string' || typeof r.status !== 'string' || (r.comment !== null && typeof r.comment !== 'string') || (r.rating !== null && (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5)))) throw new Error('Client review response is invalid.');
  return page;
}
export async function fetchReviewChoices(token: string, search: string, signal?: AbortSignal) {
  const deals = await request<ReviewDeal[]>(token, `/choices?search=${encodeURIComponent(search)}`, signal);
  if (!Array.isArray(deals) || deals.length > 30 || deals.some(deal => !Number.isSafeInteger(deal.id) || deal.id < 1 || typeof deal.trade_no !== 'string' || (deal.property !== null && typeof deal.property !== 'string') || !Array.isArray(deal.clients) || deal.clients.some(client => !Number.isSafeInteger(client.id) || client.id < 1 || typeof client.name !== 'string' || (client.email !== null && typeof client.email !== 'string')))) throw new Error('Review recipients are unavailable.');
  return deals;
}
export function createReviewRequest(token: string, input: ReviewRequestInput, signal?: AbortSignal) {
  if (!Number.isSafeInteger(input.transaction_id) || input.transaction_id < 1 || !Number.isSafeInteger(input.client_id) || input.client_id < 1 || !/^[0-9a-f-]{36}$/i.test(input.submission_id)) throw new Error('Choose a closed transaction and client.');
  return request<{ request: ClientReview; link: string | null }>(token, '/requests', signal, input);
}
export function cancelReviewRequest(token: string, id: number, signal?: AbortSignal) { return request<{ cancelled: boolean }>(token, `/requests/${id}/cancel`, signal, {}); }

export function fetchReviewMailboxes(token: string, signal?: AbortSignal) { return request<{ id: number; name: string }[]>(token, '/mailboxes', signal); }

export async function fetchReviewLink(token: string, id: number, signal?: AbortSignal): Promise<string> {
  const result = await request<{ link: unknown }>(token, `/requests/${id}/link`, signal);
  if (typeof result.link !== 'string') throw new Error('Review link unavailable.');
  const url = new URL(result.link);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/api/client-reviews/respond' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error('Review link unavailable.');
  return result.link;
}
