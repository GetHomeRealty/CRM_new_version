import {
  EXPIRY_WINDOW_DAYS, LAWYER_WINDOW_DAYS,
  closingPhrase, daysBetween, expiryPhrase, expiryReminderFor, hasExpired,
  lawyerReminderFor, lawyerVariant, startOfDay,
} from './reminder-schedule';

/**
 * The reminder arithmetic, walked day by day.
 *
 * A schedule is the kind of thing that is tested with two hand-picked dates and is wrong on the
 * third, so these walk EVERY day of each run-up and assert the whole sequence: the ten expiry
 * countdowns, the boundaries at 30, 16, 15, 8, 7 and 0, and the weekday cadence inside each phase.
 * That is also what makes the daylight-saving cases land — a March run-up is included on purpose.
 */

/** A local-midnight date, the unit the schedule works in. */
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);
const plusDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

describe('counting days', () => {
  it('counts calendar days, not elapsed hours', () => {
    expect(daysBetween(day(2026, 8, 21), day(2026, 8, 31))).toBe(10);
    expect(daysBetween(day(2026, 8, 31), day(2026, 8, 31))).toBe(0);
    expect(daysBetween(day(2026, 9, 1), day(2026, 8, 31))).toBe(-1);
  });

  it('is unmoved by the time of day', () => {
    const morning = new Date(2026, 7, 21, 6, 30);
    const night = new Date(2026, 7, 21, 23, 45);
    expect(daysBetween(morning, day(2026, 8, 31))).toBe(daysBetween(night, day(2026, 8, 31)));
  });

  it('survives the spring-forward weekend, where an hours-based subtraction loses a day', () => {
    // Ontario moves the clocks on the second Sunday in March; 2026 is the 8th.
    expect(daysBetween(day(2026, 3, 6), day(2026, 3, 16))).toBe(10);
    expect(daysBetween(day(2026, 3, 7), day(2026, 3, 14))).toBe(7);
  });
});

describe('listing expiry countdown', () => {
  const expiry = day(2026, 8, 31);

  it('says nothing until ten days out', () => {
    for (let d = 11; d <= 20; d++) {
      expect(expiryReminderFor(plusDays(expiry, -d), expiry).due).toBe(false);
    }
  });

  it('chases every day from ten down to one, with the right number each time', () => {
    const seen: number[] = [];
    for (let d = EXPIRY_WINDOW_DAYS; d >= 1; d--) {
      const { due, daysRemaining } = expiryReminderFor(plusDays(expiry, -d), expiry);
      expect(due).toBe(true);
      seen.push(daysRemaining);
    }
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('stops on the day itself and after — the auto-expiry pass owns that morning', () => {
    expect(expiryReminderFor(expiry, expiry).due).toBe(false);
    expect(expiryReminderFor(plusDays(expiry, 1), expiry).due).toBe(false);
  });

  it('words the last two days the way a person would', () => {
    expect(expiryPhrase(10)).toBe('will expire in 10 days');
    expect(expiryPhrase(2)).toBe('will expire in 2 days');
    expect(expiryPhrase(1)).toBe('will expire tomorrow');
    expect(expiryPhrase(0)).toBe('has expired');
  });

  it('is expired only once the day has passed', () => {
    expect(hasExpired(plusDays(expiry, -1), expiry)).toBe(false);
    // The listing is live for the whole of its expiry day.
    expect(hasExpired(expiry, expiry)).toBe(false);
    expect(hasExpired(plusDays(expiry, 1), expiry)).toBe(true);
  });
});

describe('lawyer-detail phases', () => {
  // A Friday close, so the run-up covers every weekday in each phase.
  const closing = day(2026, 9, 25);

  /** Which days inside a span are due, as day-counts remaining. */
  const dueDays = (fromDaysOut: number, toDaysOut: number): number[] => {
    const out: number[] = [];
    for (let d = fromDaysOut; d >= toDaysOut; d--) {
      if (lawyerReminderFor(plusDays(closing, -d), closing).due) out.push(d);
    }
    return out;
  };

  it('says nothing before thirty days out', () => {
    for (let d = 31; d <= 45; d++) {
      expect(lawyerReminderFor(plusDays(closing, -d), closing).due).toBe(false);
    }
  });

  it('chases once a week between 30 and 16 days out', () => {
    const due = dueDays(LAWYER_WINDOW_DAYS, 16);
    // Fifteen days is a fortnight and a day: two Mondays.
    expect(due).toHaveLength(2);
    for (const d of due) expect(plusDays(closing, -d).getDay()).toBe(1);
    for (const d of due) expect(lawyerReminderFor(plusDays(closing, -d), closing).perWeek).toBe(1);
  });

  it('chases twice a week between 15 and 8 days out, on a Monday and a Thursday', () => {
    const due = dueDays(15, 8);
    expect(due.length).toBeGreaterThanOrEqual(2);
    for (const d of due) expect([1, 4]).toContain(plusDays(closing, -d).getDay());
    for (const d of due) expect(lawyerReminderFor(plusDays(closing, -d), closing).perWeek).toBe(2);
  });

  it('chases three times a week in the last seven days', () => {
    const due = dueDays(7, 0);
    expect(due.length).toBeGreaterThanOrEqual(3);
    for (const d of due) expect([1, 3, 5]).toContain(plusDays(closing, -d).getDay());
    for (const d of due) expect(lawyerReminderFor(plusDays(closing, -d), closing).perWeek).toBe(3);
  });

  it('never chases on a weekend, in any phase', () => {
    for (let d = LAWYER_WINDOW_DAYS; d >= 0; d--) {
      const date = plusDays(closing, -d);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      if (weekend) expect(lawyerReminderFor(date, closing).due).toBe(false);
    }
  });

  it('stops once the closing date has passed', () => {
    for (let d = 1; d <= 10; d++) {
      expect(lawyerReminderFor(plusDays(closing, d), closing).due).toBe(false);
    }
  });

  it('gets busier as the date approaches — the whole point of the phases', () => {
    const early = dueDays(30, 16).length;
    const middle = dueDays(15, 8).length;
    const late = dueDays(7, 0).length;
    // Per week: 1, then 2, then 3, over spans of 15, 8 and 8 days.
    expect(early / 15).toBeLessThan(middle / 8);
    expect(middle / 8).toBeLessThan(late / 8);
  });

  it('words the last two days the way a person would', () => {
    expect(closingPhrase(9)).toBe('closing in 9 days');
    expect(closingPhrase(1)).toBe('closing tomorrow');
    expect(closingPhrase(0)).toBe('closing today');
  });
});

describe('which reminder to send', () => {
  it('names what is actually missing, and nothing when both are there', () => {
    expect(lawyerVariant(['buyer', 'seller'])).toBe('both');
    expect(lawyerVariant(['buyer'])).toBe('buyer');
    expect(lawyerVariant(['seller'])).toBe('seller');
    // The stop condition: no variant means no reminder exists to send.
    expect(lawyerVariant([])).toBeNull();
  });
});

describe('midnight', () => {
  it('reduces any instant to the day it falls in', () => {
    const d = startOfDay(new Date(2026, 7, 21, 17, 42, 9));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 7, 21, 0, 0]);
  });
});
