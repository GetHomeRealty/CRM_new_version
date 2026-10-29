/**
 * THE SWITCHES AND DAYS OF THE SCHEDULED REMINDERS (Sai, 29 Oct 2026) - what is read, what is
 * allowed, and what each one starts as.
 *
 * Kept in `company_settings.feature_flags.reminder_rules` (JSON), beside `lawyer_reminder_days`.
 * Nothing stored means today's behaviour: every reminder On, on the days it has always used. A
 * value that cannot be read falls back to the default for that one reminder, never to "off".
 *
 * The lawyer reminder's On/Off is NOT stored here. It has always been `lawyer_reminder_days`
 * (0 = off), which Company Settings also writes; one switch, one place. Only its days live here.
 *
 * Before closing:  lawyer, closing, condition, listing_expiry - a list of days (days BEFORE the date)
 *                  deposit - one number (days AFTER the offer date)
 *                  commission - On/Off only (it goes the night the invoice is paid)
 * After closing:   after_status (Firm/Conditional still), after_docs (required documents still
 *                  Pending/Invalid), after_lawyer (lawyer details still missing) - first day after
 *                  closing, then every N days, up to a last day. Defaults 1, every 2, up to 60.
 *
 * "Hold the old deals" (Sai): after-closing reminders are only for deals whose closing date is on or
 * after `after_closing_from`, the day this went live. Deals already past closing are left alone.
 */
import {
  CLOSING_REMINDER_DAYS, CONDITION_REMINDER_DAYS, DEPOSIT_GRACE_DAYS, EXPIRY_REMINDER_DAYS, LAWYER_REMINDER_DAYS, daysBetween,
} from './reminder-schedule';

/** The largest number of days any reminder may be set to (Sai: "ok with 60 days"). */
export const MAX_REMINDER_DAYS = 60;

export type DaysKey = 'lawyer' | 'closing' | 'condition' | 'listing_expiry';
export type AfterKey = 'after_status' | 'after_docs' | 'after_lawyer';
export const DAYS_KEYS: readonly DaysKey[] = ['lawyer', 'closing', 'condition', 'listing_expiry'];
export const AFTER_KEYS: readonly AfterKey[] = ['after_status', 'after_docs', 'after_lawyer'];

export interface DaysRule { on: boolean; days: number[] }
export interface AfterRule { on: boolean; first: number; every: number; until: number }

export interface ReminderRules {
  lawyer: DaysRule;
  closing: DaysRule;
  condition: DaysRule;
  listing_expiry: DaysRule;
  deposit: { on: boolean; days: number };
  commission: { on: boolean };
  after_status: AfterRule;
  after_docs: AfterRule;
  after_lawyer: AfterRule;
  /** YYYY-MM-DD. Deals closing before this day get no after-closing reminders. Null = not set yet. */
  after_closing_from: string | null;
}

const DEFAULT_DAYS: Record<DaysKey, readonly number[]> = {
  lawyer: LAWYER_REMINDER_DAYS,
  closing: CLOSING_REMINDER_DAYS,
  condition: CONDITION_REMINDER_DAYS,
  listing_expiry: EXPIRY_REMINDER_DAYS,
};
/** The smallest day each list may hold. A listing is expired ON its day, so 0 is not a reminder. */
const MIN_DAY: Record<DaysKey, number> = { lawyer: 0, closing: 0, condition: 0, listing_expiry: 1 };
export const DEFAULT_AFTER: AfterRule = { on: true, first: 1, every: 2, until: MAX_REMINDER_DAYS };

/** Plain names, for the audit trail and for error messages. */
export const RULE_LABEL: Record<DaysKey | AfterKey | 'deposit' | 'commission', string> = {
  lawyer: 'Lawyer-detail reminders',
  closing: 'Closing-date reminders',
  condition: 'Condition deadlines',
  listing_expiry: 'Listing expiry reminders',
  deposit: 'Deposit not recorded',
  commission: 'Commission received',
  after_status: 'After closing - status still Firm/Conditional',
  after_docs: 'After closing - required documents outstanding',
  after_lawyer: 'After closing - lawyer details missing',
};

/** Largest first: the order the days happen in, counting down to a date. */
const sortDays = (days: readonly number[]): number[] => [...days].sort((a, b) => b - a);

