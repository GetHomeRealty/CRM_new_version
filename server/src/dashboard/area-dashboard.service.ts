import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

import { isAgent, isSuperAdmin } from '../core/authz';
import { leadTaskScopeWhere, liveLeadWhere } from '../common/lead-scope';
import { PermissionService } from '../auth/permission.service';
import { CacheService } from '../redis/cache.service';
/**
 * The two dashboards, as two separate reads.
 *
 * Section 10 is explicit that hiding widgets is not the requirement: "Separate the underlying
 * queries, services, APIs, permissions, filters, and data sources so each dashboard loads only its
 * relevant information." So the CRM dashboard never touches `transactions`, `invoices` or
 * `documents`, and the Transaction Desk dashboard never touches `leads`, `lead_tasks` or
 * `campaigns`. Neither one fetches the other's rows and discards them.
 *
 * That is also why this is a new service rather than options on the old one. The previous screen
 * pulled the ENTIRE transactions list into the browser and summed it there, alongside every lead
 * task and the whole lead list, and then showed or hid cards by permission. Each half now asks the
 * database for counts and sums and receives numbers.
 *
 * Every query is scoped to the signed-in user the same way its module already scopes: an agent sees
 * their own leads and their own deals, and the To-Do and calendar counts are personal to everyone,
 * administrators included. The split changes which area's data is read, never whose.
 */

/** Agents see only their own records; managers and administrators see the brokerage's. */

export interface CrmDashboard {
  leads: { total: number; by_status: Record<string, number>; by_source: Record<string, number>; new_this_week: number };
  tasks: { total: number; pending: number; completed: number; cancelled: number; due_today: number; overdue: number };
  campaigns: { total: number; sent: number; opened: number; failed: number };
  inbox: { unread: number };
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

export interface DeskDashboard {
  transactions: { total: number; by_validation: Record<string, number>; by_commission: Record<string, number> };
  closings: { next_30_days: number; overdue: number; this_month: number };
  documents: { pending: number; invalid: number; mandatory_missing: number };
  /**
   * `null` when the caller does not hold the `invoice` screen — see `desk()`.
   *
   * Null rather than zeros: an agent who holds `invoice: 'none'` has no invoice figures, and
   * reporting `billed: 0` would tell them the brokerage has billed nothing, which is a different
   * and worse untruth than the brokerage-wide numbers this replaced.
   */
  invoices: { total: number; unpaid: number; billed: number; collected: number; outstanding: number } | null;
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

@Injectable()
export class AreaDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    /*
     * Optional, and it has to stay that way. `CacheService` degrades to "not cached" with no Redis,
     * so the deployment that has none is unaffected — and the scope specs construct this service
     * directly with two arguments to assert what an agent may count. Those tests are the reason the
     * scope rules are trustworthy; a required dependency would have made them a mock-wiring exercise.
     */
    private readonly cache?: CacheService,
  ) {}

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private daysFromToday(n: number): Date {
    const d = this.startOfToday();
    d.setDate(d.getDate() + n);
    return d;
  }

  /**
   * An area's own records plus the ones that pre-date the split, for the two tables that carry a
   * `domain` — `calendar_events` and `todos`. Spelled as a union because Prisma rejects `null`
   * inside an `in` list.
   */
  private areaOr(area: 'crm' | 'desk'): { OR: [{ domain: string }, { domain: null }] } {
    return { OR: [{ domain: area }, { domain: null }] };
  }

  /**
   * A cancelled appointment is not upcoming.
   *
   * The calendar counters filtered by date and area but not by status, so cancelling a viewing left
   * it in both "today" and "next 30 days" — the tile went UP when an appointment was called off.
   */
  private readonly liveEvent = { status: { not: 'cancelled' } };

  /** Turn a groupBy result into a plain label→count map. */
  private tally<T extends string>(rows: { _count: { _all: number } }[], key: (r: never) => string): Record<T, number> {
    const out = {} as Record<T, number>;
    for (const r of rows) {
      const k = (key(r as never) || 'Unspecified') as T;
      out[k] = (out[k] ?? 0) + r._count._all;
    }
    return out;
  }

