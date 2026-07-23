/** Lead + campaign vocabularies, mirroring the source campaign engine exactly. */

export const LEAD_STATUS = ['cold', 'warm', 'hot', 'mild'] as const;
export const LEAD_TYPE = ['Pre construction', 'resale', 'seller', 'buyer', 'tenant', 'lease', 'landlord'] as const;
export const LEAD_SOURCE = ['google ads', 'meta', 'refferal', 'linkedin', 'youtube'] as const;
export const CLIENT_TYPE = ['Investor', 'custom buyer', 'first home buyer', 'seasonal investor', 'commercial buyer'] as const;
export const TAG_OPTIONS = ['Pre Construction', 'Resale', 'Seller', 'Buyer', 'Tenant', 'Lease', 'Landlord', 'Realtor'] as const;

export const CAMPAIGN_CATEGORIES = [
  { value: 'welcome', label: 'Welcome' },
  { value: 'follow-up', label: 'Follow-up' },
  { value: 'showing', label: 'Showing' },
  { value: 'property-update', label: 'Property Update' },
  { value: 'thank-you', label: 'Thank You' },
  { value: 'custom', label: 'Custom' },
] as const;

/**
 * Tokens the send engine can fill: recipient/agent identity plus the property tokens taken
 * from each lead's own record. A template using anything else sends that token blank, which
 * the builder warns about before sending.
 */
export const FILLABLE_TOKENS = [
  'LEAD_NAME',
  'AGENT_NAME',
  'AGENT_EMAIL',
  'AGENT_PHONE',
  'PROPERTY_ADDRESS',
  'PROPERTY_PRICE',
  'BEDROOMS',
  'BATHROOMS',
  'SQUARE_FOOTAGE',
  'KEY_FEATURES',
] as const;

/** Property tokens are per-lead and blank when that lead has no value — a softer warning. */
export const LEAD_SOURCED_TOKENS = [
  'PROPERTY_ADDRESS',
  'PROPERTY_PRICE',
  'BEDROOMS',
  'BATHROOMS',
  'SQUARE_FOOTAGE',
  'KEY_FEATURES',
] as const;

/**
 * Many records carry a phone number in the email field, so a non-empty check is not enough —
 * require a real email shape.
 */
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Safety cap: a bigger audience must be split across campaigns. */
export const MAX_RECIPIENTS = 300;
/** Pause between sends so a burst does not trip the provider's rate limit. */
export const SEND_DELAY_MS = 400;