export function defaultRules(): ReminderRules {
  return {
    lawyer: { on: true, days: sortDays(LAWYER_REMINDER_DAYS) },
    closing: { on: true, days: sortDays(CLOSING_REMINDER_DAYS) },
    condition: { on: true, days: sortDays(CONDITION_REMINDER_DAYS) },
    listing_expiry: { on: true, days: sortDays(EXPIRY_REMINDER_DAYS) },
    deposit: { on: true, days: DEPOSIT_GRACE_DAYS },
    commission: { on: true },
    after_status: { ...DEFAULT_AFTER },
    after_docs: { ...DEFAULT_AFTER },
    after_lawyer: { ...DEFAULT_AFTER },
    after_closing_from: null,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const wholeIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/** The lawyer switch, as it has always been read: `lawyer_reminder_days` above zero, 3 when unset. */
export function lawyerOn(flags: Record<string, unknown>): boolean {
  const raw = Number(flags.lawyer_reminder_days);
  return (Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3) > 0;
}

/**
 * The rules in force, from the feature-flags object. Tolerant: anything missing or unreadable is the
 * default for that one reminder, so a hand-edited or half-written value never switches a reminder off.
 */
export function readRules(flags: Record<string, unknown>): ReminderRules {
  const out = defaultRules();
  const stored = isObj(flags.reminder_rules) ? flags.reminder_rules : {};

  for (const key of DAYS_KEYS) {
    const r = isObj(stored[key]) ? stored[key] : {};
    if (typeof r.on === 'boolean') out[key].on = r.on;
    if (Array.isArray(r.days)) {
      const days = r.days.map((d) => wholeIn(d, MIN_DAY[key], MAX_REMINDER_DAYS));
      if (days.length > 0 && days.every((d) => d !== null) && new Set(days).size === days.length) out[key].days = sortDays(days as number[]);
    }
  }
  out.lawyer.on = lawyerOn(flags);

  const dep = isObj(stored.deposit) ? stored.deposit : {};
  if (typeof dep.on === 'boolean') out.deposit.on = dep.on;
  const depDays = wholeIn(dep.days, 1, MAX_REMINDER_DAYS);
  if (depDays !== null) out.deposit.days = depDays;

  const com = isObj(stored.commission) ? stored.commission : {};
  if (typeof com.on === 'boolean') out.commission.on = com.on;

  for (const key of AFTER_KEYS) {
    const r = isObj(stored[key]) ? stored[key] : {};
    if (typeof r.on === 'boolean') out[key].on = r.on;
    const first = wholeIn(r.first, 1, MAX_REMINDER_DAYS);
    const every = wholeIn(r.every, 1, MAX_REMINDER_DAYS);
    const until = wholeIn(r.until, 1, MAX_REMINDER_DAYS);
    if (first !== null && every !== null && until !== null && first <= until) out[key] = { on: out[key].on, first, every, until };
  }

  const from = stored.after_closing_from;
  if (typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from)) out.after_closing_from = from;
  return out;
}

/**
 * Read a list of days typed on the Triggers screen ("30, 23, 15" or [30, 23, 15]).
 * Blank goes back to the default days. Returns the error to show instead when it cannot be used.
 */
function parseDays(key: DaysKey, raw: unknown): { days: number[] } | { error: string } {
  const lo = MIN_DAY[key];
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(/[\s,;]+/).filter((p) => p !== '').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  if (parts.length === 0) return { days: sortDays(DEFAULT_DAYS[key]) };
  const days: number[] = [];
  for (const p of parts) {
    const n = wholeIn(typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : p, lo, MAX_REMINDER_DAYS);
    if (n === null) return { error: `${RULE_LABEL[key]}: use whole numbers from ${lo} to ${MAX_REMINDER_DAYS}.` };
    if (days.includes(n)) return { error: `${RULE_LABEL[key]}: ${n} is there twice - give each day once.` };
    days.push(n);
  }
  return { days: sortDays(days) };
}

/** A whole number sent from the screen, as text or a number. Blank gives null. */
const numberIn = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? Number(s) : 'bad';
};

