import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { normalizePhone } from '../meta/meta-lead-mapper';
import type { AuthUserRecord } from '../auth/auth.types';
import { isAgent, isSuperAdmin } from '../core/authz';
import {
  EMAIL_SHAPE, LEADS_PER_PAGE, MAX_PER_PAGE, MAX_IMPORT_ROWS, NONE_FILTER_VALUE,
  RECENT_LEAD_DAYS, WEBSITE_ENQUIRY_SOURCES, DASHBOARD_LEAD_SOURCES,
  isClientType, isConversion, isGender, isLeadResponse, isLeadSource, isLeadStatus, isLeadType,
} from './lead.constants';

const str = (v: unknown): string => String(v ?? '').trim();
const parseJsonArray = (v: string | null): string[] => {
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the client may send when creating or updating a lead. */
export interface LeadInput {
  name?: unknown; email?: unknown; phone?: unknown; location?: unknown; property?: unknown;
  lead_status?: unknown; lead_type?: unknown; lead_source?: unknown; lead_response?: unknown;
  client_type?: unknown; lead_conversion?: unknown;
  gender?: unknown; language?: unknown; religion?: unknown; age?: unknown;
  date_of_birth?: unknown; marriage_day?: unknown;
  notes?: unknown; tags?: unknown; assigned_to?: unknown;
  property_preferences?: unknown;
  property_address?: unknown; property_price?: unknown; bedrooms?: unknown;
  bathrooms?: unknown; square_footage?: unknown; key_features?: unknown;
}

/** Filters accepted by the list endpoint. */
export interface LeadQuery {
  page?: string; limit?: string; search?: string;
  leadStatus?: string; leadType?: string; leadSource?: string; leadResponse?: string;
  clientType?: string; leadConversion?: string; tag?: string;
  gender?: string; language?: string; religion?: string;
  minAge?: string; maxAge?: string; assignedTo?: string; recent?: string;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
    private readonly notifications: LeadNotificationService,
  ) {}

  // --------------------------------------------------------------- scoping
  /**
   * Leads are private to their owner, for EVERY role including admins and super-admins. A user
   * sees a lead only if they created it or it was assigned to them — nobody, however senior, sees
   * another person's book. The one shared case is a brokerage-assigned lead: the admin who
   * created it (owner) and the agent it was handed to (assignee) both see that one lead, which is
   * what makes assignment work.
   *
   * The deal core — transactions, invoices, reports, commissions — is deliberately NOT scoped
   * this way; those stay shared across the brokerage. Only the personal CRM modules are private.
   */
  /**
   * What this person may see. An agent's book is confidential.
   *
   * Everybody — agent, manager, broker, administrator alike — sees the leads they own and the leads
   * someone has assigned them. Nobody sees anyone else's. A manager does not get to read their
   * agents' pipelines, and one agent never sees another's until the lead is handed over, at which
   * point both work it together.
   *
   * The administrator still sees the brokerage's own leads because the BROKERAGE OWNS THEM — the
   * intake from Meta, Google and imports is recorded against the administrator's account, not
   * because administrators are exempt from this rule. That distinction is the whole point: there is
   * no role here that can read a colleague's book, only an owner and the people they hand a lead to.
   *
   * A lead with no owner at all is brokerage intake that has not been attributed yet. It goes to the
   * top tier rather than to nobody, so an import that forgets to stamp an owner surfaces somewhere
   * instead of vanishing.
   */
  private scopeWhere(user: AuthUserRecord): Prisma.leadsWhereInput {
    const id = user.id ?? -1;
    const mine: Prisma.leadsWhereInput[] = [{ assigned_to: id }, { owner_user_id: id }];
    if (isSuperAdmin(user)) mine.push({ owner_user_id: null });
    return { OR: mine };
  }

  /** The identity lock (name/email/phone/source/assignment, and delete) is an agent-only restriction. */
  private isAgent(user: AuthUserRecord): boolean {
    return isAgent(user);
  }

  // ------------------------------------------------------------------ read
  /** Paginated list plus the header counters, both computed from the same filter set. */
  async list(user: AuthUserRecord, q: LeadQuery): Promise<Record<string, unknown>> {
    const where = this.buildWhere(user, q);
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(MAX_PER_PAGE, Math.max(1, Number(q.limit ?? LEADS_PER_PAGE) || LEADS_PER_PAGE));

    const [rows, total, stats] = await Promise.all([
      this.prisma.leads.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { lead_calls: true, lead_tasks: true } },
          lead_tasks: { where: { status: 'pending' }, select: { id: true } },
        },
      }),
      this.prisma.leads.count({ where }),
      this.stats(where),
    ]);

    const assignees = await this.assigneeNames(rows.map((r) => r.assigned_to));

    return {
      data: rows.map((r) => this.present(r, assignees)),
      meta: { current_page: page, per_page: limit, last_page: Math.max(1, Math.ceil(total / limit)), total },
      stats,
    };
  }

  /** Header counters for the current filter set. */
  private async stats(where: Prisma.leadsWhereInput): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - RECENT_LEAD_DAYS * 24 * 60 * 60 * 1000);
    const count = (extra: Prisma.leadsWhereInput) => this.prisma.leads.count({ where: { AND: [where, extra] } });

    const [total, noCalls, websiteEnquiries, recent, hot, warm, cold, mild, closed, ...sourceCounts] = await Promise.all([
      this.prisma.leads.count({ where }),
      count({ lead_calls: { none: {} } }),
      count({ lead_source: { in: [...WEBSITE_ENQUIRY_SOURCES] } }),
      count({ created_at: { gte: since } }),
      count({ lead_status: 'hot' }),
      count({ lead_status: 'warm' }),
      count({ lead_status: 'cold' }),
      count({ lead_status: 'mild' }),
      count({ lead_status: 'closed' }),
      ...DASHBOARD_LEAD_SOURCES.map((s) => count({ lead_source: s.value })),
    ]);

    // "other" absorbs linkedin, youtube and leads with no source recorded, so the parts of the
    // Dashboard breakdown always add up to the total rather than silently losing rows.
    const bySource: Record<string, number> = {};
    DASHBOARD_LEAD_SOURCES.forEach((s, i) => { bySource[s.key] = sourceCounts[i]; });
    bySource.other = total - sourceCounts.reduce((a, b) => a + b, 0);

    return { total, noCalls, websiteEnquiries, recent, byStatus: { hot, warm, cold, mild, closed }, bySource };
  }

  /**
   * Every lead task the signed-in user is allowed to see, for the Dashboard.
   *
   * Scoped through the lead exactly like the lists are, so an agent sees tasks on their own leads
   * and nobody else's. Ordered the way an agent works the list: still-open tasks first, then by
   * due date, so whatever is overdue sits at the top.
   */
  async allTasks(user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.lead_tasks.findMany({
      where: { leads: { deleted_at: null, ...this.scopeWhere(user) } },
      include: { leads: { select: { id: true, name: true } } },
      orderBy: [{ due_date: 'asc' }, { id: 'asc' }],
    });

    const assignees = await this.assigneeNames(rows.map((t) => t.assigned_to));
    const openFirst = (s: string): number => (s === 'pending' ? 0 : s === 'cancelled' ? 2 : 1);

    return rows
      .sort((a, b) => openFirst(a.status) - openFirst(b.status))
      .map((t) => ({
        id: t.id,
        lead_id: t.lead_id,
        lead_name: t.leads.name,
        title: t.title,
        due_date: t.due_date.toISOString().slice(0, 10),
        description: t.description,
        status: t.status,
        priority: t.priority,
        assigned_to: t.assigned_to,
        assigned_to_name: t.assigned_to ? assignees.get(t.assigned_to) ?? null : null,
        created_by: t.created_by,
        created_at: t.created_at?.toISOString() ?? null,
      }));
  }

  /**
   * Every lead showing the caller can see, for the Dashboard. Scoped through the lead exactly like
   * the lists, so an agent sees showings on their own leads and nobody else's. Ordered by date so
   * the soonest sits at the top.
   */
  async allShowings(user: AuthUserRecord): Promise<Record<string, unknown>[]> {
    // Only today and upcoming — past showings drop off the dashboard so it reads as a to-do list.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rows = await this.prisma.lead_showings.findMany({
      where: { showing_date: { gte: todayStart }, leads: { deleted_at: null, ...this.scopeWhere(user) } },
      include: { leads: { select: { id: true, name: true } } },
      orderBy: [{ showing_date: 'asc' }, { time: 'asc' }],
    });
    return rows.map((s) => ({
      id: s.id,
      lead_id: s.lead_id,
      lead_name: s.leads.name,
      showing_date: s.showing_date.toISOString().slice(0, 10),
      time: s.time,
      property: s.property,
      notes: s.notes,
      status: s.status,
      created_by: s.created_by,
      created_at: s.created_at?.toISOString() ?? null,
    }));
  }

  async get(id: number, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const row = await this.prisma.leads.findFirst({
      where: { id, deleted_at: null, ...this.scopeWhere(user) },
      include: {
        _count: { select: { lead_calls: true, lead_tasks: true } },
        lead_tasks: { orderBy: [{ due_date: 'asc' }, { id: 'asc' }] },
        lead_notes: { orderBy: [{ pinned: 'desc' }, { id: 'desc' }] },
        lead_showings: { orderBy: [{ showing_date: 'asc' }, { time: 'asc' }] },
        lead_calls: {
          orderBy: { called_at: 'desc' },
          // Metadata only — the audio blob is never dragged into a lead payload.
          include: { recording: { select: { id: true, filename: true, content_type: true, size: true } } },
        },
        // Oldest first: the SMS panel reads as a conversation, not a feed.
        lead_messages: { orderBy: [{ sent_at: 'asc' }, { id: 'asc' }] },
        lead_emails: { orderBy: { sent_at: 'desc' } },
      },
    });
    if (!row) throw new NotFoundException({ message: 'Lead not found.' });

    const ids = [row.assigned_to, ...row.lead_tasks.map((t) => t.assigned_to)];
    const assignees = await this.assigneeNames(ids);

    return {
      ...this.present(row, assignees),
      notes_history: row.lead_notes.map((n) => ({
        id: n.id, content: n.content, pinned: n.pinned,
        created_by: n.created_by, created_at: n.created_at?.toISOString() ?? null,
      })),
      tasks: row.lead_tasks.map((t) => ({
        id: t.id, title: t.title, due_date: t.due_date.toISOString().slice(0, 10),
        description: t.description, status: t.status, priority: t.priority,
        assigned_to: t.assigned_to, assigned_to_name: t.assigned_to ? assignees.get(t.assigned_to) ?? null : null,
        created_by: t.created_by, created_at: t.created_at?.toISOString() ?? null,
      })),
      showings: row.lead_showings.map((s) => ({
        id: s.id, showing_date: s.showing_date.toISOString().slice(0, 10), time: s.time,
        property: s.property, notes: s.notes, status: s.status,
        created_by: s.created_by, created_at: s.created_at?.toISOString() ?? null,
      })),
      calls: row.lead_calls.map((c) => ({
        id: c.id, called_at: c.called_at.toISOString(), duration: c.duration,
        outcome: c.outcome, notes: c.notes, created_by: c.created_by,
        provider_sid: c.provider_sid, status: c.status,
        recording: c.recording ?? null,
      })),
      messages: row.lead_messages.map((m) => ({
        id: m.id, direction: m.direction, status: m.status, body: m.body, phone: m.phone,
        error_code: m.error_code, error_message: m.error_message,
        sent_at: m.sent_at.toISOString(), created_by: m.created_by,
      })),
      emails: row.lead_emails.map((e) => ({
        id: e.id, recipient: e.recipient, subject: e.subject, body: e.body,
        status: e.status, error: e.error, sent_by: e.sent_by, sent_at: e.sent_at.toISOString(),
      })),
    };
  }

  // ----------------------------------------------------------------- write
  async create(input: LeadInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const data = await this.validate(input, true);
    const now = new Date();
    const row = await this.prisma.leads.create({
      data: {
        ...data,
        name: data.name as string,
        email: data.email as string,
        // May be left unassigned; the creator still sees it through owner_user_id below, so a new
        // lead does not have to be assigned to anyone to be visible to the person who made it.
        assigned_to: (data.assigned_to as number | null | undefined) ?? null,
        owner_user_id: user.id ?? null,
        created_by: user.name,
        created_at: now,
        updated_at: now,
      },
      include: { _count: { select: { lead_calls: true, lead_tasks: true } } },
    });
    await this.audit.record(user, 'Lead created', row.name, `${row.email}${row.phone ? ` · ${row.phone}` : ''}`);
    // Best-effort inbound-lead email (Meta / Google Ads / Website only); never blocks creation.
    void this.notifications.notifyNewLead(row);
    return this.present(row, await this.assigneeNames([row.assigned_to]));
  }

  /**
   * A lead the brokerage handed to an agent, as opposed to one the agent created themselves.
   *
   * `owner_user_id` is the creator. When an agent is working a lead they did not create, the
   * brokerage owns the relationship: the agent may add and change activity all they like, but the
   * lead's identity — who it is, how to reach them, where it came from, and whose desk it sits on
   * — is not theirs to rewrite. A lead an agent created themselves is fully theirs.
   */
  private isBrokerageAssigned(existing: { owner_user_id: number | null }, user: AuthUserRecord): boolean {
    return this.isAgent(user) && existing.owner_user_id !== (user.id ?? -1);
  }

  /** Fields locked on a brokerage-assigned lead, in the words the agent would recognise. */
  private static readonly LOCKED_FIELDS: Record<string, string> = {
    // The name is who the lead IS. An agent working someone else's lead may record everything about
    // the conversation and change nothing about the identity.
    name: 'name',
    email: 'email address',
    phone: 'phone number',
    lead_source: 'lead source',
    assigned_to: 'assignment',
  };

  async update(id: number, input: LeadInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const existing = await this.prisma.leads.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user) } });
    if (!existing) throw new NotFoundException({ message: 'Lead not found.' });

    const data = await this.validate(input, false, id);

    /*
     * On a brokerage-assigned lead an agent may change everything except the four identity
     * fields. This is checked against what would ACTUALLY change, not merely what was sent: the
     * lead editor posts the whole form every save, so the untouched email arrives every time.
     * Rejecting on presence would make the form unusable; rejecting on a real change is the rule.
     */
    if (this.isBrokerageAssigned(existing, user)) {
      const attempted = Object.keys(LeadsService.LOCKED_FIELDS).filter(
        (k) => k in data && String((existing as Record<string, unknown>)[k] ?? '') !== String((data as Record<string, unknown>)[k] ?? ''),
      );
      if (attempted.length) {
        const names = attempted.map((k) => LeadsService.LOCKED_FIELDS[k]);
        throw new ForbiddenException({
          message: `This lead was assigned to you by the brokerage, so you cannot change its ${names.join(', ')}. Ask an administrator if it needs to change.`,
        });
      }
    }

    const row = await this.prisma.leads.update({
      where: { id },
      data: { ...data, updated_at: new Date() },
      include: { _count: { select: { lead_calls: true, lead_tasks: true } } },
    });

    // Record the fields that actually changed, so the trail is readable.
    const changed = Object.keys(data).filter((k) => String((existing as Record<string, unknown>)[k] ?? '') !== String((row as Record<string, unknown>)[k] ?? ''));
    await this.audit.record(user, 'Lead updated', row.name, changed.length ? `Changed: ${changed.join(', ')}` : 'No field values changed');
    return this.present(row, await this.assigneeNames([row.assigned_to]));
  }

  /** Soft delete — the lead moves to Recently Deleted and drops out of every list query. */
  async remove(id: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.leads.findFirst({ where: { id, deleted_at: null, ...this.scopeWhere(user) } });
    if (!existing) throw new NotFoundException({ message: 'Lead not found.' });
    // An agent cannot delete a lead the brokerage gave them — only one they created themselves.
    if (this.isBrokerageAssigned(existing, user)) {
      throw new ForbiddenException({
        message: 'This lead was assigned to you by the brokerage, so it cannot be deleted here. Ask an administrator.',
      });
    }
    const now = new Date();
    await this.prisma.leads.update({ where: { id }, data: { deleted_at: now, deleted_by: user.name, updated_at: now } });
    await this.audit.record(user, 'Lead deleted', existing.name, 'Moved to Recently Deleted');
    return { deleted: true };
  }

  async bulkDelete(ids: number[], user: AuthUserRecord): Promise<{ deleted: number }> {
    const valid = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    if (!valid.length) throw new BadRequestException({ message: 'Select at least one lead to delete.' });
    const rows = await this.prisma.leads.findMany({
      where: {
        id: { in: valid }, deleted_at: null, ...this.scopeWhere(user),
        // An agent's bulk delete silently skips brokerage-assigned leads rather than failing the
        // whole batch — the single-delete path reports the block explicitly; here they are simply
        // not eligible, the same way a lead they cannot see is not.
        ...(this.isAgent(user) ? { owner_user_id: user.id ?? -1 } : {}),
      },
      select: { id: true, name: true },
    });
    if (!rows.length) return { deleted: 0 };
    const now = new Date();
    const res = await this.prisma.leads.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { deleted_at: now, deleted_by: user.name, updated_at: now },
    });
    // Name the leads, not just the count — otherwise the trail can't answer "which ones?".
    const names = rows.map((r) => r.name);
    const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? `, and ${names.length - 10} more` : '');
    await this.audit.record(user, 'Leads bulk deleted', `${res.count} lead(s)`, `Moved to Recently Deleted: ${shown}`);
    return { deleted: res.count };
  }

  // ------------------------------------------------------- recently deleted
  async listDeleted(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const where: Prisma.leadsWhereInput = { deleted_at: { not: null }, ...this.scopeWhere(user) };
    const [rows, count] = await Promise.all([
      this.prisma.leads.findMany({ where, orderBy: { deleted_at: 'desc' }, take: 200 }),
      this.prisma.leads.count({ where }),
    ]);
    return {
      count,
      data: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email, phone: r.phone, location: r.location,
        lead_status: r.lead_status,
        deleted_at: r.deleted_at?.toISOString() ?? null,
        deleted_by: r.deleted_by,
      })),
    };
  }

  async restore(id: number, user: AuthUserRecord): Promise<{ restored: boolean }> {
    const row = await this.prisma.leads.findFirst({ where: { id, deleted_at: { not: null }, ...this.scopeWhere(user) } });
    if (!row) throw new NotFoundException({ message: 'Deleted lead not found.' });
    await this.prisma.leads.update({ where: { id }, data: { deleted_at: null, deleted_by: null, updated_at: new Date() } });
    await this.audit.record(user, 'Lead restored', row.name, 'Restored from Recently Deleted');
    return { restored: true };
  }

  /**
   * Permanent delete. Notes, tasks, showings and calls cascade; campaign recipient rows keep
   * their email address but lose the lead link, so past campaign results stay intact.
   */
  async purge(id: number, user: AuthUserRecord): Promise<{ purged: boolean }> {
    const row = await this.prisma.leads.findFirst({ where: { id, deleted_at: { not: null }, ...this.scopeWhere(user) } });
    if (!row) throw new NotFoundException({ message: 'Deleted lead not found.' });
    await this.prisma.leads.delete({ where: { id } });
    await this.audit.record(user, 'Lead permanently deleted', row.name, row.email);
    return { purged: true };
  }

  // ---------------------------------------------------------------- import
  /**
   * Import leads from CSV. Rows without a usable email are counted as invalid, and an address
   * already on file is tagged rather than duplicated.
   */
  async import(csv: string, tag: string, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const rows = this.parseCsv(csv);
    if (!rows.length) {
      throw new BadRequestException({ message: 'No rows found. Include a header row with at least name and email.' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({ message: `That file has ${rows.length} rows, above the ${MAX_IMPORT_ROWS}-row limit. Split it and import in batches.` });
    }

    let imported = 0, tagged = 0, invalid = 0, duplicate = 0;
    const now = new Date();
    const seen = new Set<string>();

    for (const row of rows) {
      const email = str(row.email ?? row.emailaddress);
      if (!EMAIL_SHAPE.test(email)) { invalid++; continue; }
      const key = email.toLowerCase();
      if (seen.has(key)) { duplicate++; continue; }
      seen.add(key);

      const existing = await this.prisma.leads.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (existing) {
        duplicate++;
        if (tag) {
          const tags = parseJsonArray(existing.tags);
          if (!tags.includes(tag)) {
            await this.prisma.leads.update({ where: { id: existing.id }, data: { tags: JSON.stringify([...tags, tag]), updated_at: now } });
            tagged++;
          }
        }
        continue;
      }

      const pick = (...keys: string[]): string | null => {
        for (const k of keys) { const v = str(row[k]); if (v) return v; }
        return null;
      };

      await this.prisma.leads.create({
        data: {
          name: pick('name', 'fullname', 'firstname') ?? email.split('@')[0],
          email,
          phone: pick('phone', 'phonenumber', 'mobile', 'number', 'contact'),
          location: pick('location', 'address', 'city'),
          property: pick('property'),
          lead_status: this.pickFrom(row, ['leadstatus', 'status'], isLeadStatus),
          lead_type: this.pickFrom(row, ['leadtype', 'type'], isLeadType),
          lead_source: this.pickFrom(row, ['leadsource', 'source'], isLeadSource),
          lead_response: this.pickFrom(row, ['leadresponse', 'response'], isLeadResponse),
          client_type: this.pickFrom(row, ['clienttype'], isClientType),
          tags: JSON.stringify(tag ? [tag] : []),
          // Imported leads belong to whoever imported them — assigned to and owned by them, so
          // they are private to that person like every other lead.
          assigned_to: user.id ?? null,
          owner_user_id: user.id ?? null,
          created_by: user.name,
          created_at: now,
          updated_at: now,
        },
      });
      imported++;
    }

    if (tag) await this.registerTag(tag, user);
    await this.audit.record(user, 'Leads imported', `${imported} lead(s)`,
      `${imported} imported, ${tagged} tagged, ${duplicate} already on file, ${invalid} invalid${tag ? ` · tag "${tag}"` : ''}`);

    return {
      imported, tagged, duplicate, invalid, tag: tag || null,
      message: `Imported ${imported} new lead${imported === 1 ? '' : 's'}${tag ? ` tagged "${tag}"` : ''}.`,
    };
  }

  /** Take the first column whose value is a recognised vocabulary term. */
  private pickFrom(row: Record<string, string>, keys: string[], valid: (v: string) => boolean): string | null {
    for (const k of keys) {
      const v = str(row[k]);
      if (v && valid(v)) return v;
      // Accept a case difference against the stored spelling (e.g. "Buyer" → "buyer").
      if (v) {
        const lower = v.toLowerCase();
        if (valid(lower)) return lower;
      }
    }
    return null;
  }

  /** Rows for the CSV export, honouring the same filters as the list. */
  async exportRows(user: AuthUserRecord, q: LeadQuery, ids: number[]): Promise<Record<string, unknown>[]> {
    const where: Prisma.leadsWhereInput = ids.length
      ? { AND: [{ id: { in: ids }, deleted_at: null }, this.scopeWhere(user)] }
      : this.buildWhere(user, q);
    const rows = await this.prisma.leads.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: MAX_IMPORT_ROWS });
    const assignees = await this.assigneeNames(rows.map((r) => r.assigned_to));
    return rows.map((r) => ({
      Name: r.name,
      Email: r.email,
      Phone: r.phone ?? '',
      Location: r.location ?? '',
      Property: r.property ?? '',
      Status: r.lead_status ?? '',
      Type: r.lead_type ?? '',
      Source: r.lead_source ?? '',
      Response: r.lead_response ?? '',
      'Client Type': r.client_type ?? '',
      Tags: parseJsonArray(r.tags).join(' | '),
      'Assigned To': r.assigned_to ? assignees.get(r.assigned_to) ?? '' : '',
      Unsubscribed: r.unsubscribed ? 'Yes' : 'No',
      Created: r.created_at ? r.created_at.toISOString().slice(0, 10) : '',
    }));
  }

  // ------------------------------------------------------------------ tags
  /** Every known tag: the registry unioned with tags actually present on leads. */
  async tags(): Promise<{ tags: string[]; counts: { name: string; count: number }[] }> {
    const [rows, registered] = await Promise.all([
      this.prisma.leads.findMany({ where: { deleted_at: null }, select: { tags: true } }),
      this.prisma.lead_tags.findMany({ select: { name: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of parseJsonArray(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const r of registered) if (!counts.has(r.name)) counts.set(r.name, 0);

    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    return { tags: names, counts: names.map((name) => ({ name, count: counts.get(name) ?? 0 })) };
  }

  async registerTag(name: string, user: AuthUserRecord): Promise<{ tag: string }> {
    const tag = str(name).slice(0, 64);
    if (!tag) throw new BadRequestException({ message: 'A tag name is required.' });
    await this.prisma.lead_tags.upsert({
      where: { name: tag },
      create: { name: tag, created_by: user.name, created_at: new Date() },
      update: {},
    });
    return { tag };
  }

  /**
   * Delete a tag from the registry and pull it off every lead. Returns the affected lead ids
   * so the deletion can be undone from the UI.
   */
  async deleteTag(name: string, user: AuthUserRecord): Promise<{ tag: string; removed: number; lead_ids: number[] }> {
    const tag = str(name);
    if (!tag) throw new BadRequestException({ message: 'A tag name is required.' });
    const rows = await this.prisma.leads.findMany({ where: { deleted_at: null }, select: { id: true, tags: true } });
    const now = new Date();
    const affected: number[] = [];
    for (const r of rows) {
      const tags = parseJsonArray(r.tags);
      if (!tags.includes(tag)) continue;
      await this.prisma.leads.update({ where: { id: r.id }, data: { tags: JSON.stringify(tags.filter((t) => t !== tag)), updated_at: now } });
      affected.push(r.id);
    }
    await this.prisma.lead_tags.deleteMany({ where: { name: tag } });
    await this.audit.record(user, 'Lead tag deleted', tag, `Removed from ${affected.length} lead(s)`);
    return { tag, removed: affected.length, lead_ids: affected };
  }

  /** Add or remove a tag across an explicit set of leads. */
  async tagLeads(ids: number[], tag: string, mode: 'add' | 'remove', user: AuthUserRecord): Promise<{ changed: number; message: string }> {
    const name = str(tag).slice(0, 64);
    if (!name) throw new BadRequestException({ message: 'Enter a tag to apply.' });
    const valid = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    if (!valid.length) throw new BadRequestException({ message: 'Select at least one lead first.' });

    const rows = await this.prisma.leads.findMany({
      where: { id: { in: valid }, deleted_at: null, ...this.scopeWhere(user) },
      select: { id: true, tags: true },
    });
    const now = new Date();
    let changed = 0;
    for (const r of rows) {
      const tags = parseJsonArray(r.tags);
      const has = tags.includes(name);
      if (mode === 'add' ? has : !has) continue;
      const next = mode === 'add' ? [...tags, name] : tags.filter((t) => t !== name);
      await this.prisma.leads.update({ where: { id: r.id }, data: { tags: JSON.stringify(next), updated_at: now } });
      changed++;
    }
    if (mode === 'add' && changed) await this.registerTag(name, user);
    return {
      changed,
      message: mode === 'add'
        ? `Tagged ${changed} lead${changed === 1 ? '' : 's'} with "${name}".`
        : `Removed "${name}" from ${changed} lead${changed === 1 ? '' : 's'}.`,
    };
  }

  // ------------------------------------------------------------ filtering
  private buildWhere(user: AuthUserRecord, q: LeadQuery): Prisma.leadsWhereInput {
    const and: Prisma.leadsWhereInput[] = [{ deleted_at: null }, this.scopeWhere(user)];

    const search = str(q.search);
    if (search) {
      const like = { contains: search, mode: 'insensitive' as const };
      and.push({ OR: [{ name: like }, { email: like }, { phone: like }, { location: like }, { property: like }] });
    }

    // Dropdown filters. The NONE sentinel means "never filled in", which for these columns
    // covers both a NULL and an empty string left behind by an import.
    const field = (col: keyof Prisma.leadsWhereInput, value: string | undefined) => {
      const v = str(value);
      if (!v) return;
      if (v === NONE_FILTER_VALUE) and.push({ OR: [{ [col]: null }, { [col]: '' }] } as Prisma.leadsWhereInput);
      else and.push({ [col]: v } as Prisma.leadsWhereInput);
    };
    field('lead_status', q.leadStatus);
    field('lead_type', q.leadType);
    field('lead_source', q.leadSource);
    field('lead_response', q.leadResponse);
    field('client_type', q.clientType);
    field('lead_conversion', q.leadConversion);
    field('language', q.language);
    field('religion', q.religion);
    field('gender', q.gender);

    const tag = str(q.tag);
    if (tag === NONE_FILTER_VALUE) {
      and.push({ OR: [{ tags: null }, { tags: '' }, { tags: '[]' }] });
    } else if (tag) {
      // `tags` is a JSON array in a text column, so match the quoted element rather than a
      // bare substring — otherwise "VIP" would also match a tag named "VIP Buyer".
      and.push({ tags: { contains: JSON.stringify(tag) } });
    }

    const minAge = Number(q.minAge), maxAge = Number(q.maxAge);
    if (Number.isFinite(minAge) && str(q.minAge)) and.push({ age: { gte: minAge } });
    if (Number.isFinite(maxAge) && str(q.maxAge)) and.push({ age: { lte: maxAge } });

    const assigned = str(q.assignedTo);
    if (assigned === 'unassigned') and.push({ assigned_to: null });
    else if (assigned && Number(assigned) > 0) and.push({ assigned_to: Number(assigned) });

    if (str(q.recent) === 'true') {
      and.push({ created_at: { gte: new Date(Date.now() - RECENT_LEAD_DAYS * 24 * 60 * 60 * 1000) } });
    }

    return { AND: and };
  }

  // ------------------------------------------------------------ validation
  /**
   * Validate and normalise a lead payload. On create the core identity fields are required;
   * on update only the supplied fields are checked, so a partial patch is safe.
   */
  private async validate(input: LeadInput, requireCore: boolean, selfId?: number): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };
    const out: Record<string, unknown> = {};
    const has = (k: keyof LeadInput) => input[k] !== undefined;

    if (requireCore || has('name')) {
      const name = str(input.name);
      if (!name) add('name', 'A name is required.');
      else if (name.length > 255) add('name', 'The name must be 255 characters or fewer.');
      else out.name = name;
    }

    if (requireCore || has('email')) {
      const email = str(input.email);
      if (!email) add('email', 'An email address is required.');
      else if (!EMAIL_SHAPE.test(email)) add('email', 'Enter a valid email address.');
      else if (email.length > 255) add('email', 'The email must be 255 characters or fewer.');
      else {
        // A duplicate address would silently split one person's history across two records,
        // and campaign sends dedupe by address anyway.
        const clash = await this.prisma.leads.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, deleted_at: null, ...(selfId ? { id: { not: selfId } } : {}) },
          select: { id: true, name: true },
        });
        if (clash) add('email', `${clash.name} already uses that email address (lead #${clash.id}).`);
        else out.email = email;
      }
    }

    // --- optional free text ---
    const text: [keyof LeadInput, string, number][] = [
      ['phone', 'phone', 64],
      ['location', 'location', 255],
      ['property', 'property', 255],
      ['language', 'language', 64],
      ['religion', 'religion', 64],
      ['notes', 'notes', 20000],
      ['property_address', 'property_address', 255],
      ['property_price', 'property_price', 64],
      ['bedrooms', 'bedrooms', 16],
      ['bathrooms', 'bathrooms', 16],
      ['square_footage', 'square_footage', 24],
      ['key_features', 'key_features', 5000],
    ];
    for (const [key, field, max] of text) {
      if (!has(key)) continue;
      const v = str(input[key]);
      if (v.length > max) add(field, `Must be ${max} characters or fewer.`);
      else out[field] = v === '' ? null : v;
    }

    // Keep the digits-only form in step with the phone. Meta lead import matches on it to avoid
    // creating a second record for someone already on file under a different number format.
    if (has('phone')) out.phone_normalized = normalizePhone(input.phone);

    // --- vocabularies: an empty value clears the field ---
    const vocab: [keyof LeadInput, string, (v: string) => boolean, string][] = [
      ['lead_status', 'lead_status', isLeadStatus, 'lead status'],
      ['lead_type', 'lead_type', isLeadType, 'lead type'],
      ['lead_source', 'lead_source', isLeadSource, 'lead source'],
      ['lead_response', 'lead_response', isLeadResponse, 'lead response'],
      ['client_type', 'client_type', isClientType, 'client type'],
      ['lead_conversion', 'lead_conversion', isConversion, 'conversion'],
      ['gender', 'gender', isGender, 'gender'],
    ];
    for (const [key, field, valid, label] of vocab) {
      if (!has(key)) continue;
      const v = str(input[key]);
      if (v === '') out[field] = null;
      else if (!valid(v)) add(field, `That is not a recognised ${label}.`);
      else out[field] = v;
    }

    // --- age ---
    if (has('age')) {
      const raw = input.age;
      if (raw === null || raw === '') out.age = null;
      else {
        const age = Number(raw);
        if (!Number.isInteger(age) || age < 0 || age > 120) add('age', 'Enter an age between 0 and 120.');
        else out.age = age;
      }
    }

    // --- dates ---
    for (const key of ['date_of_birth', 'marriage_day'] as const) {
      if (!has(key)) continue;
      const v = str(input[key]).slice(0, 10);
      if (v === '') { out[key] = null; continue; }
      if (!DATE_RE.test(v)) { add(key, 'The date must be in YYYY-MM-DD format.'); continue; }
      const d = new Date(`${v}T00:00:00.000Z`);
      // `new Date('2026-02-30')` rolls over to March 2 instead of returning NaN, so compare
      // the round trip rather than only checking for NaN.
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) add(key, 'That date does not exist.');
      else out[key] = d;
    }

    // --- tags ---
    if (has('tags')) {
      const list = Array.isArray(input.tags) ? (input.tags as unknown[]).map(str).filter(Boolean) : [];
      out.tags = JSON.stringify([...new Set(list)].slice(0, 50));
    }

    /*
     * --- property preferences (stored as JSON) ---
     *
     * A lead may hold several sets of preferences — someone shopping for a condo to live in and
     * a duplex to rent out wants both recorded, not one overwritten by the other. They are stored
     * as an array. A bare object is still accepted and wrapped, so anything written before this
     * change, and any caller not yet updated, keeps working.
     */
    if (has('property_preferences')) {
      const p = input.property_preferences;
      if (p === null || p === '') out.property_preferences = null;
      else if (Array.isArray(p)) {
        const kept = p.filter((one) => one && typeof one === 'object');
        out.property_preferences = kept.length ? JSON.stringify(kept) : null;
      } else if (typeof p === 'object') out.property_preferences = JSON.stringify([p]);
      else add('property_preferences', 'Property preferences must be an object or a list of them.');
    }

    // --- assignment: must be a real, active user ---
    if (has('assigned_to')) {
      const raw = input.assigned_to;
      if (raw === null || raw === '' || raw === 'unassigned') out.assigned_to = null;
      else {
        const uid = Number(raw);
        if (!Number.isInteger(uid) || uid <= 0) add('assigned_to', 'Not a valid user.');
        else {
          const u = await this.prisma.users.findFirst({ where: { id: uid }, select: { id: true } });
          if (!u) add('assigned_to', 'That user does not exist.');
          else out.assigned_to = uid;
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

  // ---------------------------------------------------------------- shared
  /** Resolve assignee ids to display names in one query. */
  private async assigneeNames(ids: (number | null)[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((n): n is number => typeof n === 'number' && n > 0))];
    if (!wanted.length) return new Map();
    const users = await this.prisma.users.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Minimal RFC4180 CSV reader → lowercase-keyed rows (spaces and punctuation stripped). */
  private parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let field = '', row: string[] = [], quoted = false;
    const src = String(text ?? '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
    return rows.slice(1)
      .filter((r) => r.some((c) => c.trim() !== ''))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  }

  // ---------------------------------------------------------------- output
  private present(r: Record<string, unknown>, assignees: Map<number, string>): Record<string, unknown> {
    const counts = r._count as { lead_calls: number; lead_tasks: number } | undefined;
    const pending = Array.isArray(r.lead_tasks) ? (r.lead_tasks as unknown[]).length : undefined;
    const assignedTo = r.assigned_to as number | null;
    const date = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : null);

    return {
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      location: r.location,
      property: r.property,
      lead_status: r.lead_status,
      lead_type: r.lead_type,
      lead_source: r.lead_source,
      lead_response: r.lead_response,
      client_type: r.client_type,
      lead_conversion: r.lead_conversion,
      tags: parseJsonArray(r.tags as string | null),
      gender: r.gender,
      language: r.language,
      religion: r.religion,
      age: r.age,
      date_of_birth: date(r.date_of_birth),
      marriage_day: date(r.marriage_day),
      notes: r.notes,
      // Always a list, so the client has one shape to render. Rows written before preferences
      // could repeat hold a bare object; those are wrapped here rather than migrated, because a
      // Meta import can still write one and the wrap costs nothing.
      property_preferences: (() => {
        try {
          const parsed: unknown = JSON.parse((r.property_preferences as string) ?? 'null');
          if (parsed === null || parsed === undefined) return null;
          if (Array.isArray(parsed)) return parsed.length ? parsed : null;
          return typeof parsed === 'object' ? [parsed] : null;
        } catch { return null; }
      })(),
      // Personalisation tokens shared with the Campaigns builder.
      property_address: r.property_address,
      property_price: r.property_price,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      square_footage: r.square_footage,
      key_features: r.key_features,
      unsubscribed: r.unsubscribed,
      // ---- provenance: blank for a manually created lead, populated for a Meta import ----
      source: r.source,
      first_name: r.first_name,
      last_name: r.last_name,
      facebook_lead_id: r.facebook_lead_id,
      meta: r.source === 'facebook_meta' ? {
        page_id: r.facebook_page_id,
        page_name: r.meta_page_name,
        form_id: r.facebook_form_id,
        form_name: r.meta_form_name,
        lead_id: r.facebook_lead_id,
        campaign_id: r.meta_campaign_id,
        campaign_name: r.meta_campaign_name,
        adset_id: r.meta_adset_id,
        adset_name: r.meta_adset_name,
        ad_id: r.meta_ad_id,
        ad_name: r.meta_ad_name,
        submitted_at: r.meta_created_at instanceof Date ? r.meta_created_at.toISOString() : null,
        imported_at: r.meta_imported_at instanceof Date ? r.meta_imported_at.toISOString() : null,
        message: r.message,
        budget: r.budget,
        timeline: r.timeline,
        property_type: r.property_type,
      } : null,
      assigned_to: assignedTo,
      assigned_to_name: assignedTo ? assignees.get(assignedTo) ?? null : null,
      // Who created the lead. The client compares this to the signed-in user to decide whether
      // the identity fields (email, phone, source, assignment) and the Delete action are locked:
      // an agent working a lead the brokerage created cannot change those. Not sensitive — it is
      // just a user id, and the server enforces the rule regardless of what the client shows.
      owner_user_id: (r.owner_user_id as number | null) ?? null,
      call_count: counts?.lead_calls ?? 0,
      task_count: counts?.lead_tasks ?? 0,
      pending_task_count: pending ?? 0,
      created_by: r.created_by,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : null,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : null,
    };
  }
}
