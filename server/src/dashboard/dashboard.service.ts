import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { normalizeCommissionTxn } from '../transactions/commission.loader';
import { parseJsonObject, round2 } from '../common/serialize';
import type { ResourceUser } from '../transactions/transaction.resource';

import { isAgent } from '../core/authz';
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Transactions per page while summing commissions. Large enough that the round trips are
 * insignificant, small enough that the resident set stays flat regardless of brokerage size.
 */
const TXN_PAGE_SIZE = 200;

/**
 * The relations this endpoint reads. Declared once and used both for the query and for the row
 * type, so the two cannot drift — `normalizeCommissionTxn` needs the team members and precon terms,
 * and the paid/pending split needs the statuses.
 */
const COMMISSION_INCLUDE = {
  transaction_statuses: true,
  team_members: { include: { team_member_terms: true } },
  precon_terms: true,
} as const;

type TxnForCommissions = Prisma.transactionsGetPayload<{ include: typeof COMMISSION_INCLUDE }>;

export interface DashboardCommissions {
  role: 'agent' | 'admin';
  t4a: {
    closed_total: number;
    closed_paid: number;
    closed_pending: number;
    closed_count: number;
    paid_count: number;
    pending_count: number;
    upcoming_total: number;
    upcoming_count: number;
    overall_total: number;
  };
  gross: { overall_total: number };
  referrals: { external_total: number; client_total: number };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  async commissions(user: ResourceUser | null): Promise<DashboardCommissions> {
    const name = user?.name ?? null;

    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    if (isAgent(user) && name) {
      where.OR = [{ agent: name }, { team_members: { some: { name } } }];
    }

    // Every agent profile, once, instead of one lookup per member per transaction.
    //
    // `breakdown()` resolves each member's commission split from `users.profile`, and without a
    // cache that is a query PER MEMBER PER TRANSACTION — the dominant cost of this endpoint and a
    // textbook N×M. The cache parameter already existed; nothing passed one.
    const profiles = await this.userProfiles();

    let paidTotal = 0;
    let pendingTotal = 0;
    let upcomingTotal = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let upcomingCount = 0;
    let grossOverall = 0;
    let externalRef = 0;
    let clientRef = 0;

    // Streamed in pages rather than fetched whole.
    //
    // The previous single findMany had no bound: measured, it grew perfectly linearly to 1,184 ms
    // and a 24.6 MB object graph at 8,000 transactions — on the screen everyone lands on, with
    // every one of those graphs alive in the heap at once under concurrency.
    //
    // Paging by ascending id keeps the iteration order BYTE-FOR-BYTE what it was, which is the
    // whole game here: floating-point addition is not associative, so the order these are summed in
    // decides the last decimal place. The comment this replaces said as much, and it was right.
    for await (const t of this.eachTransaction(where)) {
      const input = normalizeCommissionTxn(t);
      const summary = this.commission.summarize(input);
      const isClosed = t.transaction_statuses.some((s) => s.status === 'Closed');
      const adminActivities = parseJsonObject(t.admin_activities);

      const t4aByName = await this.t4aByMember(input, profiles);
      const members: Record<string, number> = isAgent(user)
        ? { [name as string]: t4aByName[name as string] ?? 0 }
        : t4aByName;

      for (const [mName, amt] of Object.entries(members)) {
        if (this.memberPaid(adminActivities, mName)) {
          paidTotal += amt;
          paidCount++;
        } else if (isClosed) {
          pendingTotal += amt;
          pendingCount++;
        } else {
          upcomingTotal += amt;
          upcomingCount++;
        }
      }

      grossOverall += summary.total;

      const adj = parseJsonObject(t.adjustments);
      externalRef += this.externalReferral(adj);
      clientRef += this.clientReferral(adj);
    }

    const closedTotal = paidTotal + pendingTotal;
    const closedCount = paidCount + pendingCount;

    return {
      role: isAgent(user) ? 'agent' : 'admin',
      t4a: {
        closed_total: round2(closedTotal),
        closed_paid: round2(paidTotal),
        closed_pending: round2(pendingTotal),
        closed_count: closedCount,
        paid_count: paidCount,
        pending_count: pendingCount,
        upcoming_total: round2(upcomingTotal),
        upcoming_count: upcomingCount,
        overall_total: round2(closedTotal + upcomingTotal),
      },
      gross: { overall_total: round2(grossOverall) },
      referrals: { external_total: round2(externalRef), client_total: round2(clientRef) },
    };
  }

