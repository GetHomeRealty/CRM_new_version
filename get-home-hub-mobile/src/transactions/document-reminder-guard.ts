import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canDocumentReminders, RejectedReminderSendError, submitReminder, recoverReminder, reminderUuid, type ReminderReceipt } from './document-reminder-api';
export interface ReminderAttempt { request_id: string; version: string }
const active = new Set<string>();
async function key(userId: number, txn: number) { if (![userId,txn].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Verified account and transaction required.'); return 'get-home-hub.desk-reminder.' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${environment.apiUrl}|${userId}|${txn}`); }
export async function readReminderAttempt(userId: number, txn: number): Promise<ReminderAttempt | null> {
 const raw = await SecureStore.getItemAsync(await key(userId, txn)); if (raw === null) return null;
 let value: ReminderAttempt; try { value = JSON.parse(raw); } catch { throw new Error('Saved send state is unreadable. Administrator reconciliation is required before resending.'); }
 if (!value || !reminderUuid(value.request_id) || !/^[a-f0-9]{64}$/.test(value.version)) throw new Error('Saved send state is invalid. Do not resend.'); return value;
}
export async function guardedReminderSend(token: string, user: MobileUser, txn: number, version: string, signal?: AbortSignal): Promise<ReminderReceipt> {
 const scope = await key(user.id ?? 0, txn); if (active.has(scope)) throw new Error('A reminder submission is in progress.'); active.add(scope);
 try {
  if (!token || !canDocumentReminders(user, true) || signal?.aborted || await readReminderAttempt(user.id ?? 0, txn)) throw new Error('Recover the previous reminder before sending again.');
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('Refresh and review reminder contents.');
  const attempt = { request_id: Crypto.randomUUID(), version }; await SecureStore.setItemAsync(scope, JSON.stringify(attempt));
  if (signal?.aborted) throw new Error('Submission cancelled; recover saved status before another send.');
  try { return await submitReminder(token, user, txn, attempt.request_id, version, signal); } catch (error) { if (error instanceof RejectedReminderSendError) await SecureStore.deleteItemAsync(scope); throw error; }
 } finally { active.delete(scope); }
}
export async function clearConfirmedReminder(token: string, userId: number, txn: number, signal?: AbortSignal) {
 const scope = await key(userId, txn); if (active.has(scope)) throw new Error('Wait for the current reminder.'); active.add(scope);
 try { const attempt = await readReminderAttempt(userId, txn); if (!attempt) return; const receipt = await recoverReminder(token, txn, attempt.request_id, signal); if (signal?.aborted || receipt.status !== 'sent' || receipt.request_id !== attempt.request_id) throw new Error('Delivery is unresolved. Check the provider; do not resend.'); await SecureStore.deleteItemAsync(scope); } finally { active.delete(scope); }
}
