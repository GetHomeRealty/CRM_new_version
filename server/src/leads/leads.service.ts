import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { CrmEventNotifier } from '../notifications/crm-events.service';
import { normalizePhone } from '../meta/meta-lead-mapper';
import type { AuthUserRecord } from '../auth/auth.types';
import { can, isSuperAdmin } from '../core/authz';
import { leadScopeWhere } from '../common/lead-scope';
import { throwValidation } from '../common/laravel-exceptions';
import {
  EMAIL_SHAPE, FEED_PER_PAGE, LEADS_PER_PAGE, MAX_PER_PAGE, MAX_EXPORT_ROWS, NONE_FILTER_VALUE,
  RECENT_LEAD_DAYS, WEBSITE_ENQUIRY_SOURCES, DASHBOARD_LEAD_SOURCES,
  isClientType, isConversion, isGender, isLeadResponse, isLeadSource, isLeadStatus, isLeadType, isTaskStatus,
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

/**
 * A CSV export, with an honest account of what it contains.
 *
 * `truncated` is the field that matters: the caller cannot otherwise tell a complete export of
 * 5,000 leads from the first 5,000 of 12,000.
 */
export interface LeadExport {
  data: Record<string, unknown>[];
  meta: { total: number; returned: number; limit: number; truncated: boolean };
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
    /*
     * Optional so every existing construction of this service — including its specs — keeps working
     * untouched. Always injected in the running application.
     */
    private readonly crmEvents?: CrmEventNotifier,
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
   *
   * Now shared with the CRM dashboard, which used to restate it from memory and got it wrong in
   * both directions. The rule is unchanged; it simply lives in one file so a tile and the screen it
   * summarises cannot drift apart again.
   */
  private scopeWhere(user: AuthUserRecord): Prisma.leadsWhereInput {
    return leadScopeWhere(user);
  }

  /**
   * Whether this user may rewrite the identity of a lead the brokerage handed them, and delete it.
   *
   * Was `role === 'agent'`, which is the mistake `core/authz.ts` opens by warning against: asking
   * about the person rather than the action gets the wrong answer the day a role is added. Three
   * had been — `crm`, `accounting` and `documentation` were all silently exempt from the lock, and
   * a CRM-role user could rewrite the email address of a lead the brokerage owned.
   */
  private mayRewriteIdentity(user: AuthUserRecord): boolean {
    return can(user, 'leads.rewrite-identity');
  }

  /**
   * Whether this user can already open a given lead — the same rule `leadScopeWhere` applies, asked
   * of a row already in hand rather than expressed as a query. Used to decide how much a validation
   * message may say about a lead the caller may not read.
   */
  private canSee(lead: { owner_user_id: number | null; assigned_to: number | null }, user: AuthUserRecord): boolean {
    const id = user.id ?? -1;
    if (lead.owner_user_id === id || lead.assigned_to === id) return true;
    return lead.owner_user_id === null && isSuperAdmin(user);
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
      this.statsGrouped(where),
    ]);

    const assignees = await this.assigneeNames(rows.map((r) => r.assigned_to));

    return {
      data: rows.map((r) => this.present(r, assignees)),
      meta: { current_page: page, per_page: limit, last_page: Math.max(1, Math.ceil(total / limit)), total },
      stats,
    };
  }

  /**
   * Header counters for the current filter set — four queries, not fourteen.
   *
   * WHAT THIS REPLACED, because the shape mattered more than the code. Every Leads page load ran
   * ONE `count()` per counter: a total, a no-calls anti-join, a website-enquiries count, a recent
   * count, five `lead_status` counts and four `lead_source` counts. With the `findMany` and the
   * pagination `count` alongside them that is FIFTEEN queries to draw one page.
   *
   * WHY IT WAS NEARLY INVISIBLE, and why it was found by load rather than by profiling. Prisma
   * issues them through `Promise.all`, so a single user waits only for the slowest — measured at
   * 349 ms against a 60,000-lead book, against 290 ms for the same numbers in one pass. A 1.2×
   * difference nobody would chase.
   *
   * THE COST IS NOT LATENCY, IT IS CONCURRENCY. Fourteen counts take fourteen pool connections and
   * re-scan the same rows fourteen times. Measured with twelve simultaneous page loads: 4.2/s the
   * old way, 17.1/s in one pass — **4.1× the throughput**, from work that a single user could not
   * feel. That is why the endpoint collapsed from the framework's 530–740 req/s to 10 req/s under
   * a hundred users.
   *
   * WHY `groupBy` AND NOT ONE HAND-WRITTEN `FILTER` QUERY. A single statement with `count(*)
   * FILTER (…)` is faster still, and it was measured. It also requires expressing `buildWhere` —
   * the search, nine dropdown filters, the tag match, the age range, the assignment rule and the
   * ownership scope — a second time, in SQL. Two spellings of the same filter is exactly how the
   * dashboard came to read 512 while the Leads screen read 0. `groupBy` keeps ONE definition of the
   * filter, hands it to Prisma unchanged, and recovers most of the gain. The privacy scope in
   * particular is never restated: it arrives inside `where` and is applied by the same code as
   * before.
   *
   * `total` is passed in rather than counted again — `list` has already counted it for pagination,
   * and two counts of the same predicate can disagree if a lead is created between them.
   */
  private async statsGrouped(where: Prisma.leadsWhereInput): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - RECENT_LEAD_DAYS * 24 * 60 * 60 * 1000);
    const count = (extra: Prisma.leadsWhereInput) => this.prisma.leads.count({ where: { AND: [where, extra] } });

    const [byStatusRows, bySourceRows, noCalls, recent] = await Promise.all([
      this.prisma.leads.groupBy({ by: ['lead_status'], where, _count: { _all: true } }),
      this.prisma.leads.groupBy({ by: ['lead_source'], where, _count: { _all: true } }),
      // The one counter that cannot join the others: an anti-join against lead_calls is a different
      // question about a different table, not a bucket of this one.
      count({ lead_calls: { none: {} } }),
      count({ created_at: { gte: since } }),
    ]);

    // groupBy returns only the buckets that exist, so a status nobody holds must read 0 rather than
    // undefined — the screen renders these directly.
    const statusCounts = new Map(byStatusRows.map((r) => [r.lead_status ?? '', r._count._all]));
    const sourceCounts = new Map(bySourceRows.map((r) => [r.lead_source ?? '', r._count._all]));
    const status = (k: string): number => statusCounts.get(k) ?? 0;
    const source = (k: string): number => sourceCounts.get(k) ?? 0;

    // Derived rather than counted: this was its own query asking what the source buckets already
    // answer. Same definition, same constant, one fewer scan.
    const websiteEnquiries = WEBSITE_ENQUIRY_SOURCES.reduce((sum, s) => sum + source(s), 0);

    const bySource: Record<string, number> = {};
    for (const s of DASHBOARD_LEAD_SOURCES) bySource[s.key] = source(s.value);
    // The total across every bucket, including sources not broken out and leads with none recorded.
    const total = [...sourceCounts.values()].reduce((a, b) => a + b, 0);
    // "other" absorbs linkedin, youtube and leads with no source recorded, so the parts of the
    // Dashboard breakdown always add up to the total rather than silently losing rows.
    bySource.other = total - DASHBOARD_LEAD_SOURCES.reduce((sum, s) => sum + source(s.value), 0);

    return {
      total,
      noCalls,
      websiteEnquiries,
      recent,
      byStatus: {
        hot: status('hot'), warm: status('warm'), cold: status('cold'),
        mild: status('mild'), closed: status('closed'),
      },
      bySource,
    };
  }

  /**
   * Lead tasks the signed-in user is allowed to see, a page at a time, for the Dashboard.
   *
   * Scoped through the lead exactly like the lists are, so an agent sees tasks on their own leads
   * and nobody else's.
   *
   * WHY THIS IS PAGINATED NOW. It returned every task in one response. Measured against a
   * brokerage-sized database — 40,000 leads, one agent's book of 9,852 — that was **1.67 MB of
   * JSON in a single request**, and it grows for as long as the brokerage uses the product, because
   * tasks accumulate on a book and nothing here ever dropped the old ones. The database was never
   * the problem (147 ms); the wire was, and an agent opening the dashboard on a phone paid for all
   * of it before seeing a row.
   *
   * ORDERING MOVED INTO SQL, which pagination forced and which was worth doing anyway. It used to
   * fetch everything and then `.sort()` in JavaScript to float open tasks to the top — correct only
   * because the whole set was present. Sorting a page in memory would reorder that page alone, so
   * the rule ("still open first, then by due date, so anything overdue sits at the top") is now
   * expressed as an ordering the database applies to the whole set before the page is cut.
   */
  async allTasks(user: AuthUserRecord, q: { page?: unknown; limit?: unknown; status?: unknown } = {}): Promise<Record<string, unknown>> {
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(MAX_PER_PAGE, Math.max(1, Number(q.limit ?? FEED_PER_PAGE) || FEED_PER_PAGE));
    const status = str(q.status);

    const where: Prisma.lead_tasksWhereInput = {
      leads: { deleted_at: null, ...this.scopeWhere(user) },
      ...(status && isTaskStatus(status) ? { status } : {}),
    };

    const [rows, total, open, overdue] = await Promise.all([
      this.prisma.lead_tasks.findMany({
        where,
        include: { leads: { select: { id: true, name: true } } },
        /*
         * `status` DESCENDING puts the groups in the order the panel wants — pending, completed,
         * cancelled — because that is their reverse alphabetical order. It is a coincidence of the
         * vocabulary rather than a rule, so `lead-task-feed.spec.ts` asserts it and will fail the
         * day a status is added that lands in the wrong place. The alternative, a CASE expression,
         * cannot be written in Prisma's `orderBy`, and dropping to raw SQL would lose the relation
         * filter that does the scoping — a worse trade for the same result.
         */
        orderBy: [{ status: 'desc' }, { due_date: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.lead_tasks.count({ where }),
      this.prisma.lead_tasks.count({ where: { ...where, status: 'pending' } }),
      this.prisma.lead_tasks.count({ where: { ...where, status: 'pending', due_date: { lt: new Date() } } }),
    ]);

    const assignees = await this.assigneeNames(rows.map((t) => t.assigned_to));

    return {
      data: rows.map((t) => ({
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
      })),
      meta: { page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
      // Counted across the whole set, not the page. The panel's heading says "N open of M", and
      // computing that from one page of fifty would be a different, wrong number.
      summary: { total, open, overdue },
    };
  }

  /**
   * Lead showings the caller can see, a page at a time, for the Dashboard.
   *
   * Scoped through the lead exactly like the lists, so an agent sees showings on their own leads
   * and nobody else's. Ordered by date, soonest first. Paginated for the same reason as `allTasks`
   * — this one measured 673 kB in a single response on a real book, and it grows the same way.
   */
  async allShowings(user: AuthUserRecord, q: { page?: unknown; limit?: unknown } = {}): Promise<Record<string, unknown>> {
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(MAX_PER_PAGE, Math.max(1, Number(q.limit ?? FEED_PER_PAGE) || FEED_PER_PAGE));

    // Only today and upcoming — past showings drop off the dashboard so it reads as a to-do list.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const where: Prisma.lead_showingsWhereInput = {
      showing_date: { gte: todayStart },
      leads: { deleted_at: null, ...this.scopeWhere(user) },
    };

    const [rows, total, scheduled] = await Promise.all([
      this.prisma.lead_showings.findMany({
        where,
        include: { leads: { select: { id: true, name: true } } },
        orderBy: [{ showing_date: 'asc' }, { time: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.lead_showings.count({ where }),
      this.prisma.lead_showings.count({ where: { ...where, status: 'scheduled' } }),
    ]);

    return {
      data: rows.map((s) => ({
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
      })),
      meta: { page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
      // Counted across the whole set: the panel heading says "N upcoming of M".
      summary: { total, upcoming: scheduled },
    };
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

  /**
   * Turn a unique-constraint violation on the email address into the validation error it actually is.
   *
   * The database holds `leads_email_lower_key` — UNIQUE on `lower(email)` — and it counts
   * soft-deleted rows, which the application check deliberately does not. Two ordinary things
   * therefore reached it and came back as `500 Internal server error`:
   *
   *   1. Deleting a lead by mistake and re-adding the person. The check saw no live clash; the
   *      index saw the row sitting in Recently Deleted.
   *   2. Double-clicking Save. Both requests passed the check, the second lost the insert race —
   *      so the user was told the server had failed on a lead that had in fact been created.
   *
   * Rethrown as the module's 422 shape, and the recycle-bin case says so, because "already in use"
   * and "in the bin, restore it instead" call for completely different actions.
   */
  private async rethrowEmailClash(err: unknown, email: string, ownerId: number | null): Promise<never> {
    const isUniqueViolation = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
    if (!isUniqueViolation) throw err;

    // Scoped to the same book the index is scoped to, or the message would blame a deleted lead in
    // somebody else's recycle bin for a clash that has nothing to do with them.
    const deleted = await this.prisma.leads.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, owner_user_id: ownerId, deleted_at: { not: null } },
      select: { id: true },
    });
    throwValidation({
      email: [deleted
        ? 'A lead with that email address is in your Recently Deleted. Restore it from there rather than creating a second record.'
        : 'That email address has just been added to this book by another request. Refresh and search for it before creating a new one.'],
    });
    throw err; // unreachable — throwValidation always throws; present so the return type is `never`
  }

  // ----------------------------------------------------------------- write
  async create(input: LeadInput, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const data = await this.validate(input, true, undefined, user);
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
    }).catch((err: unknown) => this.rethrowEmailClash(err, data.email as string, user.id ?? null));
    await this.audit.record(user, 'Lead created', row.name, `${row.email}${row.phone ? ` · ${row.phone}` : ''}`);
    // Best-effort inbound-lead email (Meta / Google Ads / Website only); never blocks creation.
    void this.notifications.notifyNewLead(row);

    /*
     * IN-APP AND PUSH for the new lead. Deliberately NOT email: `notifyNewLead` above already sends
     * a templated one for inbound sources, and asking the dispatcher for email as well would deliver
     * two. That email is now gated on the same `lead_new` preference — see LeadNotificationService.
     *
     * Called AFTER the row is committed and after the audit entry, so nothing announces a lead that
     * a later failure would have erased. `void` because a notification must never delay or fail the
     * creation the caller is waiting on.
     */
    void this.crmEvents?.leadCreated(
      { id: row.id, first_name: row.name, last_name: null, email: row.email, source: row.lead_source },
      row.assigned_to ?? row.owner_user_id,
      user.id ?? null,
    );

    // A lead created already assigned to somebody else is an assignment as far as they are
    // concerned — they are being handed work, and that is the notification they expect.
    if (row.assigned_to && row.assigned_to !== (user.id ?? null)) {
      void this.crmEvents?.leadAssigned(
        { id: row.id, first_name: row.name, last_name: null, email: row.email },
        row.assigned_to, user.id ?? null, user.name,
      );
    }

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
    return !this.mayRewriteIdentity(user) && existing.owner_user_id !== (user.id ?? -1);
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

    const data = await this.validate(input, false, id, user, existing.owner_user_id);

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
    }).catch((err: unknown) => this.rethrowEmailClash(err, str(data.email) || str(existing.email), existing.owner_user_id));

    // Record the fields that actually changed, so the trail is readable.
    const changed = Object.keys(data).filter((k) => String((existing as Record<string, unknown>)[k] ?? '') !== String((row as Record<string, unknown>)[k] ?? ''));
    await this.audit.record(user, 'Lead updated', row.name, changed.length ? `Changed: ${changed.join(', ')}` : 'No field values changed');

    /*
     * ASSIGNMENT NOTIFICATION — only when the assignee ACTUALLY CHANGED.
     *
     * Compared against the row as it was before the update, not against what was submitted. The
     * lead editor posts the whole form on every save, so `assigned_to` arrives on every request
     * whether or not it was touched; notifying on presence would tell somebody "this was assigned
     * to you" every time anyone edited a note on their own lead.
     *
     * The PREVIOUS assignee is deliberately not told anything. "This is no longer yours" is a
     * different message that nobody asked for.
     */
    if (row.assigned_to && row.assigned_to !== existing.assigned_to) {
      void this.crmEvents?.leadAssigned(
        { id: row.id, first_name: row.name, last_name: null, email: row.email },
        row.assigned_to, user.id ?? null, user.name,
      );
    }

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
        ...(this.mayRewriteIdentity(user) ? {} : { owner_user_id: user.id ?? -1 }),
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
  /**
   * The recycle bin, paginated.
   *
   * This used to be a bare `take: 200` with no paging and nothing on screen saying so. Past two
   * hundred deletions the oldest simply stopped appearing — still in the database, still
   * restorable by an administrator with SQL, but unreachable by the person whose leads they were
   * and with no indication anything was missing. A silent cap on a recovery screen is the wrong
   * way round: this is where somebody looks precisely because something has already gone wrong.
   *
   * Same shape as the live list — `page`/`limit` in, `meta` out — so the two screens paginate
   * identically. `count` is kept alongside `meta.total` because the existing client reads it.
   */
  async listDeleted(user: AuthUserRecord, q: { page?: unknown; limit?: unknown } = {}): Promise<Record<string, unknown>> {
    const where: Prisma.leadsWhereInput = { deleted_at: { not: null }, ...this.scopeWhere(user) };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const limit = Math.min(MAX_PER_PAGE, Math.max(1, Number(q.limit ?? LEADS_PER_PAGE) || LEADS_PER_PAGE));

    const [rows, count] = await Promise.all([
      this.prisma.leads.findMany({
        // Tie-broken by id: two leads deleted in the same second would otherwise be free to swap
        // places between requests, so a row could appear on two pages or on neither.
        where, orderBy: [{ deleted_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit, take: limit,
      }),
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
      meta: { page, per_page: limit, total: count, last_page: Math.max(1, Math.ceil(count / limit)) },
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
  // CSV lead import moved out of the request path.
  //
  // It used to run here inline: one ILIKE lookup per row — a sequential scan, because ILIKE cannot
  // use the `lower(email)` index this schema already carries — plus one INSERT per row and no
  // transaction. Measured against 40,000 leads, a 5,000-row file spent about 132 seconds in
  // lookups alone, past a default proxy timeout, leaving a half-finished import with no rollback
  // and no way to resume.
  //
  // `LeadImportEngine` now does the same work with one indexed lookup per 500-row batch inside a
  // per-batch transaction, and `LeadImportJobService` runs it off the request thread with progress
  // a client can poll. Campaigns imports through the same pair rather than keeping its own copy.


  /**
   * Rows for the CSV export, honouring the same filters as the list.
   *
   * SAYS WHAT IT LEFT OUT. The cap has always been here; what was missing was any way to know it
   * had been reached. The endpoint returned a bare array, so a brokerage with 12,000 leads got
   * 5,000 rows and a cheerful "Exported 5000 leads." — on the file people use for migrations, mail
   * merges and answering a client's request for their own data. The same mistake this module
   * already fixed on the recycle bin, where the note reads "a silent cap on a recovery screen is
   * the wrong way round".
   *
   * `total` is counted before the page is taken, so `truncated` is a fact rather than an inference
   * from a full page.
   */
  async exportRows(user: AuthUserRecord, q: LeadQuery, ids: number[]): Promise<LeadExport> {
    const where: Prisma.leadsWhereInput = ids.length
      ? { AND: [{ id: { in: ids }, deleted_at: null }, this.scopeWhere(user)] }
      : this.buildWhere(user, q);
    const [total, rows] = await Promise.all([
      this.prisma.leads.count({ where }),
      this.prisma.leads.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: MAX_EXPORT_ROWS }),
    ]);
    const assignees = await this.assigneeNames(rows.map((r) => r.assigned_to));
    const data = rows.map((r) => ({
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

    return {
      data,
      meta: { total, returned: data.length, limit: MAX_EXPORT_ROWS, truncated: total > data.length },
    };
  }

  // ------------------------------------------------------------------ tags
  /**
   * Every tag this person can act on: the shared registry, plus the tags on their own leads, with
   * counts taken from their own book only.
   *
   * THE COUNTS ARE THE PRIVATE PART. `lead_tags` is a deliberate shared vocabulary — the point of a
   * registry is that the whole brokerage spells "First-Time Buyer" the same way, and a name on that
   * list discloses nothing. How many leads sit behind it does: an unscoped count answered
   * "how big is that agent's pipeline in this segment", one tag at a time, and the scan that
   * produced it read every lead row in the brokerage into memory to do so.
   *
   * So the scan is scoped like every other read in this module, and a registered tag the caller has
   * not used still appears — at zero, which is the truth from where they are standing.
   */
  async tags(user: AuthUserRecord): Promise<{ tags: string[]; counts: { name: string; count: number }[] }> {
    const [rows, registered] = await Promise.all([
      this.prisma.leads.findMany({ where: { deleted_at: null, ...this.scopeWhere(user) }, select: { tags: true } }),
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
   * Take a tag off the caller's own leads, and out of the shared registry.
   *
   * THIS USED TO WRITE ACROSS EVERY BOOK IN THE BROKERAGE. The scan had no scope filter, so any
   * user with `lead` edit — which is every agent — could strip a tag from leads they cannot see,
   * cannot open and cannot list, and the response handed back the ids of those leads as the undo
   * payload. Campaign audiences are built from tags, so it silently changed who other agents'
   * campaigns would reach, and the owner had no local explanation for their segmentation
   * disappearing.
   *
   * Scoped now, on both halves: the caller's own leads lose the tag, everyone else's keep it, and
   * only ids the caller could already read come back. The registry entry is shared, so removing it
   * removes it for everyone — that is what a shared vocabulary means, and it is recorded in the
   * audit trail with the name.
   *
   * One `updateMany` per distinct tag set inside a transaction, rather than a query per lead: the
   * loop was also the reason a failure halfway through left the tag on some leads and not others,
   * with the returned undo list then describing a state that never existed.
   */
  async deleteTag(name: string, user: AuthUserRecord): Promise<{ tag: string; removed: number; lead_ids: number[] }> {
    const tag = str(name);
    if (!tag) throw new BadRequestException({ message: 'A tag name is required.' });
    const rows = await this.prisma.leads.findMany({
      where: { deleted_at: null, ...this.scopeWhere(user) },
      select: { id: true, tags: true },
    });

    const now = new Date();
    const affected: number[] = [];
    // Grouped by the tag set each lead is left with, so leads sharing a set collapse to one
    // statement — typically one or two for a whole book.
    const byResult = new Map<string, number[]>();
    for (const r of rows) {
      const tags = parseJsonArray(r.tags);
      if (!tags.includes(tag)) continue;
      const next = JSON.stringify(tags.filter((t) => t !== tag));
      const ids = byResult.get(next);
      if (ids) ids.push(r.id); else byResult.set(next, [r.id]);
      affected.push(r.id);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const [tags, ids] of byResult) {
        await tx.leads.updateMany({ where: { id: { in: ids } }, data: { tags, updated_at: now } });
      }
      await tx.lead_tags.deleteMany({ where: { name: tag } });
    });

    await this.audit.record(user, 'Lead tag deleted', tag, `Removed from ${affected.length} of your lead(s); the tag is no longer offered to anyone`);
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
  private async validate(
    input: LeadInput,
    requireCore: boolean,
    selfId?: number,
    user?: AuthUserRecord,
    /** The owner the row will have. Undefined on a create, where it is the caller. */
    existingOwnerId?: number | null,
  ): Promise<Record<string, unknown>> {
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
        /*
         * A duplicate is a duplicate WITHIN ONE BOOK, not across the brokerage.
         *
         * The same person legitimately becomes a lead more than once: they click brokerage A's ad
         * on Monday and brokerage B's on Thursday, or they reach agent 1 by referral and later fill
         * in agent 2's landing page. Both relationships are real and separately consented, and the
         * CRM's whole model is that a book belongs to its agent — so neither of those may be
         * refused. The old check was brokerage-wide, matching a global unique index, and it turned
         * a paid click into a lead nobody ever received.
         *
         * What must still be refused is the same address twice in the SAME person's book: that
         * splits one person's history across two records and double-sends every campaign. So the
         * lookup is scoped to whoever will own the new row — matching
         * `leads_company_owner_email_key`, which is `(company_id, COALESCE(owner_user_id, 0),
         * lower(email))`.
         *
         * `ownerId` is the creator on a create. On an update it is the row's existing owner, because
         * an edit does not change who owns it — `owner_user_id` is not an editable field.
         */
        const ownerId = existingOwnerId !== undefined ? existingOwnerId : user?.id ?? null;
        const clash = await this.prisma.leads.findFirst({
          where: {
            email: { equals: email, mode: 'insensitive' },
            deleted_at: null,
            owner_user_id: ownerId,
            ...(selfId ? { id: { not: selfId } } : {}),
          },
          select: { id: true, name: true, owner_user_id: true, assigned_to: true },
        });
        if (clash) {
          /*
           * Naming the clashing lead is safe here in a way it was not before: the row is in the
           * caller's own book by construction. `canSee` is still consulted rather than assumed,
           * because an administrator acting on unattributed intake is the one case where owning a
           * row and being able to open it are decided by different rules.
           */
          const visible = user ? this.canSee(clash, user) : false;
          add('email', visible
            ? `${clash.name} already uses that email address (lead #${clash.id}).`
            : 'That email address is already on a lead in this book.');
        } else out.email = email;
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

    /*
     * 422, not 400.
     *
     * This threw BadRequestException, which made Leads the one module answering 400 for a failure
     * every other part of the API answers 422 for — the shape and status that
     * `common/laravel-exceptions.ts` defines and the global ValidationPipe produces everywhere
     * else. Nobody noticed because the client reads `data.errors` without looking at the status,
     * so the screens behaved correctly either way; the cost was an API inconsistent with its own
     * contract, which any integration or monitoring rule keying on 422 would silently miss.
     *
     * `throwValidation` also produces the summary line ("first error (and N more errors)") that
     * was previously assembled by hand here, so the message is now built the same way as the rest
     * of the API rather than merely resembling it.
     */
    if (Object.keys(errors).length) throwValidation(errors);
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
