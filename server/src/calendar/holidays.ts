/**
 * Canadian statutory holidays and cultural festivals for the calendar.
 *
 * Statutory holidays are *computed*, not stored: every rule below is exact for any year, so
 * there is no table to maintain and no chance of the calendar going blank in a future year.
 *
 * Cultural festivals are different. Diwali, Eid, Lunar New Year and the rest follow lunar or
 * lunisolar calendars that cannot be derived from the Gregorian date without an ephemeris, and
 * several Islamic dates depend on local moon sighting. Those come from the table at the bottom,
 * are flagged `approximate`, and are only known for the years listed there — outside that range
 * they simply do not appear rather than being guessed at.
 */

export type HolidayKind = 'statutory' | 'observance' | 'festival';

export interface Holiday {
  /** yyyy-mm-dd */
  date: string;
  name: string;
  kind: HolidayKind;
  /** Provinces/territories where it is a statutory day off. Empty for nationwide observances. */
  provinces: string[];
  /** True when it is a statutory holiday everywhere in Canada. */
  national: boolean;
  /** Lunar/lunisolar date that should be confirmed locally before relying on it. */
  approximate: boolean;
}

export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;
export type Province = (typeof PROVINCES)[number];

/** The brokerage is in Ontario, so that is what an unqualified request means. */
export const DEFAULT_PROVINCE: Province = 'ON';

export const isProvince = (v: string): v is Province => (PROVINCES as readonly string[]).includes(v);

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The nth given weekday of a month (weekday: 0 = Sunday). */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  return iso(year, month, day);
}

/** The last given weekday strictly before a date in the same month. */
function weekdayBefore(year: number, month: number, beforeDay: number, weekday: number): string {
  for (let d = beforeDay - 1; d >= 1; d--) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return iso(year, month, d);
  }
  return iso(year, month, 1);
}

/**
 * Easter Sunday (Gregorian), by the Anonymous Gregorian algorithm. Good Friday and Easter
 * Monday hang off it, so getting this right is what makes those two correct in every year.
 */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Shift a yyyy-mm-dd by a number of days. */
function shift(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ALL = [...PROVINCES] as string[];

/**
 * Statutory holidays and national observances for a year.
 *
 * `provinces` lists where each is a paid statutory day; several are federal-only or vary, which
 * is why Remembrance Day is not marked national even though it is observed everywhere.
 */
export function statutoryHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const easterIso = iso(year, easter.month, easter.day);

  const mk = (
    date: string, name: string, provinces: string[], national = false, kind: HolidayKind = 'statutory',
  ): Holiday => ({ date, name, kind, provinces, national, approximate: false });

  return [
    mk(iso(year, 1, 1), "New Year's Day", ALL, true),
    // Same Monday, different names by province — shown under the local name where it matters.
    mk(nthWeekday(year, 2, 1, 3), 'Family Day', ['AB', 'BC', 'ON', 'NB', 'SK']),
    mk(nthWeekday(year, 2, 1, 3), 'Louis Riel Day', ['MB']),
    mk(nthWeekday(year, 2, 1, 3), 'Islander Day', ['PE']),
    mk(nthWeekday(year, 2, 1, 3), 'Heritage Day', ['NS']),
    mk(shift(easterIso, -2), 'Good Friday', ALL, true),
    mk(shift(easterIso, 1), 'Easter Monday', ['QC'], false, 'observance'),
    // Victoria Day is the Monday before May 25 — not simply the third Monday.
    mk(weekdayBefore(year, 5, 25, 1), 'Victoria Day', ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'SK', 'YT']),
    mk(iso(year, 6, 21), 'National Indigenous Peoples Day', ['NT', 'YT'], false, 'observance'),
    mk(iso(year, 6, 24), 'Saint-Jean-Baptiste Day', ['QC']),
    mk(iso(year, 7, 1), 'Canada Day', ALL, true),
    mk(nthWeekday(year, 8, 1, 1), 'Civic Holiday', ['BC', 'NB', 'NT', 'NU', 'ON', 'SK']),
    mk(nthWeekday(year, 9, 1, 1), 'Labour Day', ALL, true),
    mk(iso(year, 9, 30), 'National Day for Truth and Reconciliation', ['BC', 'MB', 'NT', 'NU', 'PE', 'YT']),
    mk(nthWeekday(year, 10, 1, 2), 'Thanksgiving', ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'QC', 'SK', 'YT']),
    mk(iso(year, 11, 11), 'Remembrance Day', ['AB', 'BC', 'MB', 'NB', 'NL', 'NT', 'NU', 'PE', 'SK', 'YT']),
    mk(iso(year, 12, 25), 'Christmas Day', ALL, true),
    mk(iso(year, 12, 26), 'Boxing Day', ['ON'], false, 'observance'),
  ];
}