  /**
   * Commission profiles keyed by name, resolved with the SAME query the uncached path uses —
   * once per distinct person instead of once per member per transaction.
   *
   * THIS DELIBERATELY DOES NOT BATCH INTO A SINGLE `findMany`, and the reason is worth keeping.
   * `agentDefaultSplit` resolves a split with `users.findFirst({ where: { name } })`. Two active
   * accounts in this brokerage are both called "Akhil", with `agent_comm_pct` of 0 and 90. A
   * `findMany` plus a rule for picking a winner requires knowing which row `findFirst` would have
   * returned — and `findFirst` without `orderBy` has NO DEFINED ORDER. Measured here it returns the
   * higher id, not the lower; an obvious "first by id wins" cache picked the 0% row and silently
   * zeroed that agent's commission. The parity gate caught it, to the cent.
   *
   * Reusing the identical query per name cannot drift from the uncached path, whatever the database
   * decides to return. It costs one query per distinct person — six here, forty in a large office —
   * against one per member per transaction before.
   *
   * The cache must also be COMPLETE for the names it will be asked about, because a miss is treated
   * as an empty profile and does NOT fall back to a query: a partially-filled map would quietly
   * substitute the default 90/95 split for somebody's real one.
   *
   * The duplicate name itself is a latent hazard this only works around — see the note in
   * `docs/PERFORMANCE-AUDIT.md`. Splits are looked up by NAME, so two people sharing one is
   * ambiguous by construction, and which of them a deal pays is currently decided by the query
   * planner.
   */
  private async userProfiles(): Promise<Map<string, Record<string, unknown>>> {
    const [agents, members] = await Promise.all([
      this.prisma.transactions.findMany({ where: { agent: { not: null } }, select: { agent: true }, distinct: ['agent'] }),
      this.prisma.team_members.findMany({ select: { name: true }, distinct: ['name'] }),
    ]);

    const names = [...new Set([
      ...agents.map((a) => a.agent),
      ...members.map((m) => m.name),
    ])].filter((n): n is string => typeof n === 'string' && n.length > 0);

    const out = new Map<string, Record<string, unknown>>();
    for (const name of names) {
      const u = await this.prisma.users.findFirst({ where: { name }, select: { profile: true } });
      out.set(name, parseJsonObject(u?.profile));
    }
    return out;
  }

  /**
   * Walk the matching transactions in ascending id order, a page at a time.
   *
   * Cursor paging rather than offset: `skip` re-walks every row before the offset, so the last page
   * of a large table costs the most. The cursor turns each page into an index seek.
   *
   * The page size is a memory/round-trip trade, not a correctness one — the sequence of rows handed
   * to the caller is identical to the unbounded query, which is what keeps the arithmetic identical.
   */
  private async *eachTransaction(where: Prisma.transactionsWhereInput): AsyncGenerator<TxnForCommissions> {
    let cursor: number | undefined;
    for (;;) {
      const page: TxnForCommissions[] = await this.prisma.transactions.findMany({
        where,
        orderBy: { id: 'asc' },
        take: TXN_PAGE_SIZE,
        ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
        include: COMMISSION_INCLUDE,
      });
      if (page.length === 0) return;
      for (const t of page) yield t;
      if (page.length < TXN_PAGE_SIZE) return;
      cursor = page[page.length - 1].id;
    }
  }

  /** Member name → total agent T4A (HST-inclusive) across every commission variant. */
  private async t4aByMember(
    input: ReturnType<typeof normalizeCommissionTxn>,
    profiles: Map<string, Record<string, unknown>>,
  ): Promise<Record<string, number>> {
    const bd = await this.commission.breakdown(input, profiles);
    const out: Record<string, number> = {};
    const add = (line: Record<string, unknown>): void => {
      const lineName = line['name'] as string | null | undefined;
      if (lineName === null || lineName === undefined) return;
      const t4a = line['t4a'] as { total?: number } | undefined;
      out[lineName] = (out[lineName] ?? 0) + num(t4a?.total ?? 0);
    };

    if (bd['variant'] === 'precon') {
      for (const term of (bd['terms'] as Record<string, unknown>[] | undefined) ?? []) {
        for (const line of (term['agents'] as Record<string, unknown>[] | undefined) ?? []) add(line);
      }
    } else {
      for (const line of (bd['agents'] as Record<string, unknown>[] | undefined) ?? []) add(line);
    }
    return out;
  }

  private memberPaid(adminActivities: Record<string, unknown>, name: string | null): boolean {
    if (name === null) return false;
    const agents = adminActivities['agents'] as Record<string, unknown> | undefined;
    const record = agents?.[name];
    if (!record || typeof record !== 'object') return false;
    const payments = (record as Record<string, unknown>)['payments'];
    if (!Array.isArray(payments)) return false;
    return payments.some((p) => (p as Record<string, unknown>)?.['paid_status'] === 'Paid');
  }

  private externalReferral(adj: Record<string, unknown>): number {
    if ((adj['ext_referral'] ?? 'No') !== 'Yes') return 0;
    const ext = adj['ext'] as Record<string, unknown> | undefined;
    return num(ext?.['amount'] ?? 0);
  }

  private clientReferral(adj: Record<string, unknown>): number {
    if ((adj['client_referral'] ?? 'No') !== 'Yes') return 0;
    let sum = 0;
    for (const row of (adj['client_rows'] as Record<string, unknown>[] | undefined) ?? []) {
      sum += num(row?.['amount'] ?? 0);
    }
    return sum;
  }
}
