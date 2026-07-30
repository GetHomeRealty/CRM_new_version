import type { Area } from '../common/domain';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarSyncService } from '../google/google-calendar-sync.service';
import { AuditService } from '../audit/audit.service';
import { EVENT_TYPES, EVENT_STATUSES, isEventType, isEventStatus } from './calendar.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/** The shape the client sends when creating or updating an event. */
export interface EventInput {
  title?: unknown;
  date?: unknown;
  time?: unknown;
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

/** Filters accepted by the list endpoint. */
export interface EventQuery {
  from?: string;
  to?: string;
  type?: string;
  status?: string;
  transaction_id?: number;
  lead_id?: number;
}

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
    const data = await this.validate(input, true);
    const now = new Date();
    const row = await this.prisma.calendar_events.create({
      data: {
        ...data,
        title: data.title as string,
        date: data.date as Date,
        time: data.time as string,
        user_id: user.id ?? null,
        // The area it was created in. Also what decides which Google calendar it is mirrored to.
        domain: area,
        created_by: user.name,
        created_at: now,
        updated_at: now,
      },
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
    });
    await this.logToTransaction(row.transaction_id, user, 'Event created', row.title, row.date, row.time);
    // Mirror to the user's Google Calendar if they've connected one. Best-effort and non-blocking:
    // a calendar save must never fail because Google was briefly unreachable.
    void this.googleSync.pushEvent(user.id ?? null, row.id);
    return this.present(row);
  }

  async update(id: number, input: EventInput, user: AuthUserRecord, area: Area): Promise<Record<string, unknown>> {
    const existing = await this.prisma.calendar_events.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) } });
    if (!existing) throw new NotFoundException({ message: 'Event not found.' });

    const data = await this.validate(input, false);
    const row = await this.prisma.calendar_events.update({
      where: { id },
      data: { ...data, updated_at: new Date() },
      include: { transactions: { select: { id: true, trade_no: true, property: true } } },
    });
    await this.logToTransaction(row.transaction_id, user, 'Event updated', row.title, row.date, row.time);
    return this.present(row);
  }

  /** Soft delete, so an appointment can be recovered the same way other records are. */
  async remove(id: number, user: AuthUserRecord, area: Area): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.calendar_events.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user), ...this.areaWhere(area) } });
    if (!existing) throw new NotFoundException({ message: 'Event not found.' });
    await this.prisma.calendar_events.update({ where: { id }, data: { deleted_at: new Date(), updated_at: new Date() } });
    await this.logToTransaction(existing.transaction_id, user, 'Event deleted', existing.title, existing.date, existing.time);
    return { deleted: true };
  }

  // ------------------------------------------------------------ validation
  /**
   * Validate and normalise an event payload. `requireCore` is true on create, where title,
   * date, time and type must all be present; on update only the supplied fields are checked.
   */
  private async validate(input: EventInput, requireCore: boolean): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const add = (field: string, msg: string) => { (errors[field] ??= []).push(msg); };
    const out: Record<string, unknown> = {};
    const has = (k: keyof EventInput) => input[k] !== undefined;
    const str = (v: unknown) => String(v ?? '').trim();

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
    if (has('lead_id')) {
      const raw = input.lead_id;
      if (raw === null || raw === '' || raw === undefined) {
        out.lead_id = null;
      } else {
        const leadId = Number(raw);
        if (!Number.isInteger(leadId) || leadId <= 0) add('lead_id', 'Not a valid lead.');
        else {
          const lead = await this.prisma.leads.findFirst({ where: { id: leadId, deleted_at: null }, select: { id: true } });
          if (!lead) add('lead_id', 'That lead does not exist.');
          else out.lead_id = leadId;
        }
      }
    }

    // --- transaction link: must exist and not be deleted ---
    if (has('transaction_id')) {
      const raw = input.transaction_id;
      if (raw === null || raw === '' || raw === undefined) {
        out.transaction_id = null;
      } else {
        const txnId = Number(raw);
        if (!Number.isInteger(txnId) || txnId <= 0) add('transaction_id', 'Not a valid transaction.');
        else {
          const txn = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null }, select: { id: true } });
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
