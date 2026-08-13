/** Lead + campaign vocabularies, mirroring the source campaign engine exactly. */

/**
 * The lead vocabulary the audience builder offers — RE-EXPORTED from the Leads module, not copied.
 *
 * These were four separate literal arrays, and they had drifted. Measured against
 * `leads/lead.constants.ts`:
 *
 *   status  campaigns lacked `closed`
 *   source  campaigns lacked `website`
 *   type    campaigns lacked `realtor`
 *
 * The consequence was not cosmetic. `campaigns.controller.ts` serves these as the audience
 * dropdowns, so a lead whose source is `website` — one of the two commonest intake channels — could
 * not be targeted by any campaign. The option simply was not offered, and nothing reported it. The
 * backend was never the obstacle: `buildAudienceWhere` matches whatever string arrives, so an API
 * caller could target those leads while a user could not.
 *
 * Re-exported rather than re-synchronised, because a second copy that happens to agree today is the
 * same bug waiting to happen again. Leads owns this vocabulary — it owns the column — and there is
 * now one definition. `lead-vocabulary-parity.spec.ts` asserts the two sides stay identical.
 */
export { LEAD_STATUS, LEAD_TYPE, LEAD_SOURCE, CLIENT_TYPE } from '../leads/lead.constants';
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
