import {
  RECURRENCE_MAX_OCCURRENCES, describeRecurrence, expandRecurrence, isRecurFreq,
} from './recurrence';

/**
 * The date arithmetic behind a recurring appointment.
 *
 * No database here on purpose — every one of these is a calendar question, and the answers that go
 * wrong in practice are month ends, leap days and off-by-one on the count. Those are all provable
 * in isolation, so they are.
 */

describe('how often it repeats', () => {
  it('includes the appointment you are creating as the first occurrence', () => {
    // "4 times" means four appointments, not one plus four.
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', count: 4 });
    expect(dates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23']);
  });

  it('repeats daily', () => {
    const { dates } = expandRecurrence('2026-03-30', { freq: 'daily', count: 4 });
    expect(dates).toEqual(['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
  });

  it('honours an interval', () => {
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', interval: 2, count: 3 });
    expect(dates).toEqual(['2026-03-02', '2026-03-16', '2026-03-30']);
  });

  it('repeats monthly on the same day', () => {
    const { dates } = expandRecurrence('2026-01-15', { freq: 'monthly', count: 3 });
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('treats a missing or nonsense interval as one', () => {
    expect(expandRecurrence('2026-03-02', { freq: 'daily', interval: 0, count: 3 }).dates)
      .toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(expandRecurrence('2026-03-02', { freq: 'daily', interval: null, count: 2 }).dates)
      .toEqual(['2026-03-02', '2026-03-03']);
  });
});

describe('month ends, where this normally goes wrong', () => {
  it('keeps a monthly appointment on the 31st inside each month', () => {
    // Plain date arithmetic turns 31 January + 1 month into 2 or 3 March. A monthly viewing booked
    // on the 31st belongs on the last day of a shorter month, not in the next one.
    const { dates } = expandRecurrence('2026-01-31', { freq: 'monthly', count: 5 });
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('clamps into February and returns to the 30th after it', () => {
    const { dates } = expandRecurrence('2026-01-30', { freq: 'monthly', count: 3 });
    expect(dates).toEqual(['2026-01-30', '2026-02-28', '2026-03-30']);
  });

  it('uses the 29th in a leap February', () => {
    const { dates } = expandRecurrence('2028-01-31', { freq: 'monthly', count: 2 });
    expect(dates).toEqual(['2028-01-31', '2028-02-29']);
  });

  it('crosses a year boundary', () => {
    const { dates } = expandRecurrence('2026-11-15', { freq: 'monthly', count: 4 });
    expect(dates).toEqual(['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15']);
  });

  it('steps over 29 February when repeating yearly-ish by month', () => {
    const { dates } = expandRecurrence('2026-02-28', { freq: 'monthly', interval: 12, count: 3 });
    expect(dates).toEqual(['2026-02-28', '2027-02-28', '2028-02-28']);
  });
});

describe('when it stops', () => {
  it('stops on the end date, inclusive', () => {
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', until: '2026-03-16' });
    expect(dates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
  });

  it('does not overshoot an end date that falls between occurrences', () => {
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', until: '2026-03-15' });
    expect(dates).toEqual(['2026-03-02', '2026-03-09']);
  });

  it('produces just the one appointment when the end date is its own day', () => {
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', until: '2026-03-02' });
    expect(dates).toEqual(['2026-03-02']);
  });

  it('produces nothing beyond the first when the end date is already past', () => {
    const { dates } = expandRecurrence('2026-03-02', { freq: 'weekly', until: '2026-01-01' });
    expect(dates).toEqual([]);
  });

  it('caps an open-ended rule and says it was capped', () => {
    const { dates, truncated } = expandRecurrence('2026-01-01', { freq: 'daily' });
    expect(truncated).toBe(true);
    expect(dates).toHaveLength(RECURRENCE_MAX_OCCURRENCES);
  });

  it('caps a count that is larger than the ceiling', () => {
    const { dates, truncated } = expandRecurrence('2026-01-01', { freq: 'daily', count: 5000 });
    expect(truncated).toBe(true);
    expect(dates).toHaveLength(RECURRENCE_MAX_OCCURRENCES);
  });

  it('does not cap a rule that ends on its own', () => {
    const { truncated, dates } = expandRecurrence('2026-01-01', { freq: 'weekly', count: 10 });
    expect(truncated).toBe(false);
    expect(dates).toHaveLength(10);
  });
});

describe('reading the rule back', () => {
  it('names the frequencies it accepts', () => {
    expect(isRecurFreq('weekly')).toBe(true);
    expect(isRecurFreq('yearly')).toBe(false);
    expect(isRecurFreq('')).toBe(false);
    expect(isRecurFreq(undefined)).toBe(false);
  });

  it('describes a rule the way somebody would say it', () => {
    expect(describeRecurrence({ freq: 'weekly' }, 4)).toBe('4 appointments, every week');
    expect(describeRecurrence({ freq: 'weekly', interval: 2 }, 3)).toBe('3 appointments, every 2 weeks');
    expect(describeRecurrence({ freq: 'daily' }, 1)).toBe('1 appointment, every day');
    expect(describeRecurrence({ freq: 'monthly', interval: 3 }, 8)).toBe('8 appointments, every 3 months');
  });
});