/**
 * Apply one save from the Triggers screen to the rules in force. Only the reminders named in the
 * body change. Returns the new rules, or every problem found so nothing is half-saved.
 */
export function applyRulesPatch(current: ReminderRules, body: Record<string, unknown>): { rules: ReminderRules } | { errors: string[] } {
  const next: ReminderRules = JSON.parse(JSON.stringify(current));
  const errors: string[] = [];
  const onOf = (key: string, v: unknown): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    errors.push(`${RULE_LABEL[key as keyof typeof RULE_LABEL]}: On/Off must be true or false.`);
    return undefined;
  };

  for (const key of DAYS_KEYS) {
    if (!isObj(body[key])) continue;
    const r = body[key] as Record<string, unknown>;
    const on = onOf(key, r.on);
    if (on !== undefined) next[key].on = on;
    if (r.days !== undefined) {
      const p = parseDays(key, r.days);
      if ('error' in p) errors.push(p.error); else next[key].days = p.days;
    }
  }

  if (isObj(body.deposit)) {
    const r = body.deposit;
    const on = onOf('deposit', r.on);
    if (on !== undefined) next.deposit.on = on;
    if (r.days !== undefined) {
      const n = numberIn(r.days);
      if (n === null) next.deposit.days = DEPOSIT_GRACE_DAYS;
      else if (n === 'bad' || n < 1 || n > MAX_REMINDER_DAYS) errors.push(`${RULE_LABEL.deposit}: one whole number from 1 to ${MAX_REMINDER_DAYS}.`);
      else next.deposit.days = n;
    }
  }

  if (isObj(body.commission)) {
    const on = onOf('commission', body.commission.on);
    if (on !== undefined) next.commission.on = on;
  }

  for (const key of AFTER_KEYS) {
    if (!isObj(body[key])) continue;
    const r = body[key] as Record<string, unknown>;
    const on = onOf(key, r.on);
    if (on !== undefined) next[key].on = on;
    const fields: ('first' | 'every' | 'until')[] = ['first', 'every', 'until'];
    for (const f of fields) {
      if (r[f] === undefined) continue;
      const n = numberIn(r[f]);
      if (n === null) next[key][f] = DEFAULT_AFTER[f];
      else if (n === 'bad' || n < 1 || n > MAX_REMINDER_DAYS) errors.push(`${RULE_LABEL[key]}: use whole numbers from 1 to ${MAX_REMINDER_DAYS}.`);
      else next[key][f] = n;
    }
    if (next[key].first > next[key].until) errors.push(`${RULE_LABEL[key]}: the first reminder must come before the last day.`);
  }

  return errors.length ? { errors: [...new Set(errors)] } : { rules: next };
}

/** What is stored: everything except the lawyer switch, which lives in `lawyer_reminder_days`. */
export function storedForm(rules: ReminderRules): Record<string, unknown> {
  const { lawyer, ...rest } = rules;
  return { ...rest, lawyer: { days: lawyer.days } };
}

/** One rule as a sentence for the audit trail: "On - 30, 23, 15". */
export function describeRule(rules: ReminderRules, key: keyof typeof RULE_LABEL): string {
  const state = (on: boolean) => (on ? 'On' : 'Off');
  if (key === 'commission') return state(rules.commission.on);
  if (key === 'deposit') return `${state(rules.deposit.on)} - ${rules.deposit.days} days after the offer`;
  if ((AFTER_KEYS as readonly string[]).includes(key)) {
    const r = rules[key as AfterKey];
    return `${state(r.on)} - day ${r.first} after closing, then every ${r.every} days, up to day ${r.until}`;
  }
  const r = rules[key as DaysKey];
  return `${state(r.on)} - ${r.days.join(', ')}`;
}

/**
 * Whether an after-closing reminder is due today for a deal that closed on `closing`: on the first
 * day, then every `every` days, up to and including `until`. Never on or before the closing day.
 */
export function afterClosingDue(today: Date, closing: Date, rule: AfterRule): { due: boolean; daysAfter: number } {
  const daysAfter = daysBetween(closing, today);
  const due = daysAfter >= rule.first && daysAfter <= rule.until && (daysAfter - rule.first) % rule.every === 0;
  return { due, daysAfter };
}
