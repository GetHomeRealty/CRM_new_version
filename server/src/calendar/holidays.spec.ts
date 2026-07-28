import { DEFAULT_PROVINCE, easterSunday, holidaysBetween, holidaysForYear, statutoryHolidays, type Province } from './holidays';

/** The date of a named holiday in a year, or undefined. Defaults to Ontario, like the app does. */
const on = (year: number, name: string, province: Province = DEFAULT_PROVINCE): string | undefined =>
  holidaysForYear(year, province).find((h) => h.name === name)?.date;

/**
 * These dates are computed, not stored, so the rules are what must be right. Each case below is
 * a known-correct Canadian date — if a rule is wrong (a third-Monday shortcut for Victoria Day,
 * say) these fail immediately rather than the calendar quietly showing the wrong day.
 */
describe('Canadian statutory holidays', () => {
  it('computes Easter Sunday correctly', () => {
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2024)).toEqual({ month: 3, day: 31 });
  });

  it('derives Good Friday and Easter Monday from it', () => {
    expect(on(2025, 'Good Friday')).toBe('2025-04-18');
    expect(on(2026, 'Good Friday')).toBe('2026-04-03');
    expect(holidaysForYear(2026, 'QC').find((h) => h.name === 'Easter Monday')?.date).toBe('2026-04-06');
  });

  it('places the fixed-date holidays', () => {
    expect(on(2026, "New Year's Day")).toBe('2026-01-01');
    expect(on(2026, 'Canada Day')).toBe('2026-07-01');
    expect(on(2026, 'Christmas Day')).toBe('2026-12-25');
    expect(on(2026, 'Boxing Day')).toBe('2026-12-26');
  });

  it('places the nth-weekday holidays', () => {
    // Family Day — third Monday of February.
    expect(on(2026, 'Family Day')).toBe('2026-02-16');
    expect(on(2025, 'Family Day')).toBe('2025-02-17');
    // Labour Day — first Monday of September.
    expect(on(2026, 'Labour Day')).toBe('2026-09-07');
    // Thanksgiving — second Monday of October.
    expect(on(2026, 'Thanksgiving')).toBe('2026-10-12');
    expect(on(2025, 'Thanksgiving')).toBe('2025-10-13');
    // Civic Holiday — first Monday of August.
    expect(on(2026, 'Civic Holiday')).toBe('2026-08-03');
  });

  it('uses the Monday-before-May-25 rule for Victoria Day, not "third Monday"', () => {
    expect(on(2026, 'Victoria Day')).toBe('2026-05-18');
    expect(on(2025, 'Victoria Day')).toBe('2025-05-19');
    // 2027: May 25 is a Tuesday, so Victoria Day is May 24 — the fourth Monday, which a
    // third-Monday shortcut would have got wrong.
    expect(on(2027, 'Victoria Day')).toBe('2027-05-24');
  });

  it('every computed date really falls on the weekday its rule requires', () => {
    const mondays = ['Family Day', 'Victoria Day', 'Civic Holiday', 'Labour Day', 'Thanksgiving'];
    for (let year = 2024; year <= 2030; year++) {
      for (const name of mondays) {
        const date = on(year, name);
        expect(date).toBeDefined();
        expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
      }
      // Good Friday is always a Friday, and Easter Monday always a Monday.
      expect(new Date(`${on(year, 'Good Friday')}T00:00:00Z`).getUTCDay()).toBe(5);
    }
  });
});

describe('provincial differences', () => {
  it('names the February Monday differently by province', () => {
    expect(on(2026, 'Family Day', 'ON')).toBe('2026-02-16');
    expect(on(2026, 'Louis Riel Day', 'MB')).toBe('2026-02-16');
    expect(on(2026, 'Islander Day', 'PE')).toBe('2026-02-16');
    // Manitoba does not call it Family Day.
    expect(on(2026, 'Family Day', 'MB')).toBeUndefined();
  });

  it('excludes statutory days a province does not observe', () => {
    // Saint-Jean-Baptiste is Quebec only.
    expect(on(2026, 'Saint-Jean-Baptiste Day', 'QC')).toBe('2026-06-24');
    expect(on(2026, 'Saint-Jean-Baptiste Day', 'ON')).toBeUndefined();
    // Remembrance Day is not a statutory holiday in Ontario.
    expect(on(2026, 'Remembrance Day', 'ON')).toBeUndefined();
    expect(on(2026, 'Remembrance Day', 'BC')).toBe('2026-11-11');
  });

  it('keeps national holidays in every province', () => {
    for (const p of ['ON', 'QC', 'BC', 'NS', 'YT'] as const) {
      expect(on(2026, 'Canada Day', p)).toBe('2026-07-01');
      expect(on(2026, 'Christmas Day', p)).toBe('2026-12-25');
    }
  });
});

describe('festivals', () => {
  it('marks lunar festivals as approximate', () => {
    const diwali = holidaysForYear(2026).find((h) => h.name === 'Diwali');
    expect(diwali?.date).toBe('2026-11-08');
    // Lunar dates can shift, so the UI must be able to say so rather than assert them.
    expect(diwali?.approximate).toBe(true);
  });

  it('does not invent festivals for a year it has no data for', () => {
    const far = holidaysForYear(2099);
    expect(far.some((h) => h.name === 'Diwali')).toBe(false);
    // Statutory holidays are computed, so they are still present in that year.
    expect(far.some((h) => h.name === 'Canada Day')).toBe(true);
  });

  it('treats fixed-date observances as exact', () => {
    const halloween = holidaysForYear(2026).find((h) => h.name === 'Halloween');
    expect(halloween?.date).toBe('2026-10-31');
    expect(halloween?.approximate).toBe(false);
  });
});

describe('range queries', () => {
  it('returns only what falls inside the range', () => {
    const july = holidaysBetween('2026-07-01', '2026-07-31');
    expect(july.map((h) => h.name)).toContain('Canada Day');
    expect(july.some((h) => h.name === 'Labour Day')).toBe(false);
  });

  it('spans a year boundary, which every month grid does', () => {
    // A December grid shows the first days of January.
    const span = holidaysBetween('2025-12-28', '2026-01-03');
    expect(span.map((h) => h.name)).toEqual(expect.arrayContaining(["New Year's Eve", "New Year's Day"]));
    expect(span.find((h) => h.name === "New Year's Day")?.date).toBe('2026-01-01');
  });

  it('returns results sorted by date', () => {
    const all = holidaysForYear(2026);
    const dates = all.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('rejects a backwards range instead of looping', () => {
    expect(holidaysBetween('2026-12-01', '2025-01-01')).toEqual([]);
  });

  it('produces no duplicate name+date pairs', () => {
    const keys = holidaysForYear(2026).map((h) => `${h.date}:${h.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('always returns the core statutory set', () => {
    for (let year = 2024; year <= 2030; year++) {
      const names = statutoryHolidays(year).map((h) => h.name);
      for (const required of ["New Year's Day", 'Good Friday', 'Canada Day', 'Labour Day', 'Christmas Day']) {
        expect(names).toContain(required);
      }
    }
  });
});
