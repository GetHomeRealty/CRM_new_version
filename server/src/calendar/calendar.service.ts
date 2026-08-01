import type { Area } from '../common/domain';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarSyncService } from '../google/google-calendar-sync.service';
import { AuditService } from '../audit/audit.service';
import { EVENT_TYPES, EVENT_STATUSES, isEventType, isEventStatus } from './calendar.constants';
import type { AuthUserRecord } from '../auth/auth.types';
import { liveLeadWhere } from '../common/lead-scope';
import {
  RECUR_FREQUENCIES, type RecurFreq, type RecurrenceRule,
  describeRecurrence, expandRecurrence, isRecurFreq,
} from './recurrence';
import { transactionScopeWhere } from '../common/transaction-scope';

/** The shape the client sends when creating or updating an event. */
export interface EventInput {
  title?: unknown;
  date?: unknown;
  time?: unknown;
  /** Optional end time (HH:MM). Absent means the one-hour block the Google push assumes. */
  end_time?: unknown;
  /** Save despite an overlap — back-to-back showings at one address are legitimate. */
  allow_overlap?: unknown;
  /** The version the editor was opened on. Sent back so a stale save is refused, not applied. */
  version?: unknown;
  /** Repeat rule, on create only: daily | weekly | monthly. Absent or 'none' makes a one-off. */
  recur_freq?: unknown;
  recur_interval?: unknown;
  recur_until?: unknown;
  recur_count?: unknown;
  type?: unknown;
  status?: unknown;
  location?: unknown;
  description?: unknown;
  attendees?: unknown;
  contact_phone?: unknown;
  contact_email?: unknown;
  property_details?: unknown;
  notes?: unknown;
  enable_reminder?: unknown;
  transaction_id?: unknown;
  /** Optional lead this event follows up on (Leads module). */
  lead_id?: unknown;
}

/**
 * Which appointments an edit or a delete applies to.
 *
 * `series` means this occurrence AND the later ones — never the earlier ones. Rewriting a meeting
 * that already happened is not what anybody means by "change the series", and it would quietly
 * destroy the record of what actually took place.
 */
export type SeriesScope = 'this' | 'series';
export const isSeriesScope = (v: unknown): v is SeriesScope => v === 'this' || v === 'series';

/** Filters accepted by the list endpoint. */
export interface EventQuery {
  from?: string;
  to?: string;
  type?: string;
  status?: string;
  transaction_id?: number;
  lead_id?: number;
}

/**
 * The most events one list request will return.
 *
 * Generous on purpose: a month grid shows a few dozen, and the busiest calendar here holds ~310
 * across five months, so nothing a person does reaches this. It is a backstop against a request
 * with no date range, not a page size — the screen narrows by month rather than paging.
 */