  // ------------------------------------------------------------------- CRM
  /**
   * The CRM dashboard, cached for `TTL.dashboard` seconds PER PERSON.
   *
   * WHY THE KEY IS NOT JUST THE USER ID. Almost every figure below is scoped by identity alone —
   * `leadScopeWhere` gives a lead to whoever is assigned it or owns it, and NOBODY reads a
   * colleague's book by virtue of their rank. For those, the user id is the whole of the scope.
   *
   * One rule is not identity-based: `isSuperAdmin` additionally matches leads with no owner, the
   * unattributed intake that surfaces at the top tier rather than nowhere. That is the only way two
   * requests from the same id can legitimately deserve different numbers, so it is the only thing
   * that joins the id in the key. Promoting somebody then takes effect on their next request rather
   * than at the end of a TTL.
   *
   * `isAgent` would be the wrong discriminator here and was the first thing tried: it reads as the
   * scope rule but does not drive one on this screen, so a demotion from manager to agent would
   * have changed the key while changing no figure, and a promotion to Super Admin — which does
   * change the figures — would have kept it.
   *
   * An anonymous caller (`user` null) collapses to id `-1` in the queries below, so it must not
   * share a key with a real person; it gets its own by construction.
   *
   * WHAT IS DELIBERATELY NOT CACHED: `desk()`. Its invoice section is present or `null` depending
   * on a permission checked at request time, which makes it an authorization-shaped answer rather
   * than a summary — and it is not what the fan-out measurement was about.
   */
  async crm(user: AuthUserRecord | null): Promise<CrmDashboard> {
    if (!this.cache) return this.crmUncached(user);
    const scope = isSuperAdmin(user) ? 'sa' : 'own';
    return this.cache.remember(
      'dashboard',
      `crm:${user?.id ?? -1}:${scope}`,
      CacheService.TTL.dashboard,
      () => this.crmUncached(user),
    );
  }

