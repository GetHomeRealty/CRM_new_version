/**
 * Lead vocabularies. Values are stored verbatim (including the historical "refferal"
 * spelling and the capitalised "Pre construction" / "Investor"), so imported data and
 * campaign audience filters keep matching.
 */

export const LEAD_STATUS = ['hot', 'warm', 'cold', 'mild', 'closed'] as const;

export const LEAD_RESPONSE = [
  'active', 'inactive', 'not answering', 'not actively answering', 'always responding',
] as const;

/*
 * 'referral' IS NOW THE CANONICAL SPELLING, and 'refferal' is a legacy value that still matches.
 *
 * The list used to offer 'refferal', and the comment here claimed "the UI labels it Referral". It
 * did not: the only transformation applied to these values is title-casing, so the dropdown read
 * "Refferal" on a screen agents use all day, and a filter for referral leads returned nothing while
 * the referral business sat under the typo.
 *
 * BOTH SPELLINGS REMAIN ACCEPTED, which is what makes fixing this safe before the data is migrated.
 * A lead already stored as 'refferal' still validates, still filters, still displays as "Referral";
 * anything saved from now on is stored correctly. Correcting the list without that would have
 * stranded every existing referral - the precise cost the report warned about.
 *
 * 'website' was added when the Dashboard started reporting leads by source — there was no way to
 * record a website enquiry before.
 */
export const LEAD_SOURCE = ['google ads', 'meta', 'website', 'referral', 'linkedin', 'youtube'] as const;

/** The misspelling as it exists in stored rows. Accepted on input, matched on filter, never offered. */
export const LEGACY_REFERRAL = 'refferal';

/** Canonical form of a source value: the legacy spelling collapses onto the correct one. */
export const canonicalLeadSource = (v: string): string =>
  (v.trim().toLowerCase() === LEGACY_REFERRAL ? 'referral' : v);

/**
 * Every stored spelling a source filter should match.
 *
 * Asking for 'referral' has to find the rows written as 'refferal', or the fix would leave the
 * brokerage's referrals exactly as unfindable as the typo did.
 */
export const leadSourceMatches = (v: string): string[] =>
  (v.trim().toLowerCase() === 'referral' ? ['referral', LEGACY_REFERRAL] : [v]);

/**
 * The sources the Dashboard's Total Leads card breaks out, in display order. Anything else —
 * linkedin, youtube, or a lead with no source recorded — is reported as "other", so the parts
 * always add up to the total.
 */
