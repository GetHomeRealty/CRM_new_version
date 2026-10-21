/**
 * Celebration & Wishes — the pure half: occasions, merge fields, the email layout, timezones, date
 * matching, failure classification and the checks on AI output.
 *
 * Nothing here touches the database or the network, so every rule can be tested on its own and the
 * services that use them stay about orchestration.
 */

// ------------------------------------------------------------------------------------- occasions

export type OccasionGroup = 'festival' | 'birthday' | 'anniversary' | 'general';

export interface OccasionDef { value: string; label: string; group: OccasionGroup }

/**
 * The festivals offered by name. Deliberately a broad, multi-faith list with no defaults chosen for
 * anyone: the author picks the occasion and the audience, and nothing is ever inferred about a
 * recipient's religion or culture from their name or any other field.
 */
export const FESTIVALS: readonly OccasionDef[] = [
  { value: 'new-year', label: 'New Year', group: 'festival' },
  { value: 'lunar-new-year', label: 'Lunar New Year', group: 'festival' },
  { value: 'lohri', label: 'Lohri', group: 'festival' },
  { value: 'pongal-sankranti', label: 'Pongal / Makar Sankranti', group: 'festival' },
  { value: 'valentines-day', label: "Valentine's Day", group: 'festival' },
  { value: 'family-day', label: 'Family Day', group: 'festival' },
  { value: 'holi', label: 'Holi', group: 'festival' },
  { value: 'nowruz', label: 'Nowruz', group: 'festival' },
  { value: 'ramadan', label: 'Ramadan', group: 'festival' },
  { value: 'eid-al-fitr', label: 'Eid al-Fitr', group: 'festival' },
  { value: 'easter', label: 'Easter', group: 'festival' },
  { value: 'vaisakhi', label: 'Vaisakhi', group: 'festival' },
  { value: 'mothers-day', label: "Mother's Day", group: 'festival' },
  { value: 'eid-al-adha', label: 'Eid al-Adha', group: 'festival' },
  { value: 'fathers-day', label: "Father's Day", group: 'festival' },
  { value: 'canada-day', label: 'Canada Day', group: 'festival' },
  { value: 'raksha-bandhan', label: 'Raksha Bandhan', group: 'festival' },
  { value: 'ganesh-chaturthi', label: 'Ganesh Chaturthi', group: 'festival' },
  { value: 'onam', label: 'Onam', group: 'festival' },
  { value: 'rosh-hashanah', label: 'Rosh Hashanah', group: 'festival' },
  { value: 'thanksgiving', label: 'Thanksgiving', group: 'festival' },
  { value: 'navratri-dussehra', label: 'Navratri / Dussehra', group: 'festival' },
  { value: 'diwali', label: 'Diwali', group: 'festival' },
  { value: 'bandi-chhor-divas', label: 'Bandi Chhor Divas', group: 'festival' },
  { value: 'hanukkah', label: 'Hanukkah', group: 'festival' },
  { value: 'christmas', label: 'Christmas', group: 'festival' },
  { value: 'kwanzaa', label: 'Kwanzaa', group: 'festival' },
  { value: 'holidays', label: 'Holiday Season', group: 'festival' },
];

export const OCCASION_BIRTHDAY = 'birthday';
export const OCCASION_ANNIVERSARY = 'anniversary';
export const OCCASION_CUSTOM_FESTIVAL = 'custom-festival';
export const OCCASION_GENERAL = 'general';

const FESTIVAL_VALUES = new Set(FESTIVALS.map((f) => f.value));

/** Whether `occasion` is one this feature knows. */
export function isOccasion(occasion: string): boolean {
  return FESTIVAL_VALUES.has(occasion)
    || [OCCASION_BIRTHDAY, OCCASION_ANNIVERSARY, OCCASION_CUSTOM_FESTIVAL, OCCASION_GENERAL].includes(occasion);
}

export function occasionGroup(occasion: string): OccasionGroup {
  if (occasion === OCCASION_BIRTHDAY) return 'birthday';
  if (occasion === OCCASION_ANNIVERSARY) return 'anniversary';
  if (occasion === OCCASION_GENERAL) return 'general';
  return 'festival';
}

