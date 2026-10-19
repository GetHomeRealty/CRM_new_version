/*
 * Company Documents (19 Oct 2026) - Sai's reminder rules, day by day, and each country's own clock.
 */
import { CompanyDocumentReminderService, localDay } from './company-document-reminder.service';

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const due = CompanyDocumentReminderService.due;
const EXP = day('2026-11-20');
const base = { expiry_date: EXP, reminder_started_at: null, last_reminder_at: null, latest_file_at: null };
// A reminder "sent" at 9:00 Toronto (14:00 UTC) on a date.
const sentOn = (s: string) => new Date(`${s}T14:00:00Z`);

describe('company document reminders', () => {
  it('nothing before 15 days; the first one at 15 days', () => {
    expect(due(base, day('2026-11-04'), 'CA')).toBe(false); // 16 days
    expect(due(base, day('2026-11-05'), 'CA')).toBe(true); // 15 days
  });

  it('then every 2 days, never twice on one day', () => {
    const last = { ...base, reminder_started_at: sentOn('2026-11-05'), last_reminder_at: sentOn('2026-11-05') };
    expect(due(last, day('2026-11-05'), 'CA')).toBe(false);
    expect(due(last, day('2026-11-06'), 'CA')).toBe(false);
    expect(due(last, day('2026-11-07'), 'CA')).toBe(true);
  });

  it('always the day before and the day itself', () => {
    const before = { ...base, reminder_started_at: sentOn('2026-11-05'), last_reminder_at: sentOn('2026-11-18') };
    expect(due(before, day('2026-11-19'), 'CA')).toBe(true); // day before, 1 day after the last
    const dayBefore = { ...before, last_reminder_at: sentOn('2026-11-19') };
    expect(due(dayBefore, day('2026-11-19'), 'CA')).toBe(false); // already sent today
    expect(due(dayBefore, day('2026-11-20'), 'CA')).toBe(true); // the expiry day
  });

  it('after the expiry, every day for as long as it is not renewed', () => {
    const after = { ...base, reminder_started_at: sentOn('2026-11-05'), last_reminder_at: sentOn('2026-11-20') };
    expect(due(after, day('2026-11-20'), 'CA')).toBe(false); // never twice on one day
    expect(due(after, day('2026-11-21'), 'CA')).toBe(true);
    expect(due({ ...after, last_reminder_at: sentOn('2027-03-01') }, day('2027-03-02'), 'CA')).toBe(true);
  });

  it('stops when a new file is uploaded after the reminders began', () => {
    const renewed = { ...base, reminder_started_at: sentOn('2026-11-05'), last_reminder_at: sentOn('2026-11-07'), latest_file_at: new Date('2026-11-08T10:00:00Z') };
    expect(due(renewed, day('2026-11-09'), 'CA')).toBe(false);
    expect(due(renewed, day('2026-11-25'), 'CA')).toBe(false);
    // A file that was already there before the reminders began is not a renewal.
    const old = { ...renewed, latest_file_at: new Date('2026-01-01T10:00:00Z') };
    expect(due(old, day('2026-11-09'), 'CA')).toBe(true);
  });

  it('no expiry date, no reminders', () => {
    expect(due({ ...base, expiry_date: null }, day('2026-11-20'), 'CA')).toBe(false);
  });

  it('each country counts its own date and hour', () => {
    // 20 Oct 2026 03:30 UTC = 19 Oct 23:30 in Toronto, 20 Oct 09:00 in India.
    const at = new Date('2026-10-20T03:30:00Z');
    expect(localDay(at, 'CA')).toEqual({ day: day('2026-10-19'), hour: 23 });
    expect(localDay(at, 'IN')).toEqual({ day: day('2026-10-20'), hour: 9 });
  });
});