export const DASHBOARD_LEAD_SOURCES = [
  { key: 'google', value: 'google ads', label: 'google' },
  { key: 'meta', value: 'meta', label: 'meta' },
  { key: 'website', value: 'website', label: 'website' },
  // Counted through `leadSourceMatches`, so the bucket covers both spellings while rows remain in
  // the old one. It was always keyed correctly here - the arithmetic was never the problem.
  { key: 'referral', value: 'referral', label: 'referral' },
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

/*
 * `WEBSITE_ENQUIRY_SOURCES` WAS REMOVED, and it is worth saying what it was.
 *
 * It read `['google ads', 'meta']` under a comment calling it "sources counted as inbound website
 * enquiries" - a constant named for the website that contained neither the website nor anything
 * from it. It fed a `stats.websiteEnquiries` figure that therefore counted PAID ADS, disagreed with
 * `bySource.website` in the same response (3 against a correct 4), and was shipped to the browser
 * on every leads request while no screen displayed it. The Website Enquiries tile renders
 * `bySource.website` and always did.
 *
 * Deleted rather than corrected: a fixed duplicate would still be two figures answering one
 * question, which is how they drift apart again. `DASHBOARD_LEAD_SOURCES` above already breaks out
 * website, google, meta and referral separately, and that is the one source of the answer.
 */

/**
 * `leads.source` for a submission that arrived through an agent's own Meta connection.
 *
 * WHY THIS IS THE LINE, and not `lead_source = 'meta'`. `lead_source` is a channel somebody typed
 * into a form — an agent can record "I met them through a Facebook ad" on a lead they entered by
 * hand, and that lead came from the brokerage's world, not from their personal ad account.
 * `source = 'facebook_meta'` is written only by the Meta importer, on all three of its paths, and
 * it always means: this arrived through THIS agent's own Meta account, their own Page, their own
 * lead form, paid for by them.
 *
 * That distinction decides who keeps the lead when an agent leaves, so it has to be the fact the
 * system recorded rather than the label a person chose.
 */
export const META_LEAD_SOURCE = 'facebook_meta';

/*
 * `brokerageLeadWhere()` LIVED HERE AND HAS BEEN REMOVED. Recorded because its absence is a
 * decision, and because anything reintroducing it would be reintroducing a bug.
 *
 * It meant "not one of the agent's own Meta leads", and it answered an OWNERSHIP question from the
 * `source` column back when ownership was decided at departure rather than at intake: an agent's
 * book held both their own Meta leads and the brokerage's walk-ins, and this was how the two were
 * told apart.
 *
 * Ownership is now recorded directly. `owner_user_id IS NULL` is the brokerage's lead and
 * `owner_user_id = X` is X's own, whatever the source — so every caller that used this predicate
 * either had it as a redundant second filter or, in the case of Lead Books' eligible pool, was
 * actively excluding brokerage-owned Meta leads from ever being handed on. Both call sites now ask
 * about the owner. See `LeadTransferService.eligibleWhere` and `returnToBrokerage`.
 *
 * `META_LEAD_SOURCE` above is still meaningful and still used: it records how a lead arrived.
 */

/**
 * Sentinel meaning "only records where this field was never filled in". It travels as an
 * ordinary query-string value, so the client and the API must agree on the exact string.
 */
export const NONE_FILTER_VALUE = '__none__';

/** A lead counts as "recent" for this many days after it arrived. */
export const RECENT_LEAD_DAYS = 30;

export const LEADS_PER_PAGE = 50;
export const MAX_PER_PAGE = 200;

/**
 * Page size for the dashboard's task and showing feeds.
 *
 * Smaller than a lead page because these are read-at-a-glance panels, not a working list — and
 * because unpaginated they were the largest responses the CRM produced: 1.67 MB for one agent's
 * tasks on a brokerage-sized database, growing for as long as the product is used.
 */
export const FEED_PER_PAGE = 25;

/**
 * Cap on one CSV export.
 *
 * Was called MAX_IMPORT_ROWS and used as the export cap while a DIFFERENT `MAX_IMPORT_ROWS`
 * (50,000, in lead-import-job.service.ts) governed actual imports — two constants, one name, two
 * unrelated jobs. Renamed for what it does. The export endpoint reports when it is reached; see
 * `LeadsService.exportRows`.
 */
export const MAX_EXPORT_ROWS = 5000;

/**
 * The longest value each CSV column may carry, matching the database column it lands in.
 *
 * The import wrote straight to `createMany` with no length check, so one over-length cell raised a
 * Postgres error that failed the whole 500-row batch — and Postgres does not name the offending
 * column, so the operator was told a batch failed and not which row caused it. Rows are now
 * truncated to fit and counted, which keeps the other 499 leads.
 */
export const IMPORT_FIELD_LIMITS: Record<string, number> = {
  name: 255,
  email: 255,
  phone: 64,
  lead_status: 32,
  lead_type: 48,
  lead_source: 48,
  client_type: 48,
  // The three the Import dialog has always listed as recognised and the engine never read. Their
  // limits match the columns in `schema.prisma`.
  location: 255,
  property: 255,
  lead_response: 48,
};

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const has = <T extends readonly string[]>(list: T, v: string): v is T[number] =>
  (list as readonly string[]).includes(v);

export const isLeadStatus = (v: string): boolean => has(LEAD_STATUS, v);
export const isLeadResponse = (v: string): boolean => has(LEAD_RESPONSE, v);
// The legacy spelling still validates: a lead stored as 'refferal' must remain editable and
// re-savable without the form rejecting a value it did not choose.
export const isLeadSource = (v: string): boolean => has(LEAD_SOURCE, v) || v === LEGACY_REFERRAL;
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
