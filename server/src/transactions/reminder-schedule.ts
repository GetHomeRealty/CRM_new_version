/**
 * When a reminder is due — the arithmetic, with nothing else in it.
 *
 * Kept as pure functions over dates rather than methods on a service so the schedule can be tested
 * on its own, exhaustively and instantly, for every day of a run-up rather than for the two or three
 * a service test would bother to set up. Everything that talks to the database, sends mail or writes
 * an audit row lives elsewhere and calls in here for the answer.
 *
 * All comparisons are made on CALENDAR DAYS in the server's local zone, never on elapsed hours. "Ten
 * days before the 31st" is the 21st whatever the clock says, and an hours-based subtraction gets
 * that wrong twice a year at the daylight-saving boundary.
 */

/** Midnight local on the day this instant falls in — the unit every comparison here is made in. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The calendar day a `@db.Date` column means.
 *
 * Postgres DATE columns carry no zone, and the driver hands them back as midnight UTC. Read with
 * local getters west of Greenwich that is the PREVIOUS evening — so a listing expiring on the 31st
 * reads as the 30th, and every reminder in the countdown fires a day early. The date parts have to
 * be taken in UTC and re-made as a local day, which is what this does.
 *
 * Use it on anything read from `closing_date` or `listing_expiry_date`; use `dbDay` in the other
 * direction.
 */