/** True for the two occasions tied to a date on the lead. */
export const isDateOccasion = (occasion: string): boolean =>
  occasion === OCCASION_BIRTHDAY || occasion === OCCASION_ANNIVERSARY;

/** The name a person sees: the preset's label, or the author's own for custom and general. */
export function occasionLabel(occasion: string, custom?: string | null): string {
  const own = String(custom ?? '').trim();
  if (occasion === OCCASION_BIRTHDAY) return 'Birthday';
  if (occasion === OCCASION_ANNIVERSARY) return 'Anniversary';
  if (occasion === OCCASION_CUSTOM_FESTIVAL) return own || 'Festival';
  if (occasion === OCCASION_GENERAL) return own || 'Greeting';
  return FESTIVALS.find((f) => f.value === occasion)?.label ?? (own || occasion);
}

export const slug = (v: string): string =>
  String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * The key one greeting per address and year is counted against, or null when the occasion is not
 * annual. A general greeting ("thank you", "welcome to the neighbourhood") may reasonably go twice
 * in a year; a birthday or a Diwali greeting may not.
 */
export function occasionKey(occasion: string, custom?: string | null): string | null {
  if (occasion === OCCASION_GENERAL) return null;
  if (occasion === OCCASION_CUSTOM_FESTIVAL) {
    const s = slug(String(custom ?? ''));
    return s ? `festival:${s}` : null;
  }
  return occasion;
}

/**
 * The CRM email log kind a send is recorded under. Birthday and anniversary use the same kinds as
 * the Settings greeting sweep, whose "already greeted this year" check reads that log — so a lead
 * greeted by a celebration campaign is skipped by the sweep, and vice versa, with no change to it.
 */
export function emailLogKind(occasion: string): string {
  if (occasion === OCCASION_BIRTHDAY) return 'birthday';
  if (occasion === OCCASION_ANNIVERSARY) return 'anniversary';
  return 'campaign';
}

// ------------------------------------------------------------------------------- vocabularies

export const TONES = ['professional', 'warm', 'friendly', 'festive'] as const;
export const LENGTHS = ['short', 'medium', 'detailed'] as const;
export const BRANDINGS = ['brokerage', 'agent'] as const;
export const FEB29_RULES = ['feb28', 'mar1', 'skip'] as const;
export const DATE_WINDOWS = ['today', 'next7', 'this_month', 'on_date'] as const;
export const DEFAULT_TIMEZONE = 'America/Toronto';

/** A celebration may reach more people than a template campaign (300) — chosen 2026-10-21. */
export const CELEBRATION_MAX_RECIPIENTS = 2000;

/** The merge fields a celebration message may use, and what each falls back to when empty. */
export const CELEBRATION_TOKENS: readonly { token: string; label: string; fallback: string }[] = [
  { token: 'LEAD_FIRST_NAME', label: "Lead's first name", fallback: '"there" (Hi there,)' },
  { token: 'LEAD_NAME', label: "Lead's full name", fallback: '"there"' },
  { token: 'AGENT_NAME', label: 'Sending agent name', fallback: 'Get Home Realty' },
  { token: 'AGENT_EMAIL', label: 'Sending agent email', fallback: 'brokerage email' },
  { token: 'AGENT_PHONE', label: 'Sending agent phone', fallback: 'brokerage phone, else blank' },
  { token: 'BROKERAGE_NAME', label: 'Brokerage name', fallback: 'Get Home Realty' },
  { token: 'BROKERAGE_PHONE', label: 'Brokerage phone', fallback: 'blank' },
  { token: 'BROKERAGE_EMAIL', label: 'Brokerage email', fallback: 'blank' },
];
const ALLOWED_TOKENS = new Set(CELEBRATION_TOKENS.map((t) => t.token));

// ------------------------------------------------------------------------------- merge values

/** "Priya" from "Priya Sharma", or the stored first name; empty when neither has one. */
export function firstNameOf(lead: { first_name?: string | null; name?: string | null }): string {
  const own = String(lead.first_name ?? '').trim();
  if (own) return own;
  const name = String(lead.name ?? '').trim();
  // A name that is really an email address or a phone number is not something to greet anyone by.
  if (!name || /@|^\+?[\d\s().-]{6,}$/.test(name)) return '';
  return name.split(/\s+/)[0];
}

