/**
 * Working out the dates a recurring appointment falls on.
 *
 * Deliberately a pure function over plain values: no Prisma, no service, no clock. Recurrence is
 * all date arithmetic and date arithmetic is where the bugs live — month ends, leap days, the
 * 31st in a 30-day month — so it is worth being able to test every one of those without a database
 * anywhere near it.
 *
 * NOT a full RRULE implementation, and not pretending to be. Three frequencies with an interval,
 * ended by a date or a count, which is what a brokerage schedules: a weekly team meeting, a
 * fortnightly review, a Saturday open house, a monthly check-in. BYDAY lists, "last Friday",
 * "third Tuesday" and the rest of RFC 5545 are absent on purpose — half an RRULE parser is worse
 * than none, because it accepts rules it then gets wrong.
 */

export const RECUR_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type RecurFreq = (typeof RECUR_FREQUENCIES)[number];

export const isRecurFreq = (v: unknown): v is RecurFreq =>
  (RECUR_FREQUENCIES as readonly string[]).includes(String(v));

/**
 * The ceiling on one series.
 *
 * An open-ended weekly meeting would otherwise generate rows for ever. 200 is roughly four years
 * of weekly, eight months of daily, or sixteen years of monthly — past any horizon somebody is
 * actually planning to — and it bounds the write, the reminder sweep and the Google push all at
 * once. A series that reaches it simply stops; it is not an error, and the user is told.
 */
export const RECURRENCE_MAX_OCCURRENCES = 200;

/** How far ahead an end-less rule will generate, when no count is given either. */
export const RECURRENCE_HORIZON_DAYS = 730;

export interface RecurrenceRule {
  freq: RecurFreq;
  /** Every N days/weeks/months. Below 1 is treated as 1. */
  interval?: number | null;
  /** Last permitted day, as yyyy-mm-dd. */
  until?: string | null;
  /** Total occurrences including the first. */
  count?: number | null;
}

/** yyyy-mm-dd for a UTC-midnight Date — the shape `@db.Date` columns are written with. */
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** A UTC-midnight Date from yyyy-mm-dd, so a day never shifts across a timezone. */
export const toUtcDay = (v: string): Date => new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);

/**
 * Add months without letting a date roll into the following one.
 *
 * `new Date(2026, 0, 31)` plus one month is 2 March in plain arithmetic, because February has no
 * 31st and JavaScript silently overflows. A monthly appointment on the 31st should land on the
 * last day of a shorter month, not skip into the next — so the day is clamped.
 */
function addMonthsClamped(start: Date, months: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const day = start.getUTCDate();
  // Day 0 of the following month is the last day of the one we want.
  const lastOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastOfTarget)));
}

export interface ExpansionResult {
  /** Every day the series falls on, the first included, as yyyy-mm-dd. */
  dates: string[];
  /** True when generation stopped at the ceiling rather than at the rule's own end. */
  truncated: boolean;
}

/**
 * Every date a rule produces, starting at `startDate`.
 *
 * The first occurrence is always included: a rule describes the appointment you are creating, not
 * a set of extra ones after it. `count: 4` therefore means four appointments in total, which is
 * what someone typing "4" means.
 */
export function expandRecurrence(startDate: string, rule: RecurrenceRule): ExpansionResult {
  const start = toUtcDay(startDate);
  if (Number.isNaN(start.getTime())) return { dates: [], truncated: false };

  const interval = Math.max(1, Math.floor(Number(rule.interval ?? 1) || 1));
  const until = rule.until ? toUtcDay(rule.until) : null;
  const count = rule.count != null && Number.isFinite(Number(rule.count)) ? Math.floor(Number(rule.count)) : null;

  // With neither an end date nor a count, stop at the horizon rather than the ceiling — two years
  // of a daily meeting is 730 rows, and the ceiling would cut it off mid-way with no explanation.
  const horizon = new Date(start.getTime() + RECURRENCE_HORIZON_DAYS * 86400000);
  const lastAllowedDay = until ?? (count == null ? horizon : null);

  const dates: string[] = [];
  let truncated = false;

  for (let i = 0; ; i += 1) {
    if (dates.length >= RECURRENCE_MAX_OCCURRENCES) { truncated = true; break; }
    if (count != null && dates.length >= count) break;

    let next: Date;
    if (rule.freq === 'daily') next = new Date(start.getTime() + i * interval * 86400000);
    else if (rule.freq === 'weekly') next = new Date(start.getTime() + i * interval * 7 * 86400000);
    else next = addMonthsClamped(start, i * interval);

    if (lastAllowedDay && next.getTime() > lastAllowedDay.getTime()) break;
    dates.push(ymd(next));

    // A count with no end date still needs a stop, in case the count is absurd.
    if (count == null && !lastAllowedDay && dates.length >= RECURRENCE_MAX_OCCURRENCES) { truncated = true; break; }
  }

  return { dates, truncated };
}

/** How the rule reads to a person — used in the message after a series is created. */
export function describeRecurrence(rule: RecurrenceRule, occurrences: number): string {
  const n = Math.max(1, Math.floor(Number(rule.interval ?? 1) || 1));
  const every = rule.freq === 'daily' ? (n === 1 ? 'every day' : `every ${n} days`)
    : rule.freq === 'weekly' ? (n === 1 ? 'every week' : `every ${n} weeks`)
    : (n === 1 ? 'every month' : `every ${n} months`);
  return `${occurrences} appointment${occurrences === 1 ? '' : 's'}, ${every}`;
}