export function calendarDay(d: Date): Date {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A local calendar day as the instant a `@db.Date` column stores and compares against. */
export function dbDay(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** Whole calendar days from `from` to `to`. Negative once `to` is in the past. */
export function daysBetween(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  // Rounded, not truncated: an hour of DST drift inside the span must not cost a whole day.
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------- listing expiry

/** The first countdown message goes out this many days before expiry. */
export const EXPIRY_WINDOW_DAYS = 10;

/**
 * Whether a listing expiring on `expiry` should be chased today, and with what number.
 *
 * Ten down to one. Zero is the expiry day itself, which is handled by the auto-expire pass instead —
 * telling somebody their listing expires "in 0 days" on the morning it is being expired is a message
 * that arrives too late to act on and reads like a fault.
 */
export function expiryReminderFor(today: Date, expiry: Date): { due: boolean; daysRemaining: number } {
  const daysRemaining = daysBetween(today, expiry);
  return { due: daysRemaining >= 1 && daysRemaining <= EXPIRY_WINDOW_DAYS, daysRemaining };
}

/** "expires tomorrow" reads better than "expires in 1 day", and is the wording people expect. */
export function expiryPhrase(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'has expired';
  if (daysRemaining === 1) return 'will expire tomorrow';
  return `will expire in ${daysRemaining} days`;
}

/** A listing is past its date once the expiry day itself has gone by. */
export function hasExpired(today: Date, expiry: Date): boolean {
  return daysBetween(today, expiry) < 0;
}

// ---------------------------------------------------------------- closing & condition deadlines

/**
 * TD-009 — the two dates a deal keeps that nothing was watching.
 *
 * The sweep already chased a listing towards its expiry and an agent for lawyer details. A CLOSING
 * DATE raised nothing of its own — it was read only to decide how hard to chase for a lawyer — and a
 * CONDITION DEADLINE raised nothing at all, though it is the date with the shortest fuse on the
 * whole deal: a financing condition that lapses unsatisfied can cost the buyer the deposit.
 *
 * THE WINDOWS ARE THE ONES ALREADY IN THE BUILDING. Ten days for closing is the listing-expiry
 * run-up, because both are "this deal reaches its date soon" and a brokerage should not have to
 * learn two cadences. Seven for a condition is deliberately shorter: conditions are written in days
 * from the offer, not months, so a fortnight of chasing would be noise before it was ever useful.
 */
export const CLOSING_WINDOW_DAYS = 10;
export const CONDITION_WINDOW_DAYS = 7;

/**
 * Whether a deal closing on `closing` should be announced today, and with what number.
 *
 * INCLUDES THE DAY ITSELF, unlike the listing-expiry countdown. That one stops at one day out
 * because the auto-expiry pass acts on the day and a message saying "expires in 0 days" arrives
 * after the fact. Nothing acts on a closing date, so the morning of a closing is precisely when
 * somebody wants to be told about it.
 */
export function closingReminderFor(today: Date, closing: Date): { due: boolean; daysRemaining: number } {
  const daysRemaining = daysBetween(today, closing);
  return { due: daysRemaining >= 0 && daysRemaining <= CLOSING_WINDOW_DAYS, daysRemaining };
}

/** Whether a condition due on `deadline` should be chased today. The deadline day counts. */
export function conditionReminderFor(today: Date, deadline: Date): { due: boolean; daysRemaining: number } {
  const daysRemaining = daysBetween(today, deadline);
  return { due: daysRemaining >= 0 && daysRemaining <= CONDITION_WINDOW_DAYS, daysRemaining };
}

/** "due today" / "due tomorrow" — the same reason closingPhrase exists. */
export function deadlinePhrase(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'due today';
  if (daysRemaining === 1) return 'due tomorrow';
  return `due in ${daysRemaining} days`;
}

// ---------------------------------------------------------------- lawyer details

/**
 * The three phases of the run-up to closing, and how often each chases.
 *
 * Frequency is expressed as the weekdays it falls on rather than as "every N days", because a
 * cadence counted in days drifts across the week and lands on a Sunday sooner or later. Anchoring to
 * weekdays keeps the reminders evenly spaced AND on working days, which is what makes them useful.
 *
 * 0 is Sunday in JavaScript's own numbering: 1 Mon, 3 Wed, 4 Thu, 5 Fri.
 */
export const LAWYER_PHASES = [
  { from: 30, to: 16, perWeek: 1, weekdays: [1] },          // Monday
  { from: 15, to: 8, perWeek: 2, weekdays: [1, 4] },        // Monday, Thursday
  { from: 7, to: 0, perWeek: 3, weekdays: [1, 3, 5] },      // Monday, Wednesday, Friday
] as const;

export const LAWYER_WINDOW_DAYS = 30;

export interface LawyerDue {
  due: boolean;
  daysRemaining: number;
  /** 1, 2 or 3 — what the phase promises, for the audit line and the history. */
  perWeek: number | null;
}

/**
 * Whether a deal closing on `closing` should be chased for lawyer details today.
 *
 * Outside thirty days: nothing. Past the closing date: nothing either — a reminder to prepare for
 * something that has already happened is noise, and the deal has bigger problems by then.
 */
export function lawyerReminderFor(today: Date, closing: Date): LawyerDue {
  const daysRemaining = daysBetween(today, closing);
  if (daysRemaining < 0 || daysRemaining > LAWYER_WINDOW_DAYS) {
    return { due: false, daysRemaining, perWeek: null };
  }
  const phase = LAWYER_PHASES.find((p) => daysRemaining <= p.from && daysRemaining >= p.to);
  if (!phase) return { due: false, daysRemaining, perWeek: null };
  return {
    due: (phase.weekdays as readonly number[]).includes(startOfDay(today).getDay()),
    daysRemaining,
    perWeek: phase.perWeek,
  };
}

/** "closing tomorrow" / "closing today" read better than a bare number at the sharp end. */
export function closingPhrase(daysRemaining: number): string {
  if (daysRemaining <= 0) return 'closing today';
  if (daysRemaining === 1) return 'closing tomorrow';
  return `closing in ${daysRemaining} days`;
}

/** The subject and body wording each combination of missing details calls for. */
export function lawyerVariant(missing: readonly string[]): 'buyer' | 'seller' | 'both' | null {
  const buyer = missing.includes('buyer');
  const seller = missing.includes('seller');
  if (buyer && seller) return 'both';
  if (buyer) return 'buyer';
  if (seller) return 'seller';
  return null;
}

/** The mail event each variant is sent through, so the office can word all three differently. */
export const LAWYER_TEMPLATE: Record<'buyer' | 'seller' | 'both', string> = {
  buyer: 'transaction.lawyer_buyer_reminder',
  seller: 'transaction.lawyer_seller_reminder',
  both: 'transaction.lawyer_both_reminder',
};
