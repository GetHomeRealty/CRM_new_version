import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Area } from '../common/domain';
import type { AuthUserRecord } from '../auth/auth.types';
import { EVENT_TYPE_LABELS } from './calendar.constants';

/**
 * What actually happened in somebody's diary.
 *
 * Counts only, computed in the database — the same choice the dashboards made after the old screen
 * pulled whole lists into the browser to sum them there. A year of appointments is a lot of rows to
 * send somebody so they can count them.
 *
 * SCOPED LIKE THE CALENDAR ITSELF. A calendar is private to its owner, for every role, so these
 * figures are the signed-in user's own. There is no brokerage-wide view here on purpose: it would
 * be a report on individual agents' days, which is a different thing needing a different decision
 * about who may see it.
 */

/** Sunday-first, matching the month grid. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface CalendarAnalytics {
  range: { from: string; to: string };
  totals: {
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
    no_show: number;
    rescheduled: number;
  };
  rates: {
    /** Of the appointments that reached an outcome, how many were kept. Null when none have. */
    completion: number | null;
    /** Of those that reached an outcome, how many nobody turned up to. */
    no_show: number | null;
    cancellation: number | null;
    /** How many outcomes the rates are computed from — a rate over 3 appointments is not a trend. */
    settled: number;
  };
  by_type: { type: string; label: string; total: number; completed: number; no_show: number }[];
  by_weekday: { day: string; total: number }[];
  by_hour: { hour: string; total: number }[];
  busiest: { weekday: string | null; hour: string | null; date: string | null; date_count: number };
}

@Injectable()
export class CalendarAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: AuthUserRecord, area: Area, from: string, to: string): Promise<CalendarAnalytics> {
    const rows = await this.prisma.calendar_events.findMany({
      where: {
        deleted_at: null,
        user_id: user.id ?? -1,
        OR: [{ domain: area }, { domain: null }],
        date: { gte: this.day(from), lte: this.day(to) },
      },
      select: { date: true, time: true, type: true, status: true },
    });

    const totals = { total: rows.length, scheduled: 0, completed: 0, cancelled: 0, no_show: 0, rescheduled: 0 };
    const byType = new Map<string, { total: number; completed: number; no_show: number }>();
    const byWeekday = new Array(7).fill(0) as number[];
    const byHour = new Map<number, number>();
    const byDate = new Map<string, number>();

    for (const r of rows) {
      const status = String(r.status ?? 'scheduled');
      if (status === 'scheduled') totals.scheduled += 1;
      else if (status === 'completed') totals.completed += 1;
      else if (status === 'cancelled') totals.cancelled += 1;
      else if (status === 'no-show') totals.no_show += 1;
      else if (status === 'rescheduled') totals.rescheduled += 1;

      const t = byType.get(r.type) ?? { total: 0, completed: 0, no_show: 0 };
      t.total += 1;
      if (status === 'completed') t.completed += 1;
      if (status === 'no-show') t.no_show += 1;
      byType.set(r.type, t);

      // `date` is a calendar day held at UTC midnight, so the UTC weekday is the real one — reading
      // it locally would shift a Sunday appointment onto Saturday west of Greenwich.
      byWeekday[r.date.getUTCDay()] += 1;

      const hour = Number(String(r.time ?? '00:00').slice(0, 2));
      if (Number.isFinite(hour)) byHour.set(hour, (byHour.get(hour) ?? 0) + 1);

      const day = r.date.toISOString().slice(0, 10);
      byDate.set(day, (byDate.get(day) ?? 0) + 1);
    }

    // Rates are over appointments that REACHED AN OUTCOME. Including still-scheduled ones would
    // make every rate drift down as the diary fills with future work, which says nothing about how
    // the past went.
    const settled = totals.completed + totals.cancelled + totals.no_show;
    const pct = (n: number) => (settled ? Math.round((n / settled) * 1000) / 10 : null);

    const busiestWeekday = byWeekday.some((n) => n > 0)
      ? WEEKDAYS[byWeekday.indexOf(Math.max(...byWeekday))] : null;
    const hourEntries = [...byHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const dateEntries = [...byDate.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    return {
      range: { from, to },
      totals,
      rates: {
        completion: pct(totals.completed),
        no_show: pct(totals.no_show),
        cancellation: pct(totals.cancelled),
        settled,
      },
      by_type: [...byType.entries()]
        .map(([type, v]) => ({ type, label: EVENT_TYPE_LABELS[type] ?? type, ...v }))
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
      // Every weekday is listed, including the empty ones: "nothing on Sundays" is a finding, and a
      // missing bar is not.
      by_weekday: WEEKDAYS.map((day, i) => ({ day, total: byWeekday[i] })),
      by_hour: [...byHour.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([h, total]) => ({ hour: `${String(h).padStart(2, '0')}:00`, total })),
      busiest: {
        weekday: busiestWeekday,
        hour: hourEntries.length ? `${String(hourEntries[0][0]).padStart(2, '0')}:00` : null,
        date: dateEntries.length ? dateEntries[0][0] : null,
        date_count: dateEntries.length ? dateEntries[0][1] : 0,
      },
    };
  }

  /** yyyy-mm-dd → UTC midnight, so a day never shifts across a timezone. */
  private day(v: string): Date {
    return new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);
  }
}