const MAX_EVENTS = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly googleSync: GoogleCalendarSyncService,
  ) {}

  /**
   * A calendar is private to its owner, for EVERY role. Nobody — not another agent, not an admin,
   * not a super-admin — sees another person's appointments; each user keeps their own calendar.
   */
  private scopeWhere(user: AuthUserRecord): Record<string, unknown> {
    return { user_id: user.id ?? -1 };
  }

  /**
   * Which events one area's calendar shows.
   *
   * The CRM Calendar shows what came from the calendar connected under CRM Settings; the
   * Transaction Desk Calendar shows what came from its own. Events with no area pre-date the split
   * and appear in both, so nothing disappeared from anyone's calendar when the column arrived —
   * the next Google pull claims and stamps them.
   *
   * Spelled as a union because Prisma rejects `null` inside an `in` list.
   */
  private areaWhere(area: Area): Record<string, unknown> {
    return { OR: [{ domain: area }, { domain: null }] };
  }

  // ------------------------------------------------------------------ read
  async list(user: AuthUserRecord, area: Area, q: EventQuery = {}): Promise<Record<string, unknown>[]> {
    const where: Record<string, unknown> = { deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) };
    if (q.from || q.to) {
      where.date = {
        ...(q.from ? { gte: this.toDate(q.from) } : {}),
        ...(q.to ? { lte: this.toDate(q.to) } : {}),
      };
    }
    if (q.type && isEventType(q.type)) where.type = q.type;
    if (q.status && isEventStatus(q.status)) where.status = q.status;
    if (q.transaction_id) where.transaction_id = q.transaction_id;
    if (q.lead_id) where.lead_id = q.lead_id;

    const rows = await this.prisma.calendar_events.findMany({
      where,
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      // A ceiling, not a page. The screen asks for one month at a time, which is a few dozen rows;
      // this exists so that a caller who omits `from`/`to` — an old client, a script, a shared link
      // — cannot pull a user's entire calendar history in one response. It used to be unbounded,
      // and the busiest calendar in this database was already 223 KB spanning five months.
      take: MAX_EVENTS,
    });
    return rows.map((r) => this.present(r));
  }

  async get(id: number, user: AuthUserRecord, area: Area): Promise<Record<string, unknown>> {
    const row = await this.prisma.calendar_events.findFirst({
      where: { id, deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) },
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
    });
    if (!row) throw new NotFoundException({ message: 'Event not found.' });
    return this.present(row);
  }

  // ----------------------------------------------------------------- write
  async create(input: EventInput, user: AuthUserRecord, area: Area): Promise<Record<string, unknown>> {
    const data = await this.validate(input, true, user);
    const rule = this.parseRule(input);
    const allowOverlap = input.allow_overlap === true || input.allow_overlap === 'true';
    const now = new Date();

    // Every date the series falls on. Without a rule that is just the one day, so the ordinary
    // path below is the recurring path with a single occurrence — no second code path to keep in
    // step, and no way for a one-off to behave differently from the first of a series.
    const startDay = (data.date as Date).toISOString().slice(0, 10);
    const expansion = rule ? expandRecurrence(startDay, rule) : { dates: [startDay], truncated: false };
    if (!expansion.dates.length) {
      throw new BadRequestException({ message: 'That repeat rule produces no appointments. Check the end date.' });
    }

    // Checked BEFORE anything is written, and across every date: half a series in the calendar and
    // half refused would be worse than refusing the lot. The message names the dates that clash so
    // the choice is informed rather than "something, somewhere, overlaps".
    if (!allowOverlap) {
      const clashes: { day: string; with: { id: number; title: string; time: string; end_time: string | null } }[] = [];
      for (const day of expansion.dates) {
        const hit = await this.findClash(user, area, { ...data, date: this.toDate(day) }, null);
        if (hit) clashes.push({ day, with: hit });
        if (clashes.length >= 3) break;
      }
      if (clashes.length) {
        const first = clashes[0].with;
        const span = first.end_time ? `${first.time}–${first.end_time}` : `${first.time} (1 hour assumed)`;
        // A one-off says what it hit; a repeat says which dates it hits, because "it overlaps
        // something" is useless when the rule spans months.
        const oneOff = expansion.dates.length === 1;
        throw new BadRequestException({
          message: oneOff
            ? `This overlaps "${first.title}" at ${span}. Change the time, or save again with "Book anyway" to keep both.`
            : `This repeat overlaps existing appointments on ${clashes.map((c) => `${c.day} ("${c.with.title}")`).join(', ')}. Change the time, or save again with "Book anyway".`,
          errors: { time: [oneOff ? `Overlaps "${first.title}" at ${span}.` : `Overlaps on ${clashes.map((c) => c.day).join(', ')}.`] },
          conflict: oneOff
            ? { id: first.id, title: first.title, time: first.time, end_time: first.end_time }
            : { dates: clashes.map((c) => c.day) },
        });
      }
    }

    const base = {
      ...data,
      title: data.title as string,
      time: data.time as string,
      user_id: user.id ?? null,
      // The area it was created in. Also what decides which Google calendar it is mirrored to.
      domain: area,
      created_by: user.name,
      created_at: now,
      updated_at: now,
    };

    // The first occurrence carries the rule and becomes the series id the others point at, so the
    // series needs no table of its own and cannot fall out of step with its members.
    const first = await this.prisma.calendar_events.create({
      data: {
        ...base,
        date: this.toDate(expansion.dates[0]),
        ...(rule ? { recur_freq: rule.freq, recur_interval: rule.interval ?? 1, recur_until: rule.until ? this.toDate(rule.until) : null, recur_count: rule.count ?? null } : {}),
      },
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
    });

    if (rule) {
      await this.prisma.calendar_events.update({ where: { id: first.id }, data: { recurrence_id: first.id } });
      const rest = expansion.dates.slice(1);
      if (rest.length) {
        await this.prisma.calendar_events.createMany({
          data: rest.map((day) => ({ ...base, date: this.toDate(day), recurrence_id: first.id })),
        });
      }
    }

    await this.logToTransaction(first.transaction_id, user, 'Event created', first.title, first.date, first.time);
    // Mirror to the user's Google Calendar if they've connected one. Best-effort and non-blocking:
    // a calendar save must never fail because Google was briefly unreachable.
    void this.googleSync.pushEvent(user.id ?? null, first.id);

    const presented = this.present({ ...first, recurrence_id: rule ? first.id : null });
    return rule
      ? { ...presented, recurrence: { occurrences: expansion.dates.length, truncated: expansion.truncated, summary: describeRecurrence(rule, expansion.dates.length) } }
      : presented;
  }

  /**
   * The repeat rule off the request, or null for a one-off.
   *
   * Validated here rather than in `validate` because it produces a rule object rather than a column
   * — nothing on the event row is set from it directly except on the series head.
   */
  private parseRule(input: EventInput): RecurrenceRule | null {
    const freq = String(input.recur_freq ?? '').trim();
    if (freq === '' || freq === 'none') return null;
    if (!isRecurFreq(freq)) {
      throw new BadRequestException({ message: `Repeat must be one of: ${RECUR_FREQUENCIES.join(', ')}.`, errors: { recur_freq: ['Not a repeat option.'] } });
    }

    const rawInterval = input.recur_interval;
    const interval = rawInterval === undefined || rawInterval === null || rawInterval === '' ? 1 : Number(rawInterval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
      throw new BadRequestException({ message: 'Repeat every must be a whole number between 1 and 52.', errors: { recur_interval: ['Between 1 and 52.'] } });
    }

    const until = String(input.recur_until ?? '').trim();
    if (until !== '' && !DATE_RE.test(until)) {
      throw new BadRequestException({ message: 'The repeat end date must be in YYYY-MM-DD format.', errors: { recur_until: ['Use YYYY-MM-DD.'] } });
    }

    const rawCount = input.recur_count;
    const count = rawCount === undefined || rawCount === null || rawCount === '' ? null : Number(rawCount);
    if (count !== null && (!Number.isInteger(count) || count < 1)) {
      throw new BadRequestException({ message: 'Number of appointments must be a whole number of 1 or more.', errors: { recur_count: ['1 or more.'] } });
    }

    return { freq: freq as RecurFreq, interval, until: until || null, count };
  }

  async update(id: number, input: EventInput, user: AuthUserRecord, area: Area, scope: SeriesScope = 'this'): Promise<Record<string, unknown>> {
    const existing = await this.prisma.calendar_events.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) } });
    if (!existing) throw new NotFoundException({ message: 'Event not found.' });

    // Optimistic locking. The client sends back the version it read; if the row has moved on since,
    // somebody else saved in between and this write would erase their change without either person
    // being told. Refused with a 409 and the current state, so the screen can say what happened.
    //
    // Absent `version` still saves, deliberately: a link, a script or an older client should not
    // start failing. Anything that sends one gets the protection.
    if (input.version !== undefined && input.version !== null && input.version !== '') {
      const sent = Number(input.version);
      if (!Number.isInteger(sent) || sent < 1) {
        throw new BadRequestException({ message: 'That version is not valid.' });
      }
      if (sent !== existing.version) {
        throw new ConflictException({
          message: 'Somebody else changed this event while you were editing it. Reload to see their version, then apply your change again.',
          conflict: { current_version: existing.version, your_version: sent, updated_at: existing.updated_at },
        });
      }
    }

    const data = await this.validate(input, false, user);
    // The clash check runs against the event as it will BE, not as it was: an edit that only moves
    // the time still has to be checked against the date it is not changing.
    await this.assertNoClash(
      user, area,
      { date: data.date ?? existing.date, time: data.time ?? existing.time, end_time: 'end_time' in data ? data.end_time : existing.end_time,
        status: data.status ?? existing.status },
      id, input.allow_overlap === true || input.allow_overlap === 'true',
    );

    const row = await this.prisma.calendar_events.update({
      where: { id },
      // `increment` rather than a read-then-write: the bump happens in the same statement, so two
      // saves racing past the check above still end on different versions.
      data: { ...data, version: { increment: 1 }, updated_at: new Date() },
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
    });
    await this.logToTransaction(row.transaction_id, user, 'Event updated', row.title, row.date, row.time);
    // Carry the edit out to Google. Previously only creation was mirrored, so a viewing moved from
    // 2pm to 5pm — or cancelled outright — kept its original slot on the agent's phone for ever.
    void this.googleSync.updateEvent(user.id ?? null, row.id);

    // "This and the ones after it", not "the whole series".
    //
    // Editing every occurrence would rewrite appointments that have already happened — moving a
    // meeting that took place last Tuesday to a new time is nonsense, and it would erase whatever
    // the record said about it. Later occurrences only, which is what somebody changing a standing
    // arrangement means.
    //
    // `date` is deliberately excluded: each occurrence has its own day, and copying one across the
    // series would collapse them all onto a single date.
    let alsoChanged = 0;
    if (scope === 'series' && existing.recurrence_id) {
      const { date: _ignored, ...spread } = data as Record<string, unknown>;
      if (Object.keys(spread).length) {
        const done = await this.prisma.calendar_events.updateMany({
          where: {
            recurrence_id: existing.recurrence_id,
            deleted_at: null,
            id: { not: id },
            date: { gte: existing.date },
            ...this.scopeWhere(user),
          },
          data: { ...spread, version: { increment: 1 }, updated_at: new Date() },
        });
        alsoChanged = done.count;
      }
    }

    const out = this.present(row);
    return alsoChanged ? { ...out, series_updated: alsoChanged } : out;
  }

  /** Soft delete, so an appointment can be recovered the same way other records are. */
  async remove(id: number, user: AuthUserRecord, area: Area, scope: SeriesScope = 'this'): Promise<{ deleted: boolean; series_deleted?: number }> {
    const existing = await this.prisma.calendar_events.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) } });
    if (!existing) throw new NotFoundException({ message: 'Event not found.' });
    // Read the Google id BEFORE the row is marked deleted — it is the only record of where the
    // mirrored copy lives, and the delete has to remove that copy too or the appointment lingers
    // on the agent's phone after it has gone from here.
    const googleId = existing.google_calendar_id;
    const domain = existing.domain;

    await this.prisma.calendar_events.update({ where: { id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    await this.logToTransaction(existing.transaction_id, user, 'Event deleted', existing.title, existing.date, existing.time);
    void this.googleSync.removeEvent(user.id ?? null, googleId, domain);

    // Cancelling a standing arrangement drops this one and the ones still to come; the ones that
    // already happened stay, because they did.
    let seriesDeleted = 0;
    if (scope === 'series' && existing.recurrence_id) {
      const later = await this.prisma.calendar_events.findMany({
        where: {
          recurrence_id: existing.recurrence_id, deleted_at: null, id: { not: id },
          date: { gte: existing.date }, ...this.scopeWhere(user),
        },
        select: { id: true, google_calendar_id: true, domain: true },
      });
      if (later.length) {
        await this.prisma.calendar_events.updateMany({
          where: { id: { in: later.map((r) => r.id) } },
          data: { deleted_at: new Date(), updated_at: new Date() },
        });
        // Each mirrored copy has to go from Google too, or the phone keeps showing a cancelled run.
        for (const r of later) void this.googleSync.removeEvent(user.id ?? null, r.google_calendar_id, r.domain);
        seriesDeleted = later.length;
      }
    }

    return seriesDeleted ? { deleted: true, series_deleted: seriesDeleted } : { deleted: true };
  }

  /**
   * Refuse an appointment that overlaps one the user already has.
   *
   * A showings calendar whose entries have no end could not express a conflict at all, so two
   * viewings at the same minute were both accepted in silence. An event without an `end_time` is
   * treated as the one-hour block the Google push has always assumed, which makes the older events
   * — every one of them, until people start setting an end — participate in the check rather than
   * being invisible to it.
   *
   * Cancelled events never clash: the slot is free again, which is the point of cancelling. The
   * caller can pass `allow_overlap` to book anyway, because back-to-back showings at one address
   * and genuine double-bookings are both real, and the software should warn rather than forbid.
   */
  private async assertNoClash(
    user: AuthUserRecord,
    area: Area,
    ev: { date?: unknown; time?: unknown; end_time?: unknown; status?: unknown },
    excludeId: number | null,
    allowOverlap: boolean,
  ): Promise<void> {
    if (allowOverlap) return;
    const other = await this.findClash(user, area, ev, excludeId);
    if (!other) return;
    const span = other.end_time ? `${other.time}–${other.end_time}` : `${other.time} (1 hour assumed)`;
    throw new BadRequestException({
      message: `This overlaps "${other.title}" at ${span}. Change the time, or save again with "Book anyway" to keep both.`,
      errors: { time: [`Overlaps "${other.title}" at ${span}.`] },
      conflict: { id: other.id, title: other.title, time: other.time, end_time: other.end_time },
    });
  }

  /**
   * The first appointment this one would sit on top of, or null.
   *
   * Split out from `assertNoClash` so a recurring series can ask the same question of every date it
   * would occupy and report them together, rather than throwing on the first and leaving the user
   * to discover the rest one save at a time.
   */
  private async findClash(
    user: AuthUserRecord,
    area: Area,
    ev: { date?: unknown; time?: unknown; end_time?: unknown; status?: unknown },
    excludeId: number | null,
  ): Promise<{ id: number; title: string; time: string; end_time: string | null } | null> {
    if (String(ev.status ?? 'scheduled') === 'cancelled') return null;
    const date = ev.date instanceof Date ? ev.date : null;
    const time = typeof ev.time === 'string' ? ev.time : null;
    if (!date || !time) return null;

    const startsAt = this.minutes(time);
    const endsAt = typeof ev.end_time === 'string' && ev.end_time ? this.minutes(ev.end_time) : startsAt + 60;

    const sameDay = await this.prisma.calendar_events.findMany({
      where: {
        deleted_at: null, date, status: { not: 'cancelled' },
        ...this.scopeWhere(user), ...this.areaWhere(area),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, title: true, time: true, end_time: true },
    });

    for (const other of sameDay) {
      const oStart = this.minutes(other.time);
      const oEnd = other.end_time ? this.minutes(other.end_time) : oStart + 60;
      // Touching is not overlapping: a 10:00–11:00 viewing and an 11:00–12:00 one are back-to-back.
      if (startsAt < oEnd && oStart < endsAt) return other;
    }
    return null;
  }

  /** HH:MM → minutes past midnight. */
  private minutes(hhmm: string): number {
    const [h, m] = String(hhmm ?? '00:00').slice(0, 5).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }

  // ------------------------------------------------------------ validation
  /**
   * Validate and normalise an event payload. `requireCore` is true on create, where title,
   * date, time and type must all be present; on update only the supplied fields are checked.
   */
  private async validate(input: EventInput, requireCore: boolean, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const add = (field: string, msg: string) => { (errors[field] ??= []).push(msg); };
    const out: Record<string, unknown> = {};
    const has = (k: keyof EventInput) => input[k] !== undefined;
    // Control characters are stripped before anything else looks at the value. A NUL byte reached
    // the driver and came back as an unhandled 500 — Postgres `22021: invalid byte sequence` —
    // while every other bad input on this endpoint answered with a tidy 400. Stripped rather than
    // rejected because a NUL is never something a person typed: it arrives from a bad paste or a
    // malformed client, and there is nothing to tell them to correct. A title left empty by the
    // stripping still fails the "A title is required." check below.
    const str = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

    // --- title ---
    if (requireCore || has('title')) {
      const title = str(input.title);
      if (!title) add('title', 'A title is required.');
      else if (title.length > 255) add('title', 'The title must be 255 characters or fewer.');
      else out.title = title;
    }

    // --- date ---
    if (requireCore || has('date')) {
      const date = str(input.date).slice(0, 10);
      if (!DATE_RE.test(date)) add('date', 'The date must be in YYYY-MM-DD format.');
      else {
        const d = this.toDate(date);
        // `new Date('2026-02-30')` silently rolls over to March 2 rather than returning
        // NaN, so a NaN check alone lets impossible dates through — compare the round trip.
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
          add('date', 'That date does not exist.');
        } else {
          out.date = d;
        }
      }
    }

    // --- time ---
    if (requireCore || has('time')) {
      const time = str(input.time);
      if (!TIME_RE.test(time)) add('time', 'The time must be in 24-hour HH:MM format.');
      else out.time = time;
    }

    // --- end time: optional, but if given it must be after the start ---
    if (has('end_time')) {
      const end = str(input.end_time);
      if (end === '') {
        out.end_time = null;
      } else if (!TIME_RE.test(end)) {
        add('end_time', 'The end time must be in 24-hour HH:MM format.');
      } else {
        // Compared against whatever start this request ends up with — the new one when the time is
        // being changed, the stored one when it is not. An event that ends before it begins is the
        // kind of thing that silently breaks every duration and conflict calculation downstream.
        const start = typeof out.time === 'string' ? out.time : (typeof input.time === 'string' ? str(input.time) : null);
        if (start && TIME_RE.test(start) && this.minutes(end) <= this.minutes(start)) {
          add('end_time', 'The end time must be after the start time.');
        } else {
          out.end_time = end;
        }
      }
    }

    // --- type / status ---
    if (requireCore || has('type')) {
      const type = str(input.type) || 'meeting';
      if (!isEventType(type)) add('type', `The type must be one of: ${EVENT_TYPES.join(', ')}.`);
      else out.type = type;
    }
    if (has('status')) {
      const status = str(input.status) || 'scheduled';
      if (!isEventStatus(status)) add('status', `The status must be one of: ${EVENT_STATUSES.join(', ')}.`);
      else out.status = status;
    }

    // --- optional text fields ---
    const text: [keyof EventInput, string, number][] = [
      ['location', 'location', 255],
      ['attendees', 'attendees', 255],
      ['contact_phone', 'contact_phone', 64],
      ['contact_email', 'contact_email', 255],
      ['description', 'description', 5000],
      ['property_details', 'property_details', 5000],
      ['notes', 'notes', 5000],
    ];
    for (const [key, field, max] of text) {
      if (!has(key)) continue;
      const v = str(input[key]);
      if (v.length > max) add(field, `Must be ${max} characters or fewer.`);
      else out[field] = v === '' ? null : v;
    }
    if (has('contact_email') && str(input.contact_email) !== '' && !EMAIL_RE.test(str(input.contact_email))) {
      add('contact_email', 'Enter a valid email address.');
    }

    if (has('enable_reminder')) out.enable_reminder = input.enable_reminder === true || input.enable_reminder === 'true';

    // --- lead link: an event raised from the Leads module follows up on a real lead ---
    //
    // Scoped to what the caller may see, not merely to what exists. Both of these links used to
    // check existence alone, which made them an enumeration oracle: an agent whose Transactions
    // screen showed nothing could POST an event for each id in turn and read the deal's trade
    // number and street address straight back out of the 201 response — every deal in the
    // brokerage, plus an audit entry left in each one. The "does not exist" wording is kept for
    // the out-of-scope case on purpose, so the endpoint cannot be used to tell absent from
    // forbidden.
    if (has('lead_id')) {
      const raw = input.lead_id;
      if (raw === null || raw === '' || raw === undefined) {
        out.lead_id = null;
      } else {
        const leadId = Number(raw);
        if (!Number.isInteger(leadId) || leadId <= 0) add('lead_id', 'Not a valid lead.');
        else {
          const lead = await this.prisma.leads.findFirst({
            where: { AND: [{ id: leadId }, liveLeadWhere(user)] }, select: { id: true },
          });
          if (!lead) add('lead_id', 'That lead does not exist.');
          else out.lead_id = leadId;
        }
      }
    }

    // --- transaction link: must exist, not be deleted, and be one the caller may open ---
    if (has('transaction_id')) {
      const raw = input.transaction_id;
      if (raw === null || raw === '' || raw === undefined) {
        out.transaction_id = null;
      } else {
        const txnId = Number(raw);
        if (!Number.isInteger(txnId) || txnId <= 0) add('transaction_id', 'Not a valid transaction.');
        else {
          const txn = await this.prisma.transactions.findFirst({
            where: { AND: [{ id: txnId, deleted_at: null }, transactionScopeWhere(user)] }, select: { id: true },
          });
          if (!txn) add('transaction_id', 'That transaction does not exist.');
          else out.transaction_id = txnId;
        }
      }
    }

    if (Object.keys(errors).length) {
      const first = Object.values(errors)[0][0];
      const count = Object.values(errors).reduce((a, v) => a + v.length, 0);
      throw new BadRequestException({
        message: count > 1 ? `${first} (and ${count - 1} more error${count - 1 === 1 ? '' : 's'})` : first,
        errors,
      });
    }
    return out;
  }

  /** yyyy-mm-dd → a UTC-midnight Date, so a date never shifts across timezones. */
  private toDate(v: string): Date {
    return new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);
  }

  /**
   * Audit entries hang off a transaction, so only events linked to one are recorded.
   * Best-effort: a calendar change must never fail because the audit write did.
   */
  private async logToTransaction(txnId: number | null, user: AuthUserRecord, action: string, title: string, date: Date, time: string): Promise<void> {
    if (!txnId) return;
    try {
      await this.audit.record(txnId, { id: user.id, name: user.name }, {
        section: 'Calendar',
        action,
        source: 'Manual',
        details: `${title} — ${date.toISOString().slice(0, 10)} ${time}`,
      });
    } catch { /* auditing is best-effort */ }
  }

  // ---------------------------------------------------------------- output
  /** Serialise a row for the client: ISO date, and the linked deal flattened. */
  private present(r: Record<string, unknown>): Record<string, unknown> {
    const txn = r.transactions as { id: number; trade_no: string; property: string | null } | null;
    return {
      id: r.id,
      title: r.title,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
      time: r.time,
      end_time: r.end_time ?? null,
      version: r.version ?? 1,
      recurrence_id: r.recurrence_id ?? null,
      recur_freq: r.recur_freq ?? null,
      type: r.type,
      status: r.status,
      location: r.location,
      description: r.description,
      attendees: r.attendees,
      contact_phone: r.contact_phone,
      contact_email: r.contact_email,
      property_details: r.property_details,
      notes: r.notes,
      enable_reminder: r.enable_reminder,
      reminder_sent: r.reminder_sent,
      transaction_id: r.transaction_id,
      lead_id: r.lead_id,
      trade_no: txn?.trade_no ?? null,
      transaction_property: txn?.property ?? null,
      created_by: r.created_by,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : null,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : null,
    };
  }
}