/** Fixed-date cultural and civic observances — same day every year, so computed. */
function fixedObservances(year: number): Holiday[] {
  const mk = (m: number, d: number, name: string, approximate = false): Holiday => ({
    date: iso(year, m, d), name, kind: 'festival', provinces: [], national: false, approximate,
  });
  return [
    mk(2, 14, "Valentine's Day"),
    mk(3, 17, "St. Patrick's Day"),
    // Nowruz is astronomical (the March equinox) and falls on the 20th or 21st.
    mk(3, 20, 'Nowruz (Persian New Year)', true),
    mk(4, 22, 'Earth Day'),
    mk(10, 31, 'Halloween'),
    mk(12, 24, 'Christmas Eve'),
    mk(12, 31, "New Year's Eve"),
  ];
}

/**
 * Lunar and lunisolar festivals, which cannot be computed from the Gregorian calendar.
 *
 * Islamic dates (Eid, Ramadan) depend on local moon sighting and can move by a day either way;
 * Hindu, Sikh and Jewish dates come from their own calendars. Everything here is flagged
 * `approximate` and confined to the years listed — a year that is not in this table shows no
 * festivals rather than invented ones. Extend it as authoritative dates are published.
 */
const LUNAR_FESTIVALS: Record<number, { date: string; name: string }[]> = {
  2025: [
    { date: '2025-01-29', name: 'Lunar New Year' },
    { date: '2025-03-01', name: 'Ramadan begins' },
    { date: '2025-03-14', name: 'Holi' },
    { date: '2025-03-30', name: 'Eid al-Fitr' },
    { date: '2025-04-13', name: 'Vaisakhi' },
    { date: '2025-06-06', name: 'Eid al-Adha' },
    { date: '2025-10-20', name: 'Diwali' },
    { date: '2025-12-14', name: 'Hanukkah begins' },
  ],
  2026: [
    { date: '2026-02-17', name: 'Lunar New Year' },
    { date: '2026-02-18', name: 'Ramadan begins' },
    { date: '2026-03-03', name: 'Holi' },
    { date: '2026-03-20', name: 'Eid al-Fitr' },
    { date: '2026-04-14', name: 'Vaisakhi' },
    { date: '2026-05-27', name: 'Eid al-Adha' },
    { date: '2026-11-08', name: 'Diwali' },
    { date: '2026-12-04', name: 'Hanukkah begins' },
  ],
  2027: [
    { date: '2027-02-06', name: 'Lunar New Year' },
    { date: '2027-02-08', name: 'Ramadan begins' },
    { date: '2027-03-22', name: 'Holi' },
    { date: '2027-03-09', name: 'Eid al-Fitr' },
    { date: '2027-04-14', name: 'Vaisakhi' },
    { date: '2027-05-16', name: 'Eid al-Adha' },
    { date: '2027-10-29', name: 'Diwali' },
    { date: '2027-12-24', name: 'Hanukkah begins' },
  ],
};

