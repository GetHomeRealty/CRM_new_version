import { environment } from '@/config/environment';

export interface TransactionMessage { id: number; author: string | null; body: string; at: string | null; mine: boolean; mentions: number[] }
export interface MentionCandidate { id: number; name: string }
function transactionPath(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid transaction identifier.');
  return `${environment.apiUrl}/api/transactions/${id}`;
}
async function request<T>(token: string, url: string, signal?: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(url, { signal, method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'You do not have access to this conversation.' : 'Could not load or send the message. Please retry.');
  return response.json() as Promise<T>;
}
/** The server marks the conversation read. Fetch only when the conversation is opened. */
export function fetchTransactionMessages(token: string, id: number, signal?: AbortSignal): Promise<TransactionMessage[]> {
  return request(token, `${transactionPath(id)}/messages`, signal);
}
export function fetchMentionCandidates(token: string, id: number, search: string, signal?: AbortSignal): Promise<MentionCandidate[]> {
  return request(token, `${transactionPath(id)}/mention-candidates?${new URLSearchParams({ q: search.trim() })}`, signal);
}
export function sendTransactionMessage(token: string, id: number, text: string, mentions: number[] = []): Promise<TransactionMessage[]> {
  const body = text.trim();
  if (!body || body.length > 5000) throw new Error('Enter a message of 1–5,000 characters.');
  if (mentions.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid mention recipient.');
  const unique = [...new Set(mentions)];
  if (unique.length > 20) throw new Error('A message may mention at most 20 people.');
  return request(token, `${transactionPath(id)}/messages`, undefined, { body, mentions: unique });
}
