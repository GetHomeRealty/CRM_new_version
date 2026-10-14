import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { environment } from '@/config/environment';
import { campaignPayload, submitCampaign, recoverCampaignSubmission, type CampaignDraft } from './campaign-write-api';
import { fetchCampaign } from './campaigns-api';

export interface CampaignAttempt {
  version: 1;
  startedAt: string;
  templateId: number;
  state: 'pending' | 'confirmed';
  campaignId?: number;
  requestKey?: string;
}
const active = new Set<number>();
async function keyFor(userId: number) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('A verified account is required.');
  const scope = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${environment.apiUrl}|${userId}`);
  return `get-home-hub.campaign-attempt.${scope}`;
}
function parseAttempt(raw: string | null): CampaignAttempt | null {
  if (raw === null) return null;
  let value: CampaignAttempt;
  try { value = JSON.parse(raw); } catch { throw new Error('Campaign safety record is unreadable. Do not resend; check campaign history.'); }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.templateId) || value.templateId < 1 || !Number.isFinite(Date.parse(value.startedAt)) || !['pending', 'confirmed'].includes(value.state)
    || (value.state === 'confirmed' && (!Number.isSafeInteger(value.campaignId) || Number(value.campaignId) < 1))) throw new Error('Campaign safety record is invalid. Do not resend; check campaign history.');
  return value;
}
export async function readCampaignAttempt(userId: number): Promise<CampaignAttempt | null> {
  return parseAttempt(await SecureStore.getItemAsync(await keyFor(userId)));
}

/** Reconcile only an exact server-confirmed id; never infer success from names or timestamps. */
export async function verifyConfirmedCampaign(userId: number, token: string, signal?: AbortSignal) {
  const attempt = await readCampaignAttempt(userId);
  if (!attempt || attempt.state !== 'confirmed' || !attempt.campaignId) throw new Error('Outcome is unresolved. Check campaign history with your administrator; do not resend.');
  const campaign = await fetchCampaign(token, attempt.campaignId, signal);
  if (signal?.aborted) throw new Error('Verification cancelled.');
  return campaign;
}

/** Read-only recovery, scoped by the authenticated account and its original durable UUID. */
export async function recoverPendingCampaign(userId: number, token: string, signal?: AbortSignal) {
  if (active.has(userId)) throw new Error('Wait for the current submission.');
  active.add(userId);
  try {
    const key = await keyFor(userId); const attempt = parseAttempt(await SecureStore.getItemAsync(key));
    if (!attempt || attempt.state !== 'pending' || !attempt.requestKey) throw new Error('This older attempt needs administrator reconciliation. Do not resend.');
    const result = await recoverCampaignSubmission(token, attempt.requestKey, signal);
    if (signal?.aborted) throw new Error('Recovery cancelled.');
    await SecureStore.setItemAsync(key, JSON.stringify({ ...attempt, state: 'confirmed', campaignId: result.id }));
    return result;
  } finally { active.delete(userId); }
}

/** Device-local guard, NOT server idempotency. Pending records survive failures and restarts. */
export async function guardedSubmitCampaign(userId: number, token: string, draft: CampaignDraft, signal?: AbortSignal) {
  if (active.has(userId)) throw new Error('A campaign submission is already in progress.');
  active.add(userId);
  try {
    if (!token || signal?.aborted) throw new Error('Sign in and review the campaign before submitting.');
    campaignPayload(draft);
    const key = await keyFor(userId);
    if (parseAttempt(await SecureStore.getItemAsync(key))) throw new Error('Review the previous campaign attempt in history before starting another.');
    if (signal?.aborted) throw new Error('Cancelled before submission.');
    const attempt: CampaignAttempt = { version: 1, startedAt: new Date().toISOString(), templateId: draft.templateId, state: 'pending', requestKey: Crypto.randomUUID() };
    // Fail closed: no request may be issued if this durable write fails.
    await SecureStore.setItemAsync(key, JSON.stringify(attempt));
    const result = await submitCampaign(token, draft, signal, attempt.requestKey);
    await SecureStore.setItemAsync(key, JSON.stringify({ ...attempt, state: 'confirmed', campaignId: result.id }));
    return result;
  } finally { active.delete(userId); }
}

/** Only a known successful attempt can be cleared. Unknown outcomes need separate reconciliation. */
export async function acknowledgeConfirmedCampaign(userId: number, campaignId: number) {
  if (active.has(userId)) throw new Error('Wait for the current submission.');
  active.add(userId);
  try {
    const key = await keyFor(userId); const attempt = parseAttempt(await SecureStore.getItemAsync(key));
    if (!attempt || attempt.state !== 'confirmed' || attempt.campaignId !== campaignId) throw new Error('This campaign outcome has not been confirmed.');
    await SecureStore.deleteItemAsync(key);
  } finally { active.delete(userId); }
}
