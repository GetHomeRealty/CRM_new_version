import type { Market } from './market';

/**
 * EXPIRY REMINDER RULES (Sai, 19 Oct 2026) - one rule for every expiry the app chases: company
 * documents, India builder agreements and RERA registrations.
 *
 *   - from 15 days before the expiry date, an email every 2 days;
 *   - always on the day before, and always on the expiry day itself;
 *   - after the expiry, if not renewed, still every 2 days for as long as it stays so;
 *   - it stops when a new expiry date is entered (the caller clears the reminder dates) or a new
 *     file is uploaded after this expiry's first reminder;
 *   - at 9:00 in the morning of the country's own time, the days counted by the country's own date.
 */
export const WINDOW_DAYS = 15;
export const EVERY_DAYS = 2;
export const SEND_HOUR = 9;
export const TIME_ZONE: Record<Market, string> = { CA: 'America/Toronto', IN: 'Asia/Kolkata' };

/** A moment as that country's calendar date (UTC midnight of it) and hour. */
export function localDay(at: Date, market: Market): { day: Date; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE[market], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { day: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`), hour: Number(parts.hour) };
}

/** Whole calendar days from `today` to `expiry` (negative once past). */
export function daysUntil(expiry: Date | null | undefined, today: Date): number | null {
  if (!expiry) return null;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((expiry.getTime() - t) / 86_400_000);
}

export interface ExpiryReminderState {
  expiry_date: Date | null;
  /** When this expiry's first reminder went out (null = none yet). */
  reminder_started_at?: Date | null;
  last_reminder_at: Date | null;
  /** The newest file's upload time, if the record has files. */
  latest_file_at?: Date | null;
}

/** Is a reminder due on this country-date (`today` = that country's date at UTC midnight)? */
export function expiryReminderDue(s: ExpiryReminderState, today: Date, market: Market): boolean {
  const left = daysUntil(s.expiry_date, today);
  if (left === null || left > WINDOW_DAYS) return false;
  // Renewed by a new file uploaded after this expiry's reminders began.
  if (s.reminder_started_at && s.latest_file_at && s.latest_file_at > s.reminder_started_at) return false;
  if (!s.last_reminder_at) return true;
  const since = Math.round((today.getTime() - localDay(s.last_reminder_at, market).day.getTime()) / 86_400_000);
  if (since <= 0) return false; // never twice on one day
  if (left === 1 || left === 0) return true; // the day before, and the day itself - always
  return since >= EVERY_DAYS;
}

/** "expires in 3 days" / "expires TODAY" / "EXPIRED 2 days ago", for subjects and bodies. */
export function expiryState(left: number): string {
  if (left < 0) return `EXPIRED ${-left} day${left === -1 ? '' : 's'} ago`;
  if (left === 0) return 'expires TODAY';
  return `expires in ${left} day${left === 1 ? '' : 's'}`;
}

export const REMINDER_FOOTNOTE = `From ${WINDOW_DAYS} days before expiry this reminder comes every ${EVERY_DAYS} days,`
  + ' always on the day before and on the day itself, and after the expiry until it is renewed.';
