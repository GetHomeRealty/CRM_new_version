/**
 * Lead vocabularies. Values are stored verbatim (including the historical "refferal"
 * spelling and the capitalised "Pre construction" / "Investor"), so imported data and
 * campaign audience filters keep matching.
 */

export const LEAD_STATUS = ['hot', 'warm', 'cold', 'mild', 'closed'] as const;

export const LEAD_RESPONSE = [
  'active', 'inactive', 'not answering', 'not actively answering', 'always responding',
] as const;

// 'refferal' is spelt that way in the source system and in existing rows, so it stays as the
// stored value; the UI labels it "Referral". 'website' was added when the Dashboard started
// reporting leads by source — there was no way to record a website enquiry before.
export const LEAD_SOURCE = ['google ads', 'meta', 'website', 'refferal', 'linkedin', 'youtube'] as const;

/**
 * The sources the Dashboard's Total Leads card breaks out, in display order. Anything else —
 * linkedin, youtube, or a lead with no source recorded — is reported as "other", so the parts
 * always add up to the total.
 */
export const DASHBOARD_LEAD_SOURCES = [
  { key: 'google', value: 'google ads', label: 'google' },
  { key: 'meta', value: 'meta', label: 'meta' },
  { key: 'website', value: 'website', label: 'website' },
  { key: 'referral', value: 'refferal', label: 'referral' },
] as const;

export const LEAD_TYPE = [
  'Pre construction', 'resale', 'seller', 'buyer', 'tenant', 'lease', 'landlord', 'realtor',
] as const;

export const CLIENT_TYPE = [
  'Investor', 'custom buyer', 'first home buyer', 'seasonal investor', 'commercial buyer',
] as const;

export const GENDERS = ['male', 'female', 'other', 'prefer not to say'] as const;

export const LANGUAGES = ['English', 'French', 'Spanish', 'Mandarin', 'Hindi', 'Punjabi', 'Other'] as const;

export const RELIGIONS = [
  'Christianity', 'Islam', 'Hinduism', 'Buddhism', 'Sikhism', 'Judaism', 'Other', 'Prefer not to say',
] as const;

export const LEAD_CONVERSION = ['converted', 'not-converted'] as const;

export const PROPERTY_TYPES = [
  'Double garage detached', 'Single garage detached', 'Detached', 'Semi-detached',
  'Townhouse', 'Condo townhouse', 'Condo Apartment', 'Commercial', 'Other',
] as const;

export const TASK_STATUS = ['pending', 'completed', 'cancelled'] as const;
export const TASK_PRIORITY = ['low', 'medium', 'high'] as const;
export const SHOWING_STATUS = ['scheduled', 'completed', 'cancelled'] as const;
export const CALL_OUTCOME = [
  'connected', 'no answer', 'voicemail', 'wrong number', 'callback requested',
] as const;

/** Sources counted as inbound website enquiries on the list header. */
export const WEBSITE_ENQUIRY_SOURCES = ['google ads', 'meta'] as const;

/**
 * Sentinel meaning "only records where this field was never filled in". It travels as an
 * ordinary query-string value, so the client and the API must agree on the exact string.
 */
export const NONE_FILTER_VALUE = '__none__';

/** A lead counts as "recent" for this many days after it arrived. */
export const RECENT_LEAD_DAYS = 30;

export const LEADS_PER_PAGE = 50;
export const MAX_PER_PAGE = 200;

/** Cap on a single bulk import, so one paste cannot lock the table for minutes. */
export const MAX_IMPORT_ROWS = 5000;

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const has = <T extends readonly string[]>(list: T, v: string): v is T[number] =>
  (list as readonly string[]).includes(v);

export const isLeadStatus = (v: string): boolean => has(LEAD_STATUS, v);
export const isLeadResponse = (v: string): boolean => has(LEAD_RESPONSE, v);
export const isLeadSource = (v: string): boolean => has(LEAD_SOURCE, v);
export const isLeadType = (v: string): boolean => has(LEAD_TYPE, v);
export const isClientType = (v: string): boolean => has(CLIENT_TYPE, v);
export const isGender = (v: string): boolean => has(GENDERS, v);
export const isConversion = (v: string): boolean => has(LEAD_CONVERSION, v);
/**
 * Audio types a call recording may be stored as.
 *
 * The download endpoint serves a recording inline so the browser can play it, which means the
 * stored Content-Type is honoured by the browser. An allowlist keeps that safe: an uploaded HTML
 * or SVG file served inline from our own origin would run script in our session. Anything not on
 * this list is refused at upload rather than relabelled.
 */
export const AUDIO_TYPES = [
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/flac',
] as const;

/** What to tell the user is accepted, in the words they see on a file dialog. */
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'webm', 'flac'] as const;

export const isAudioType = (v: string): boolean => has(AUDIO_TYPES, v);

/**
 * Ceiling for one recording. Kept below the 12 MB request-body limit in main.ts, since base64
 * inflates the upload by about a third — a larger file would 413 before this check ever ran.
 */
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

// The SMS delivery-status vocabulary lives in ../sms/sms.constants — it has to agree with what
// the gateway reports, so there is deliberately no second copy of it here.

export const isTaskStatus = (v: string): boolean => has(TASK_STATUS, v);
export const isTaskPriority = (v: string): boolean => has(TASK_PRIORITY, v);
export const isShowingStatus = (v: string): boolean => has(SHOWING_STATUS, v);
export const isCallOutcome = (v: string): boolean => has(CALL_OUTCOME, v);
