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

describe('lawyer-detail reminder days (Sai, 29 Oct 2026)', () => {
  const closing = day(2026, 9, 25);
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

  it('chases on 30, 23, 15, 11, 7, 5, 3, 1 days out and on the closing day - and only then', () => {
    expect(dueDays(LAWYER_WINDOW_DAYS, 0)).toEqual([30, 23, 15, 11, 7, 5, 3, 1, 0]);
  });

  it('is twice in the first fortnight, twice in the third week, every other day in the last week', () => {
    expect(dueDays(30, 16)).toEqual([30, 23]);
    expect(dueDays(15, 8)).toEqual([15, 11]);
    expect(dueDays(7, 1)).toEqual([7, 5, 3, 1]);
  });

  it('counts from the closing date, weekends included', () => {
    const sat = day(2026, 10, 31); // a Saturday closing - its 7-days-out reminder falls on a Saturday
    expect(plusDays(sat, -7).getDay()).toBe(6);
    expect(lawyerReminderFor(plusDays(sat, -7), sat).due).toBe(true);
  });

  it('stops once the closing date has passed', () => {
    for (let d = 1; d <= 10; d++) {
      expect(lawyerReminderFor(plusDays(closing, d), closing).due).toBe(false);
    }
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
