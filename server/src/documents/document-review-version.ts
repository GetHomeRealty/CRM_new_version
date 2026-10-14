import { createHash } from 'crypto';
import type { documents } from '@prisma/client';
/** Includes file identity and all metadata: second-resolution timestamps alone are insufficient. */
export function documentReviewVersion(document: documents): string {
  const row = document as unknown as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])))).digest('hex');
}
