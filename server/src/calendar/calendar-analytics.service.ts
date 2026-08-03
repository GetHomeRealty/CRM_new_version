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
 * figures are the signed-in user's own.
 *
 * THERE IS NO BROKERAGE-WIDE VIEW, AND THAT IS NOW A DECISION RATHER THAN AN OMISSION. One was
 * proposed on 2026-08-02 — a per-person workload report, counts and occupied hours only, no titles
 * or client names — and was declined outright: nobody sees another agent's appointments, explicitly
 * including an admin and a Super Admin. Recorded as B-A3 in docs/BACKLOG.md and pinned for every
 * role in `calendar-analytics.spec.ts`, because a rank check is a one-line change that will
 * eventually be proposed again.
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
  /** How many appointments START in each hour. Empty hours between the first and last included. */
  by_hour: { hour: string; total: number }[];
  /** How many MINUTES each hour is occupied for — the workload question, not the count question. */
  by_hour_busy: { hour: string; minutes: number }[];
  busiest: {
    weekday: string | null;
    /** The hour most appointments start in. */
    hour: string | null;
    /** The hour with the most occupied minutes, which is often a different one. */
    busy_hour: string | null;
    busy_minutes: number;
    date: string | null;
    date_count: number;
  };
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
      select: { date: true, time: true, end_time: true, type: true, status: true },
    });

    const totals = { total: rows.length, scheduled: 0, completed: 0, cancelled: 0, no_show: 0, rescheduled: 0 };
    const byType = new Map<string, { total: number; completed: number; no_show: number }>();
    const byWeekday = new Array(7).fill(0) as number[];
    const byHour = new Map<number, number>();
    /** Minutes occupied in each hour, which is a different question from how many things start in it. */
    const busyByHour = new Map<number, number>();
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

      const startMin = this.minutes(r.time);
      if (startMin !== null) {
        byHour.set(Math.floor(startMin / 60), (byHour.get(Math.floor(startMin / 60)) ?? 0) + 1);
        this.addBusyMinutes(busyByHour, startMin, this.minutes(r.end_time));
      }

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
    const busyEntries = [...busyByHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
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
      // Empty hours included, for the same reason every weekday is: a gap is a finding.
      by_hour: this.fillHours(byHour, (h, total) => ({ hour: this.label(h), total })),
      by_hour_busy: this.fillHours(busyByHour, (h, minutes) => ({ hour: this.label(h), minutes })),
      busiest: {
        weekday: busiestWeekday,
        hour: hourEntries.length ? this.label(hourEntries[0][0]) : null,
        // The fullest hour by occupied time, which is often not the hour most things start in —
        // a single long viewing outweighs three short calls.
        busy_hour: busyEntries.length ? this.label(busyEntries[0][0]) : null,
        busy_minutes: busyEntries.length ? busyEntries[0][1] : 0,
        date: dateEntries.length ? dateEntries[0][0] : null,
        date_count: dateEntries.length ? dateEntries[0][1] : 0,
      },
    };
  }

  /** yyyy-mm-dd → UTC midnight, so a day never shifts across a timezone. */
  private day(v: string): Date {
    return new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);
  }

  /** `09:00` from 9 — one place, so the two hour charts cannot label themselves differently. */
  private label(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  /** `HH:MM` → minutes past midnight, or null when the value is missing or malformed. */
  private minutes(v: string | null): number | null {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  /**
   * Spread one appointment's occupied minutes across the hours it actually covers.
   *
   * WHY THIS IS NOT THE SAME CHART as `by_hour`. That one counts how many appointments *start* in
   * an hour, so a three-hour viewing and a fifteen-minute call are one tick each and a diary that
   * is solidly full from nine to twelve looks identical to one with a single short call at nine.
   * Minutes occupied is the question somebody actually has when they ask how busy they are.
   *
   * A MISSING `end_time` MEANS ONE HOUR. That is not an invention here — `calendar.service.ts`
   * already treats an absent end as the one-hour block the Google push has always assumed, and the
   * clash detector uses the same rule. Two answers to "how long is this appointment?" in one module
   * would be worse than the assumption itself.
   *
   * An end at or before the start is treated as that same one-hour block: it is either a typo or an
   * appointment crossing midnight, and neither should silently contribute zero. Anything running
   * past midnight is clipped at the end of the day rather than wrapping onto hour 0, because those
   * minutes belong to tomorrow.
   */
  private addBusyMinutes(into: Map<number, number>, startMin: number, endMin: number | null): void {
    const DAY_END = 24 * 60;
    const end = endMin !== null && endMin > startMin ? endMin : startMin + 60;
    const stop = Math.min(end, DAY_END);

    for (let hour = Math.floor(startMin / 60); hour * 60 < stop; hour += 1) {
      const hourStart = hour * 60;
      const overlap = Math.min(stop, hourStart + 60) - Math.max(startMin, hourStart);
      if (overlap > 0) into.set(hour, (into.get(hour) ?? 0) + overlap);
    }
  }

  /**
   * Every hour from the first to the last that has something, including the empty ones.
   *
   * A gap is a finding. Hidden empty hours made a diary of 9, 12 and 3 read as three adjacent bars,
   * which looks like a solid morning rather than the scattered day it is — the same reasoning that
   * already lists all seven weekdays including the ones with nothing on them.
   *
   * Bounded by the first and last busy hour rather than running 00:00–23:00, because twenty-four
   * bars of which six matter is a different kind of unreadable.
   */
  private fillHours<T>(counts: Map<number, number>, make: (hour: number, value: number) => T): T[] {
    const hours = [...counts.keys()];
    if (!hours.length) return [];
    const first = Math.min(...hours);
    const last = Math.max(...hours);
    const out: T[] = [];
    for (let h = first; h <= last; h += 1) out.push(make(h, counts.get(h) ?? 0));
    return out;
  }
}