/**
 * Indian (Hindu) festivals — festivals only, deliberately NOT civic/national days like Republic
 * Day, Independence Day or Gandhi Jayanti. These are lunisolar and cannot be computed, so they are
 * tabulated per year and flagged `approximate`: confirm against a local panchang before relying on
 * one. Diwali and Holi already live in LUNAR_FESTIVALS and are not repeated here.
 */
const INDIAN_FESTIVALS: Record<number, { date: string; name: string }[]> = {
  2026: [
    { date: '2026-01-14', name: 'Makar Sankranti / Pongal' },
    { date: '2026-01-23', name: 'Vasant Panchami' },
    { date: '2026-02-15', name: 'Maha Shivaratri' },
    { date: '2026-03-19', name: 'Ugadi / Gudi Padwa' },
    { date: '2026-03-26', name: 'Ram Navami' },
    { date: '2026-04-20', name: 'Akshaya Tritiya' },
    { date: '2026-07-29', name: 'Guru Purnima' },
    { date: '2026-08-26', name: 'Onam' },
    { date: '2026-08-28', name: 'Raksha Bandhan' },
    { date: '2026-09-04', name: 'Krishna Janmashtami' },
    { date: '2026-09-14', name: 'Ganesh Chaturthi' },
    { date: '2026-10-11', name: 'Navratri begins' },
    { date: '2026-10-20', name: 'Dussehra (Vijayadashami)' },
    { date: '2026-11-06', name: 'Dhanteras' },
    { date: '2026-11-10', name: 'Govardhan Puja' },
    { date: '2026-11-11', name: 'Bhai Dooj' },
    { date: '2026-11-15', name: 'Chhath Puja' },
  ],
  2027: [
    { date: '2027-01-14', name: 'Makar Sankranti / Pongal' },
    { date: '2027-02-15', name: 'Vasant Panchami' },
    { date: '2027-03-06', name: 'Maha Shivaratri' },
    { date: '2027-04-15', name: 'Ram Navami' },
    { date: '2027-08-17', name: 'Raksha Bandhan' },
    { date: '2027-08-25', name: 'Krishna Janmashtami' },
    { date: '2027-09-04', name: 'Ganesh Chaturthi' },
    { date: '2027-09-30', name: 'Navratri begins' },
    { date: '2027-10-09', name: 'Dussehra (Vijayadashami)' },
    { date: '2027-10-27', name: 'Dhanteras' },
  ],
};

/** The years LUNAR_FESTIVALS covers, so the UI can say when a year has no festival data. */
export const FESTIVAL_YEARS = Object.keys(LUNAR_FESTIVALS).map(Number).sort();

function lunarFestivals(year: number): Holiday[] {
  const merged = [...(LUNAR_FESTIVALS[year] ?? []), ...(INDIAN_FESTIVALS[year] ?? [])];
  return merged.map((f) => ({
    date: f.date, name: f.name, kind: 'festival' as const,
    provinces: [], national: false, approximate: true,
  }));
}

/**
 * Every holiday and festival in a year, sorted by date.
 *
 * `province` filters statutory days to the ones actually observed there; national holidays,
 * observances and festivals are always included.
 */
export function holidaysForYear(year: number, province: Province = DEFAULT_PROVINCE): Holiday[] {
  const all = [...statutoryHolidays(year), ...fixedObservances(year), ...lunarFestivals(year)];
  return all
    .filter((h) => h.kind !== 'statutory' || h.national || h.provinces.includes(province))
    .sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)));
}

/** Everything falling between two yyyy-mm-dd bounds, inclusive. Spans year boundaries. */
export function holidaysBetween(from: string, to: string, province: Province = DEFAULT_PROVINCE): Holiday[] {
  const startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || endYear < startYear) return [];

  const out: Holiday[] = [];
  // A month grid shows trailing days of the neighbouring months, so a request can straddle
  // December/January — collect every year it touches.
  for (let y = startYear; y <= endYear && y - startYear < 5; y++) out.push(...holidaysForYear(y, province));
  return out.filter((h) => h.date >= from && h.date <= to);
}
