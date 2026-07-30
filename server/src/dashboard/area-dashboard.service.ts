import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

import { isAgent } from '../core/authz';
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
  invoices: { total: number; unpaid: number; billed: number; collected: number; outstanding: number };
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

@Injectable()
export class AreaDashboardService {
  constructor(private readonly prisma: PrismaService) {}

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
  async crm(user: AuthUserRecord | null): Promise<CrmDashboard> {
    const userId = user?.id ?? -1;
    // Leads are assigned, so an agent's dashboard counts the ones assigned to them. Mirrors how the
    // Leads screen already scopes, so the two never disagree.
    const leadWhere: Prisma.leadsWhereInput = isAgent(user) ? { assigned_to: userId } : {};
    const taskWhere: Prisma.lead_tasksWhereInput = isAgent(user)
      ? { OR: [{ assigned_to: userId }, { user_id: userId }] }
      : {};
    const today = this.startOfToday();
    const personal = { user_id: userId, deleted_at: null };

    const [
      leadTotal, byStatus, bySource, newThisWeek,
      taskTotal, taskPending, taskCompleted, taskCancelled, taskToday, taskOverdue,
      campaignAgg, campaignCount,
      unread,
      calUpcoming, calToday,
      todoTotal, todoPending, todoOverdue,
    ] = await Promise.all([
      this.prisma.leads.count({ where: leadWhere }),
      this.prisma.leads.groupBy({ by: ['lead_status'], _count: { _all: true }, where: leadWhere }),
      this.prisma.leads.groupBy({ by: ['lead_source'], _count: { _all: true }, where: leadWhere }),
      this.prisma.leads.count({ where: { ...leadWhere, created_at: { gte: this.daysFromToday(-7) } } }),

      this.prisma.lead_tasks.count({ where: taskWhere }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'pending' } }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'completed' } }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'cancelled' } }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'pending', due_date: today } }),
      this.prisma.lead_tasks.count({ where: { ...taskWhere, status: 'pending', due_date: { lt: today } } }),

      this.prisma.campaigns.aggregate({ _sum: { sent: true, opened: true, failed: true } }),
      this.prisma.campaigns.count(),

      // The CRM's own mailbox: mail from accounts connected under CRM Settings.
      this.prisma.inbound_emails.count({
        where: { user_id: userId, seen: false, mail_account: { is: { OR: [{ scope: 'crm' }, { scope: null }] } } },
      }),

      this.prisma.calendar_events.count({
        where: { ...personal, ...this.areaOr('crm'), date: { gte: today, lt: this.daysFromToday(30) } },
      }),
      this.prisma.calendar_events.count({ where: { ...personal, ...this.areaOr('crm'), date: today } }),

      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('crm') } }),
      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('crm'), status: 'pending' } }),
      this.prisma.todos.count({ where: { ...personal, ...this.areaOr('crm'), status: 'pending', due_date: { lt: today } } }),
    ]);

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

      this.prisma.invoices.count({ where: { deleted_at: null } }),
      this.prisma.invoices.count({ where: { deleted_at: null, status: { not: 'Paid' } } }),
      this.prisma.invoices.aggregate({ _sum: { total: true, amount_paid: true, balance_due: true }, where: { deleted_at: null } }),

      this.prisma.calendar_events.count({
        where: { ...personal, ...this.areaOr('desk'), date: { gte: today, lt: this.daysFromToday(30) } },
      }),
      this.prisma.calendar_events.count({ where: { ...personal, ...this.areaOr('desk'), date: today } }),

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
      invoices: {
        total: invoiceCount,
        unpaid: invoiceUnpaid,
        billed: dec(invoiceMoney._sum.total),
        collected: dec(invoiceMoney._sum.amount_paid),
        outstanding: dec(invoiceMoney._sum.balance_due),
      },
      calendar: { upcoming: calUpcoming, today: calToday },
      todos: { total: todoTotal, pending: todoPending, overdue: todoOverdue },
    };
  }
}
