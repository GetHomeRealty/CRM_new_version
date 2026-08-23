/**
 * Age from a date of birth.
 *
 * WHY A SHARED FUNCTION RATHER THAN A LINE AT EACH CALL SITE. Three places need this answer — the
 * editor as somebody types, the write path so an imported or API-created lead is consistent, and
 * the read path so the number does not rot — and "years between two dates" is exactly the
 * calculation that gets written subtly differently each time. `(now - dob) / 31_557_600_000` is the
 * usual shortcut and it is wrong for anybody whose birthday is today or tomorrow.
 *
 * THE BIRTHDAY HAS TO HAVE HAPPENED. Age is completed years, so it steps up on the birthday and not
 * a day earlier: someone born on 30 December is 20 until that date and 21 on it. Comparing month
 * and day is what gets that right; dividing by an average year length does not.
 *
 * UTC ON BOTH SIDES, deliberately. `date_of_birth` is a `@db.Date` — a calendar day with no time and
 * no zone — so reading it in the server's local zone can shift it by a day and change the answer for
 * anyone born on the 1st or the 31st. The comparison is done entirely in UTC parts.
 */
/*
 * `unknown` rather than `Date | string`, because the callers genuinely hold both and one of them —
 * the row the presenter maps — carries it loosely typed. Narrowing here keeps the casts out of the
 * call sites, and a value that is neither a date nor a date-shaped string answers `null` rather
 * than throwing on a lead somebody imported with a malformed birthday.
 */
export function ageFromDateOfBirth(dob: unknown, now: Date = new Date()): number | null {
  if (dob === null || dob === undefined || dob === '') return null;
  if (!(dob instanceof Date) && typeof dob !== 'string') return null;

  const d = dob instanceof Date ? dob : new Date(`${dob.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;

  const y = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  const dayDiff = now.getUTCDate() - d.getUTCDate();
  // Not yet had this year's birthday → one fewer completed year.
  const age = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? y - 1 : y;

  /*
   * A DATE THAT CANNOT PRODUCE A SENSIBLE AGE PRODUCES NONE.
   *
   * A future date of birth (a typo — 2062 for 2026) would give a negative age, and a date centuries
   * back would give a number the `age` column's own validation rejects. Answering `null` leaves the
   * field empty rather than writing a value the same form would refuse if it were typed by hand.
   */
  if (age < 0 || age > 120) return null;
  return age;
}
