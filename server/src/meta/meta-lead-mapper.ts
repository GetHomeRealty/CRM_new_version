import { FIELD_MAP } from './meta.constants';

const str = (v: unknown): string => String(v ?? '').trim();

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
