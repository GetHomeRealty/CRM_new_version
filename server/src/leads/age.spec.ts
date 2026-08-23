import { ageFromDateOfBirth } from './age';

/**
 * Age from a date of birth.
 *
 * The reason this has a test file at all is that the obvious implementation is wrong. Dividing the
 * millisecond difference by an average year — `(now - dob) / 31_557_600_000` — is the shortcut
 * everybody reaches for, and it is off by one for anybody whose birthday is today, tomorrow, or
 * sitting near a leap day. Age is COMPLETED YEARS, so it steps up on the birthday and not a moment
 * before, and the only way to get that right is to compare the calendar parts.
 *
 * `now` is injected throughout: a test that computed today's date would pass in August and start
 * failing in December, which is the kind of test that gets deleted rather than fixed.
 */

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('age from a date of birth', () => {
  it('counts completed years', () => {
    expect(ageFromDateOfBirth('2002-04-13', at('2026-08-22'))).toBe(24);
  });

  describe('the birthday itself', () => {
    it('is still the younger age the day before', () => {
      expect(ageFromDateOfBirth('2000-06-15', at('2026-06-14'))).toBe(25);
    });

    it('steps up ON the birthday', () => {
      expect(ageFromDateOfBirth('2000-06-15', at('2026-06-15'))).toBe(26);
    });

    it('and stays there the day after', () => {
      expect(ageFromDateOfBirth('2000-06-15', at('2026-06-16'))).toBe(26);
    });
  });

  describe('boundaries the millisecond shortcut gets wrong', () => {
    it('a birthday later this month has not happened yet', () => {
      // The day before a 31 December birthday is still the younger age — the case a
      // milliseconds-divided-by-an-average-year calculation rounds the wrong way.
      expect(ageFromDateOfBirth('1990-12-31', at('2026-12-30'))).toBe(35);
    });

    it('the last day of the year', () => {
      expect(ageFromDateOfBirth('1990-12-31', at('2026-12-31'))).toBe(36);
    });

    it('the first day of the year', () => {
      expect(ageFromDateOfBirth('1991-01-01', at('2026-01-01'))).toBe(35);
    });

    it('a 29 February birthday, in a non-leap year, before 1 March', () => {
      // Not yet had a birthday this year — 28 February is still the younger age.
      expect(ageFromDateOfBirth('2004-02-29', at('2026-02-28'))).toBe(21);
    });

    it('a 29 February birthday, in a non-leap year, on 1 March', () => {
      expect(ageFromDateOfBirth('2004-02-29', at('2026-03-01'))).toBe(22);
    });

    it('a newborn is 0, not 1', () => {
      expect(ageFromDateOfBirth('2026-08-01', at('2026-08-22'))).toBe(0);
    });

    it('exactly one year old', () => {
      expect(ageFromDateOfBirth('2025-08-22', at('2026-08-22'))).toBe(1);
    });
  });

  describe('values that cannot produce a sensible age produce none', () => {
    it('a future date of birth', () => {
      // A typo — 2062 for 2026 — must leave the field empty rather than store a negative age.
      expect(ageFromDateOfBirth('2062-01-01', at('2026-08-22'))).toBeNull();
    });

    it('a date centuries back, which the age column would refuse anyway', () => {
      expect(ageFromDateOfBirth('1800-01-01', at('2026-08-22'))).toBeNull();
    });

    it('null, undefined and empty', () => {
      expect(ageFromDateOfBirth(null)).toBeNull();
      expect(ageFromDateOfBirth(undefined)).toBeNull();
      expect(ageFromDateOfBirth('')).toBeNull();
    });

    it('nonsense rather than a date', () => {
      expect(ageFromDateOfBirth('not a date')).toBeNull();
      expect(ageFromDateOfBirth(12345)).toBeNull();
      expect(ageFromDateOfBirth({})).toBeNull();
    });
  });

  describe('timezone', () => {
    it('reads the stored calendar day in UTC, so a 1st or 31st does not shift', () => {
      /*
       * `date_of_birth` is a `@db.Date` — a day with no time and no zone. Reading it in the
       * server's local zone can move it across midnight and change the answer for anybody born on
       * the first or last day of a month.
       */
      expect(ageFromDateOfBirth(new Date('2000-01-01T00:00:00.000Z'), at('2026-01-01'))).toBe(26);
      expect(ageFromDateOfBirth(new Date('2000-01-31T00:00:00.000Z'), at('2026-01-30'))).toBe(25);
    });

    it('accepts a Date and an ISO string identically', () => {
      const asDate = ageFromDateOfBirth(new Date('2002-04-13T00:00:00.000Z'), at('2026-08-22'));
      const asText = ageFromDateOfBirth('2002-04-13', at('2026-08-22'));
      expect(asDate).toBe(asText);
      expect(asDate).toBe(24);
    });

    it('ignores a time component on a stored timestamp', () => {
      expect(ageFromDateOfBirth('2002-04-13T23:59:59.000Z', at('2026-08-22'))).toBe(24);
    });
  });
});
