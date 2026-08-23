/**
 * Age from a date of birth, for filling the field in as somebody types.
 *
 * A DELIBERATE SECOND COPY of `server/src/leads/age.ts`, and the only kind this codebase should
 * have: the client and the server share no build, so the alternative is an HTTP round trip to
 * learn a number the browser already has everything it needs to work out. The rule it implements —
 * completed years, stepping up on the birthday — is small, stable and specified by the calendar
 * rather than by this product, so the two copies have nothing to drift about.
 *
 * The server is still the authority. It derives the age on save and again on read, so a lead
 * created by the CSV import, the Meta sync or the API is treated exactly like one typed in here.
 * This copy exists so the form does not sit showing a stale age until the response comes back.
 *
 * UTC throughout, because `date_of_birth` is a calendar day with no zone: reading "2002-04-13" in a
 * browser west of Greenwich would otherwise land on the 12th and answer a year early every April.
 */
export function ageFromDateOfBirth(dob: string | null | undefined, now: Date = new Date()): number | null {
  const iso = (dob ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;

  const d = new Date(`${iso}T00:00:00.000Z`);
  // `new Date('2026-02-30')` rolls over to March rather than failing, so the round trip is checked.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;

  const years = now.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - d.getUTCMonth();
  const dayDiff = now.getUTCDate() - d.getUTCDate();
  // The birthday must have happened: 20 until the day itself, 21 on it.
  const age = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? years - 1 : years;

  // A future or absurd date fills nothing in, rather than writing a value the form would reject.
  return age < 0 || age > 120 ? null : age;
}