  private async crmUncached(user: AuthUserRecord | null): Promise<CrmDashboard> {
    const userId = user?.id ?? -1;
    // Both borrowed from the Leads module rather than restated here. This file used to spell the
    // rule itself and got it wrong in both directions — an agent was scoped by `assigned_to` alone
    // so leads they owned went uncounted, everyone else was given no filter at all so an
    // administrator's tile read the whole brokerage while their Leads screen read their own book,
    // and neither path excluded soft-deleted leads, so every lead figure counted deleted rows for
    // ever. A tile must answer exactly what the screen it summarises answers.
    const leadWhere: Prisma.leadsWhereInput = liveLeadWhere(user);
    const taskWhere: Prisma.lead_tasksWhereInput = leadTaskScopeWhere(user);
    // A campaign is private to whoever created it, for EVERY role — the Campaigns module's own
    // rule. These two aggregates carried no filter, so an agent who owns nothing still read the
    // brokerage's campaign count and its total sent/opened volumes off their dashboard.
    const campaignWhere: Prisma.campaignsWhereInput = { created_by_id: userId };
    const today = this.startOfToday();
    const personal = { user_id: userId, deleted_at: null };

    /*
     * TWELVE QUERIES, NOT EIGHTEEN.
     *
     * Every dashboard load used to issue one `count()` per tile — four for leads, six for tasks,
     * three for to-dos — and `Promise.all` made that look free. It is not: measured at a hundred
     * concurrent users this endpoint delivered 17 req/s while a single-query endpoint on the same
     * server delivered 532. The cost is not the latency any one user sees, it is that each request
     * occupies eighteen pool connections and re-scans the same rows.
     *
     * Where several tiles are buckets of ONE column, `groupBy` answers them in one pass. Where a
     * tile asks a genuinely different question — a date range, another table — it keeps its own
     * query, because merging those would mean hand-written SQL and a second copy of the scope
     * rules. The scope objects below are passed to Prisma unchanged, so `liveLeadWhere`,
     * `leadTaskScopeWhere` and the per-user campaign filter remain the single definition of who may
     * see what.
     */
    const [
      byStatus, bySource, newThisWeek,
      taskByStatus, taskToday, taskOverdue,
      campaignAgg, campaignCount,
      unread,
      calUpcoming, calToday,
      todoByStatus, todoOverdue,
    ] = await Promise.all([
      // `leadTotal` is no longer its own count — it is the sum of these buckets, which include the
      // null-status group, so the tile and the breakdown beneath it cannot disagree.
      this.prisma.leads.groupBy({ by: ['lead_status'], _count: { _all: true }, where: leadWhere }),
      this.prisma.leads.groupBy({ by: ['lead_source'], _count: { _all: true }, where: leadWhere }),
      this.prisma.leads.count({ where: { ...leadWhere, created_at: { gte: this.daysFromToday(-7) } } }),

      // Four counts (total, pending, completed, cancelled) in one pass.
      this.prisma.lead_tasks.groupBy({ by: ['status'], _count: { _all: true }, where: taskWhere }),
      // These two stay: "due today" and "overdue" are date questions, not status buckets.
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'pending', due_date: today } }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'pending', due_date: { lt: today } } }),

      this.prisma.campaigns.aggregate({ where: campaignWhere, _sum: { sent: true, opened: true, failed: true } }),
      this.prisma.campaigns.count({ where: campaignWhere }),

      // The CRM's own mailbox: mail from accounts connected under CRM Settings.
      this.prisma.inbound_emails.count({
        where: { user_id: userId, seen: false, mail_account: { is: { OR: [{ scope: 'crm' }, { scope: null }] } } },
      }),

      this.prisma.calendar_events.count({
        where: { ...personal, ...this.areaOr('crm'), ...this.liveEvent, date: { gte: today, lt: this.daysFromToday(30) } },
      }),
      this.prisma.calendar_events.count({ where: { ...personal, ...this.areaOr('crm'), ...this.liveEvent, date: today } }),

      // Total and pending in one pass; overdue is a date question and keeps its own.
      this.prisma.todos.groupBy({ by: ['status'], _count: { _all: true }, where: { ...personal, ...this.areaOr('crm') } }),
      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('crm'), status: 'pending', due_date: { lt: today } } }),
    ]);

    /*
     * The buckets, summed back into the totals the tiles expect.
     *
     * `groupBy` returns only the statuses that exist, so a bucket nobody holds must read 0 rather
     * than undefined — these go straight to the screen.
     */
    const sum = (rows: { _count: { _all: number } }[]): number => rows.reduce((a, r) => a + r._count._all, 0);
    const bucket = (rows: { status: string | null; _count: { _all: number } }[], k: string): number =>
      rows.find((r) => r.status === k)?._count._all ?? 0;

    const leadTotal = sum(byStatus);
    const taskTotal = sum(taskByStatus);
    const taskPending = bucket(taskByStatus, 'pending');
    const taskCompleted = bucket(taskByStatus, 'completed');
    const taskCancelled = bucket(taskByStatus, 'cancelled');
    const todoTotal = sum(todoByStatus);
    const todoPending = bucket(todoByStatus, 'pending');

    return {
      leads: {
        total: leadTotal,
        by_status: this.tally(byStatus, (r: { lead_status: string | null }) => r.lead_status ?? ''),
        by_source: this.tally(bySource, (r: { lead_source: string | null }) => r.lead_source ?? ''),
        new_this_week: newThisWeek,
      },
      tasks: {
        total: taskTotal, pending: taskPending, completed: taskCompleted, cancelled: taskCancelled,
        due_today: taskToday, overdue: taskOverdue,
      },
      campaigns: {
        total: campaignCount,
        sent: campaignAgg._sum.sent ?? 0,
        opened: campaignAgg._sum.opened ?? 0,
        failed: campaignAgg._sum.failed ?? 0,
      },
      inbox: { unread },
      calendar: { upcoming: calUpcoming, today: calToday },
      todos: { total: todoTotal, pending: todoPending, overdue: todoOverdue },
    };
  }

  // -------------------------------------------------------- Transaction Desk
  async desk(user: AuthUserRecord | null): Promise<DeskDashboard> {
    const userId = user?.id ?? -1;
    // Deals carry the agent's NAME, not an id — the Transactions screen filters the same way, so
    // this matches what that list shows the same person.
    const mine: Prisma.transactionsWhereInput = isAgent(user) && user?.name ? { agent: user.name } : {};
    const live: Prisma.transactionsWhereInput = { deleted_at: null, ...mine };
    const today = this.startOfToday();
    const personal = { user_id: userId, deleted_at: null };
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    // Asked of the same service `ScreenGuard` asks, including per-user overrides — so granting one
    // agent invoice access through Roles & Permissions shows them their own figures here too,
    // rather than requiring a second rule to be remembered.
    const mayReadInvoices = this.permissions.can(user?.role || 'agent', user?.user_permissions ?? [], 'invoice', 'view');
    const invoiceWhere: Prisma.invoicesWhereInput = {
      deleted_at: null,
      ...(isAgent(user) ? { transactions: { is: live } } : {}),
    };

    const [
      txnTotal, byValidation, byCommission,
      closingsSoon, closingsOverdue, closingsThisMonth,
      docsPending, docsInvalid, docsMandatoryMissing,
      invoiceCount, invoiceUnpaid, invoiceMoney,
      calUpcoming, calToday,
      todoTotal, todoPending, todoOverdue,
    ] = await Promise.all([
      this.prisma.transactions.count({ where: live }),
      this.prisma.transactions.groupBy({ by: ['valid_status'], _count: { _all: true }, where: live }),
      this.prisma.transactions.groupBy({ by: ['comm_status'], _count: { _all: true }, where: live }),

      this.prisma.transactions.count({ where: { ...live, closing_date: { gte: today, lt: this.daysFromToday(30) } } }),
      // Past its closing date with the commission still outstanding — the deals that need chasing.
      this.prisma.transactions.count({ where: { ...live, closing_date: { lt: today }, comm_status: { not: 'Paid' } } }),
      this.prisma.transactions.count({ where: { ...live, closing_date: { gte: today, lte: monthEnd } } }),

      this.prisma.documents.count({ where: { status: 'Pending', transactions: { is: live } } }),
      this.prisma.documents.count({ where: { validation: 'Invalid', transactions: { is: live } } }),
      this.prisma.documents.count({ where: { mandatory: true, status: 'Pending', transactions: { is: live } } }),

      /*
       * THE THREE QUERIES ON THIS SCREEN THAT WERE NOT SCOPED TO ANYBODY.
       *
       * They read `{ deleted_at: null }` and nothing else, while every other aggregate in this method
       * is scoped — transactions by `agent`, documents through `transactions: { is: live }`, calendar
       * and to-dos by `user_id`. Measured 2026-08-05 against the development database: the agent
       * "Akhil" saw `transactions.total: 3` of the brokerage's 7 — correctly their own — and
       * `invoices: { total: 5, billed: 123396, outstanding: 123396 }`, identical to the Super Admin's
       * and identical to `SELECT sum(total) FROM invoices`.
       *
       * The agent role holds `invoice: 'none'`. So the one screen every agent opens first was
       * printing the brokerage's billed and outstanding money, in four tiles, for a module the same
       * person is refused everywhere else in the product. This class's own docstring said "every
       * query is scoped to the signed-in user the same way its module already scopes" — which was
       * true of eleven of the fourteen.
       *
       * Two changes, because one would not be enough on its own:
       *   - WITHHELD from anyone without the `invoice` screen. That is the authority; the numbers are
       *     not theirs to see at any scope.
       *   - SCOPED to their own deals for an agent who does hold it, via the same `transactions:
       *     { is: live }` join the document counts already use. A nullable relation with `is`
       *     excludes invoices attached to no transaction, which is the wanted answer here: a
       *     standalone invoice is brokerage billing, not one agent's.
       */
      mayReadInvoices ? this.prisma.invoices.count({ where: invoiceWhere }) : Promise.resolve(0),
      mayReadInvoices ? this.prisma.invoices.count({ where: { ...invoiceWhere, status: { not: 'Paid' } } }) : Promise.resolve(0),
      mayReadInvoices
        ? this.prisma.invoices.aggregate({ _sum: { total: true, amount_paid: true, balance_due: true }, where: invoiceWhere })
        : Promise.resolve({ _sum: { total: null, amount_paid: null, balance_due: null } }),

      this.prisma.calendar_events.count({
        where: { ...personal, ...this.areaOr('desk'), ...this.liveEvent, date: { gte: today, lt: this.daysFromToday(30) } },
      }),
      this.prisma.calendar_events.count({ where: { ...personal, ...this.areaOr('desk'), ...this.liveEvent, date: today } }),

      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('desk') } }),
      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('desk'), status: 'pending' } }),
      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('desk'), status: 'pending', due_date: { lt: today } } }),
    ]);

    const dec = (v: Prisma.Decimal | null): number => (v ? Number(v) : 0);

    return {
      transactions: {
        total: txnTotal,
        by_validation: this.tally(byValidation, (r: { valid_status: string }) => r.valid_status),
        by_commission: this.tally(byCommission, (r: { comm_status: string }) => r.comm_status),
      },
      closings: { next_30_days: closingsSoon, overdue: closingsOverdue, this_month: closingsThisMonth },
      documents: { pending: docsPending, invalid: docsInvalid, mandatory_missing: docsMandatoryMissing },
      invoices: mayReadInvoices
        ? {
          total: invoiceCount,
          unpaid: invoiceUnpaid,
          billed: dec(invoiceMoney._sum.total),
          collected: dec(invoiceMoney._sum.amount_paid),
          outstanding: dec(invoiceMoney._sum.balance_due),
        }
        : null,
      calendar: { upcoming: calUpcoming, today: calToday },
      todos: { total: todoTotal, pending: todoPending, overdue: todoOverdue },
    };
  }
}
