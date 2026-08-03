import { FIELD_MAP, META_FIELD_LIMITS } from './meta.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Fit a mapped answer to the column it lands in.
 *
 * WHY THIS HAS TO EXIST. A Meta lead form asks whatever the advertiser typed into it, and the
 * answers are free text of any length. The columns are not: `email` and `location` are
 * VarChar(255), `phone` is VarChar(64), `budget`/`timeline`/`property_type` are VarChar(128).
 * Without a cap, Postgres rejected the row, `syncUser` caught it, counted the submission under
 * `skipped`, and the lead was gone — a click the brokerage had paid for, lost to a long answer,
 * with a log line as the only trace. Confirmed for email, phone, location and budget.
 *
 * TRUNCATE RATHER THAN REFUSE. The tail of a location or a budget range is worth less than the
 * enquiry itself, and the raw answer is preserved in full on `meta_raw` either way, so nothing is
 * actually lost — only shortened in the column that has to be searchable.
 *
 * The same trade, for the same reason, as `IMPORT_FIELD_LIMITS` in the CSV importer. The two
 * importers should not disagree about what happens when a value is too long.
 */
const fit = (value: string | null, field: keyof typeof META_FIELD_LIMITS): string | null => {
  if (value === null) return null;
  const max = META_FIELD_LIMITS[field];
  return value.length > max ? value.slice(0, max) : value;
};

export interface MappedMetaLead {
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone_normalized: string | null;
  location: string | null;
  property: string | null;
  message: string | null;
  budget: string | null;
  timeline: string | null;
  property_type: string | null;
  /** Answers with no column of their own — never discarded. */
  custom_fields: Record<string, string>;
}

/**
 * Digits only, so the same number written three ways still matches.
 *
 * A North-American number is reduced to its last 10 digits: `+1 (416) 555-0100`,
 * `416-555-0100` and `4165550100` all normalise to `4165550100`. Longer international
 * numbers keep their full digit string, since their country code is significant.
 */
export function normalizePhone(raw: unknown): string | null {
  const digits = str(raw).replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length > 11) return digits;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Split a single full-name answer into first and last, keeping the whole string too. */
function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Flatten a Meta lead form's answers onto lead columns.
 *
 * Meta forms are user-defined: two Pages rarely ask the same questions, and question names are
 * arbitrary strings. So the mapping is deliberately forgiving — an exact match on FIELD_MAP
 * first, then a loose contains-match for the common variants, and anything still unmatched is
 * preserved verbatim in `custom_fields` rather than dropped.
 */
export function mapMetaLead(fieldData: { name?: string; values?: string[] }[] | undefined): MappedMetaLead {
  const out: MappedMetaLead = {
    name: '', first_name: null, last_name: null, email: null, phone: null, phone_normalized: null,
    location: null, property: null, message: null, budget: null, timeline: null,
    property_type: null, custom_fields: {},
  };

  let firstName = '';
  let lastName = '';
  let fullName = '';

  for (const field of fieldData ?? []) {
    const key = str(field.name).toLowerCase();
    const value = str(field.values?.[0]);
    if (!key || !value) continue;

    // Names are handled separately so first/last can be assembled either way round.
    if (key === 'first_name' || key === 'firstname') { firstName ||= value; continue; }
    if (key === 'last_name' || key === 'lastname' || key === 'surname') { lastName ||= value; continue; }
    if (key === 'full_name' || key === 'fullname' || key === 'name') { fullName ||= value; continue; }

    const column = FIELD_MAP[key] ?? looseMatch(key);
    if (!column || column === 'name') { out.custom_fields[key] = value; continue; }

    const target = out as unknown as Record<string, string | null>;
    if (!target[column]) target[column] = value;
    else out.custom_fields[key] = value; // a second answer for the same column is still kept
  }

  if (firstName || lastName) {
    out.first_name = firstName || null;
    out.last_name = lastName || null;
    out.name = [firstName, lastName].filter(Boolean).join(' ');
  }
  if (!out.name && fullName) {
    out.name = fullName;
    const split = splitName(fullName);
    out.first_name = split.first;
    out.last_name = split.last;
  }

  // A form can omit the name entirely; fall back to something identifiable.
  if (!out.name) out.name = out.email || out.phone || 'Meta lead';
  if (!out.property && out.property_type) out.property = out.property_type;
  out.phone_normalized = normalizePhone(out.phone);

  /*
   * Fit every mapped value to its column, as the last step.
   *
   * Done here rather than at each assignment so that a field added to the map later cannot be
   * forgotten — the shape of the object is the checklist. `message` and `custom_fields` land in
   * TEXT columns and are capped only to keep one runaway answer from bloating a row.
   *
   * `phone_normalized` is derived from `phone` BEFORE the cap, so matching still works on the whole
   * number even when the display value has been shortened.
   */
  out.name = fit(out.name, 'name') ?? 'Meta lead';
  out.first_name = fit(out.first_name, 'first_name');
  out.last_name = fit(out.last_name, 'last_name');
  out.email = fit(out.email, 'email');
  out.phone = fit(out.phone, 'phone');
  out.location = fit(out.location, 'location');
  out.property = fit(out.property, 'property');
  out.budget = fit(out.budget, 'budget');
  out.timeline = fit(out.timeline, 'timeline');
  out.property_type = fit(out.property_type, 'property_type');
  out.message = fit(out.message, 'message');
  out.phone_normalized = fit(out.phone_normalized, 'phone_normalized');

  /*
   * Unmapped answers, capped per answer FIRST and then as a whole.
   *
   * Per answer matters: capping only the serialised map meant one runaway answer at the front used
   * the entire budget and every other question the client answered was dropped with it. A form asks
   * a handful of things and the point of `custom_fields` is that none of them is silently lost, so
   * each is trimmed to a sensible length before the total is considered.
   *
   * The whole-map cap then still applies, because a form with a hundred questions can exceed the
   * budget with no single answer being unreasonable. Anything trimmed either way remains in
   * `meta_raw` in full.
   */
  const perAnswer = 2_000;
  const trimmed: Record<string, string> = {};
  let used = 2;                                    // the braces of the serialised object
  for (const [k, v] of Object.entries(out.custom_fields)) {
    const value = v.length > perAnswer ? v.slice(0, perAnswer) : v;
    const entry = JSON.stringify({ [k]: value }).length;
    if (used + entry > META_FIELD_LIMITS.custom_fields) break;
    trimmed[k] = value;
    used += entry;
  }
  out.custom_fields = trimmed;

  return out;
}

/** Common question phrasings Meta advertisers use, matched loosely when the exact key misses. */
function looseMatch(key: string): string | null {
  const k = key.replace(/[^a-z]/g, '');
  if (k.includes('email')) return 'email';
  if (k.includes('phone') || k.includes('mobile') || k.includes('whatsapp') || k.includes('contactnumber')) return 'phone';
  if (k.includes('budget') || k.includes('pricerange') || k.includes('spend')) return 'budget';
  if (k.includes('timeline') || k.includes('when') || k.includes('movein') || k.includes('howsoon')) return 'timeline';
  if (k.includes('propertytype') || k.includes('hometype') || k.includes('lookingfor')) return 'property_type';
  if (k.includes('city') || k.includes('location') || k.includes('area') || k.includes('neighbourhood') || k.includes('neighborhood')) return 'location';
  if (k.includes('message') || k.includes('comment') || k.includes('question') || k.includes('note')) return 'message';
  if (k.includes('property') || k.includes('address')) return 'property';
  return null;
}
