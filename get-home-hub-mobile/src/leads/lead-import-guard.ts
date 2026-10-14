import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { environment } from '@/config/environment';
import { submitLeadImport, validateImport } from './lead-import-api';

export interface ImportAttempt { version: 1; state: 'pending' | 'confirmed'; jobId: string | null }
const active = new Set<number>();
async function keyFor(userId: number) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('A verified account is required.');
  return `get-home-hub.import.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${environment.apiUrl}|${userId}`)}`;
}
function parse(raw: string | null): ImportAttempt | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value.version === 1 && ((value.state === 'pending' && value.jobId === null)
      || (value.state === 'confirmed' && typeof value.jobId === 'string' && value.jobId.length > 0))) return value;
  } catch { /* Never treat corrupt safety state as permission to submit again. */ }
  throw new Error('Import safety record is unreadable. Ask your administrator to reconcile it before importing.');
}
export async function readImportAttempt(userId: number) { return parse(await SecureStore.getItemAsync(await keyFor(userId))); }
export async function guardedImport(userId: number, token: string, csv: string, tag: string, signal?: AbortSignal) {
  if (active.has(userId)) throw new Error('An import operation is already in progress.');
  active.add(userId);
  try {
    validateImport(csv, tag);
    const key = await keyFor(userId);
    if (parse(await SecureStore.getItemAsync(key))) throw new Error('Review the previous import before submitting another file.');
    if (!token || signal?.aborted) throw new Error('Cancelled before submission.');
    await SecureStore.setItemAsync(key, JSON.stringify({ version: 1, state: 'pending', jobId: null }));
    const job = await submitLeadImport(token, csv, tag, signal);
    await SecureStore.setItemAsync(key, JSON.stringify({ version: 1, state: 'confirmed', jobId: job.job_id }));
    return job;
  } finally { active.delete(userId); }
}
export async function acknowledgeImport(userId: number, jobId: string) {
  if (active.has(userId)) throw new Error('An import operation is already in progress.');
  active.add(userId);
  try {
    const key = await keyFor(userId); const attempt = parse(await SecureStore.getItemAsync(key));
    if (attempt?.state !== 'confirmed' || attempt.jobId !== jobId) throw new Error('This import has not been confirmed.');
    await SecureStore.deleteItemAsync(key);
  } finally { active.delete(userId); }
}
