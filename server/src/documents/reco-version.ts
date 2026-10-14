import { createHash } from 'crypto';
export function recoVersion(transactionId: number, ready: string | null, remarks: string | null): string {
  return createHash('sha256').update(JSON.stringify([transactionId, ready, remarks])).digest('hex');
}