/** Per-recipient values, snapshot on the recipient row like the property tokens are. */
export function recipientVars(
  lead: { first_name?: string | null; name?: string | null },
  brokerage: { name: string; phone: string; email: string },
): Record<string, string> {
  const first = firstNameOf(lead);
  const name = String(lead.name ?? '').trim();
  return {
    LEAD_FIRST_NAME: first || 'there',
    LEAD_NAME: (/@/.test(name) ? '' : name) || 'there',
    BROKERAGE_NAME: brokerage.name || 'Get Home Realty',
    BROKERAGE_PHONE: brokerage.phone,
    BROKERAGE_EMAIL: brokerage.email,
  };
}

/** Every {{TOKEN}} in a text that a celebration cannot fill. */
export function unknownTokens(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)) {
      if (!ALLOWED_TOKENS.has(m[1])) out.add(m[1]);
    }
  }
  return [...out];
}

// ------------------------------------------------------------------------------------- layout

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * The author's plain-text message as HTML paragraphs. Escaped, so nothing typed — or generated —
 * can inject markup into somebody's inbox. Blank lines separate paragraphs; a single newline is a
 * line break. Merge tokens pass through untouched.
 */
export function messageToHtml(message: string): string {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

export const FLYER_CID = 'celebration-flyer';

export interface Signature { name: string; title?: string; phone?: string; email?: string; brokerage: string }

/**
 * The whole email body, before personalisation and the unsubscribe footer.
 *
 * Table-based and inline-styled because that is what renders in Outlook as well as on a phone; the
 * image scales to the column on a narrow screen. The greeting text sits ABOVE the image so the
 * message reads correctly with images blocked, and the image always carries its alt text.
 */
export function renderCelebrationHtml(opts: {
  message: string;
  previewText?: string | null;
  flyer?: { alt: string; width: number; height: number; src?: string } | null;
  signature: Signature;
  accent?: string;
}): string {
  const accent = /^#[0-9a-f]{6}$/i.test(opts.accent ?? '') ? opts.accent : '#c8102e';
  const preview = String(opts.previewText ?? '').trim();
  const preheader = preview
    // No invisible padding after it: the text/plain part is derived from this HTML, and padding
    // characters would open that part with a run of zero-width junk.
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${esc(preview)}</div>\n`
    : '';
  const flyer = opts.flyer
    ? `<tr><td align="center" style="padding:4px 28px 18px;">`
      + `<img src="${esc(opts.flyer.src ?? `cid:${FLYER_CID}`)}" alt="${esc(opts.flyer.alt)}" width="544" `
      + `style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:6px;" />`
      + `</td></tr>\n`
    : '';
  const s = opts.signature;
  const contact = [s.phone, s.email].map((v) => String(v ?? '').trim()).filter(Boolean).map(esc).join(' &middot; ');
  const sig = `<p style="margin:0;font-weight:bold;color:#111827;">${esc(s.name)}</p>`
    + (s.title ? `<p style="margin:2px 0 0;color:#4b5563;">${esc(s.title)}</p>` : '')
    + (s.brokerage && s.brokerage !== s.name ? `<p style="margin:2px 0 0;color:#4b5563;">${esc(s.brokerage)}</p>` : '')
    + (contact ? `<p style="margin:2px 0 0;color:#4b5563;">${contact}</p>` : '');
  return `${preheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f6f8;">`
    + `<tr><td align="center" style="padding:24px 12px;">\n`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;border-top:4px solid ${accent};">\n`
    + `<tr><td style="padding:28px 28px 6px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1f2937;">\n`
    + `${messageToHtml(opts.message)}\n</td></tr>\n`
    + flyer
    + `<tr><td style="padding:6px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">${sig}</td></tr>\n`
    + `</table>\n</td></tr></table>`;
}

// ---------------------------------------------------------------------------------- timezones

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a zone. */
export function zonedParts(at: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function zonedDate(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * The UTC instant of a wall-clock date and time in a zone. Two passes, because the offset at the
 * first guess can differ from the offset at the answer across a DST change. A time that does not
 * exist (the skipped spring-forward hour) resolves to the hour after, which is what people mean.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const tm = /^(\d{2}):(\d{2})$/.exec(String(time ?? ''));
  if (!dm || !tm || !isValidTimeZone(tz)) return null;
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (instant: number): number => {
    const p = zonedParts(new Date(instant), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - instant;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  const check = new Date(guess);
  if (Number.isNaN(check.getTime())) return null;
  return check;
}

// ------------------------------------------------------------------------------ date matching

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Month and day of a stored date column, read in UTC (the column is a DATE with no zone). */
export function monthDay(d: Date | null | undefined): { m: number; d: number } | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** A stored birth or wedding date that cannot be right: before 1900 or in the future. */
export function isImplausibleDate(d: Date, today: Date = new Date()): boolean {
  const y = d.getUTCFullYear();
  return y < 1900 || d.getTime() > today.getTime() + 24 * 3600 * 1000;
}

/**
 * Whether a stored date is celebrated on the calendar day `on` ("YYYY-MM-DD"). Month and day only.
 * Feb 29 in a non-leap year follows the rule: Feb 28, Mar 1, or not at all.
 */
export function celebratedOn(stored: Date | null | undefined, on: string, feb29: string = 'feb28'): boolean {
  const md = monthDay(stored);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  if (!md || !m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (md.m === 2 && md.d === 29 && !isLeapYear(y)) {
    if (feb29 === 'feb28') return mo === 2 && d === 28;
    if (feb29 === 'mar1') return mo === 3 && d === 1;
    return false;
  }
  return md.m === mo && md.d === d;
}

/** The calendar days ("YYYY-MM-DD") a date window covers, starting from `today` in the zone. */
export function windowDays(window: string, today: string, onDate?: string | null): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return [];
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const day = (offset: number) => new Date(base + offset * 86400000).toISOString().slice(0, 10);
  if (window === 'on_date') return /^\d{4}-\d{2}-\d{2}$/.test(String(onDate ?? '')) ? [String(onDate)] : [];
  if (window === 'next7') return Array.from({ length: 7 }, (_, i) => day(i));
  if (window === 'this_month') {
    const y = Number(m[1]); const mo = Number(m[2]);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return Array.from({ length: days }, (_, i) => `${y}-${String(mo).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
  }
  return [today];
}

// ------------------------------------------------------------------------ failure classification

export type CelebrationFailure = 'not_sent' | 'unknown_outcome';

/**
 * For a failure that is not a bounce: did the message certainly not leave, or might the mail server
 * have it? Only the first is ever retried — an "unknown outcome" may already be in the inbox, and a
 * duplicate greeting is the failure people notice.
 *
 * A 5xx from our own server (a refused login, a refused sender) means it refused the message; a
 * refused connection or an unresolvable host means no message was ever handed over; a missing
 * mailbox is a setup problem caught before any connection. Anything else — a timeout or a dropped
 * connection mid-conversation — is unknown.
 */
export function classifyNonBounceFailure(err: unknown): CelebrationFailure {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; message?: unknown };
  if (typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600) return 'not_sent';
  const code = String(e.code ?? '');
  const msg = String(e.message ?? err ?? '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'EHOSTUNREACH', 'ENETUNREACH', 'EAUTH', 'EENVELOPE'].includes(code)) return 'not_sent';
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|Greeting never received|Invalid login|authentication failed|no active smtp account|not available to send from|is no longer connected/i.test(msg)) return 'not_sent';
  return 'unknown_outcome';
}

// ------------------------------------------------------------------------------ AI output checks

/**
 * Words that turn a greeting into a sales message. Flagged, not removed: the author may have asked
 * for exactly that, and it is their message — but they are told before they send it.
 */
const PROMO = /\b(listings?|for sale|price[sd]?|pricing|mortgage|interest rates?|discounts?|offers?|deals?|buy now|sell your|selling your|market update|open house|investment|home value|free (home )?evaluation|commission)\b/i;

export interface AiGreeting {
  subject: string; preview_text: string; message: string; flyer_headline: string; flyer_greeting: string;
}

/**
 * Turn whatever the model returned into a draft that is safe to put in front of the author.
 *
 * Plain text only (any markup is removed — the layout is ours), only the merge fields this feature
 * can fill, no links, and lengths capped to what the columns and an inbox can show. Every change
 * made is reported as a warning so nothing is silently rewritten.
 */
export function sanitiseAiGreeting(raw: string, instructions: string): { draft: AiGreeting; warnings: string[] } {
  const warnings: string[] = [];
  let obj: Record<string, unknown> = {};
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    obj = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text) as Record<string, unknown>;
  } catch {
    throw new Error('The AI service did not return a usable greeting. Try again, or write the message yourself.');
  }
  const clean = (v: unknown, max: number, multiline = false): string => {
    let s = String(v ?? '').replace(/\r\n?/g, '\n');
    if (/<[a-z/][^>]*>/i.test(s)) { s = s.replace(/<[^>]+>/g, ''); warnings.push('Formatting tags in the AI text were removed — the email layout is applied automatically.'); }
    if (/https?:\/\/|www\./i.test(s)) {
      s = s.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '').replace(/[ \t]{2,}/g, ' ');
      warnings.push('A web link in the AI text was removed. Add links yourself if you want them.');
    }
    const bad = unknownTokens(s);
    if (bad.length) {
      for (const t of bad) s = s.replace(new RegExp(`{{\\s*${t}\\s*}}`, 'g'), '');
      warnings.push(`Unsupported merge fields were removed: ${bad.join(', ')}.`);
    }
    s = multiline ? s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
    if (s.length > max) { s = s.slice(0, max).replace(/\s+\S*$/, '').trim(); }
    return s;
  };
  const draft: AiGreeting = {
    subject: clean(obj.subject, 150),
    preview_text: clean(obj.preview_text, 200),
    message: clean(obj.message ?? obj.body, 4000, true),
    flyer_headline: clean(obj.flyer_headline, 48),
    flyer_greeting: clean(obj.flyer_greeting, 160),
  };
  if (!draft.subject || !draft.message) {
    throw new Error('The AI service returned an incomplete greeting (no subject or message). Try again, or write it yourself.');
  }
  const asked = PROMO.test(instructions);
  if (!asked && PROMO.test(`${draft.subject}\n${draft.message}`)) {
    warnings.push('This draft mentions property, prices or offers. A greeting usually should not — review it before sending.');
  }
  return { draft, warnings: [...new Set(warnings)] };
}

/** Non-AI starting points, offered when AI is unavailable or not wanted. Clearly not AI. */
export function starterMessage(occasion: string, label: string): { subject: string; preview_text: string; message: string } {
  if (occasion === OCCASION_BIRTHDAY) {
    return {
      subject: 'Happy Birthday, {{LEAD_FIRST_NAME}}!',
      preview_text: 'Warm wishes on your special day.',
      message: 'Hi {{LEAD_FIRST_NAME}},\n\nWishing you a very happy birthday! I hope your day is filled with good company, good food and plenty of reasons to smile.\n\nHave a wonderful year ahead.',
    };
  }
  if (occasion === OCCASION_ANNIVERSARY) {
    return {
      subject: 'Happy Anniversary, {{LEAD_FIRST_NAME}}!',
      preview_text: 'Celebrating your special day with you.',
      message: 'Hi {{LEAD_FIRST_NAME}},\n\nCongratulations on your anniversary! Wishing you many more happy years together.\n\nWarm regards.',
    };
  }
  if (occasion === OCCASION_GENERAL) {
    return {
      subject: `${label} from {{BROKERAGE_NAME}}`,
      preview_text: 'A quick note to say we are thinking of you.',
      message: 'Hi {{LEAD_FIRST_NAME}},\n\nJust a quick note to say thank you for being part of our community. We are always here if you need anything.\n\nWarm regards.',
    };
  }
  return {
    subject: `Warm ${label} wishes, {{LEAD_FIRST_NAME}}`,
    preview_text: `Warm wishes to you and your loved ones this ${label}.`,
    message: `Hi {{LEAD_FIRST_NAME}},\n\nWishing you and your loved ones a joyful ${label}. May the season bring you happiness, good health and time with the people who matter most.\n\nWarm wishes.`,
  };
}
