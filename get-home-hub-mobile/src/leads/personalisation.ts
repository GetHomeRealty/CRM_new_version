import type { LeadUpdate } from './leads-api';
export const personalisationFields = [
  { key: 'property_address', label: 'Property address', maxLength: 255 },
  { key: 'property_price', label: 'Property price', maxLength: 64 },
  { key: 'bedrooms', label: 'Bedrooms', maxLength: 16 },
  { key: 'bathrooms', label: 'Bathrooms', maxLength: 16 },
  { key: 'square_footage', label: 'Square footage', maxLength: 24 },
  { key: 'key_features', label: 'Key features', maxLength: 5000 },
] as const;
/** These API fields are text tokens, distinct from numeric property preferences. */
export function serializePersonalisation(update: LeadUpdate): LeadUpdate {
  const result: LeadUpdate = {};
  for (const { key, maxLength, label } of personalisationFields) {
    if (!(key in update)) continue;
    const value = update[key];
    if (value !== null && typeof value !== 'string') throw new Error(`${label} must be text.`);
    const text = value?.trim() || '';
    if (text.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
    result[key] = text || null;
  }
  return result;
}
