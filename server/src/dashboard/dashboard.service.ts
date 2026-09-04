import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { normalizeCommissionTxn } from '../transactions/commission.loader';
import { parseJsonObject, round2 } from '../common/serialize';
import type { ResourceUser } from '../transactions/transaction.resource';

import { isAgent } from '../core/authz';
import { transactionScopeWhere } from '../common/transaction-scope';
import { withWorkMem, workMemSetting } from '../common/work-mem';
import {
  commissionsSqlForAgent,
  commissionsSqlForOffice,
  commissionsSqlHeadline,
  type CommissionHeadlineRow,
  type CommissionVariant,
  type CommissionVariantRow,
} from './desk-commission.sql';

/**
 * The sort budget for the commission statements.
 *
 * These sort the deal's member set and then the line set. At PostgreSQL's 4 MB default both spill
 * to disk — measured across the load runs, 20 GB of temp files — and raising it took the single-
 * statement version from 13.6 s to 11.2 s on its own. Set LOCAL per statement, so it applies to
 * these queries and to nothing else the connection goes on to do.
 *
 * Env: DESK_COMMISSION_WORK_MEM
 */
const COMMISSION_WORK_MEM = workMemSetting(process.env.DESK_COMMISSION_WORK_MEM, '64MB');

/** How long one commission statement may run. See `withWorkMem` for why this is not the default. */
const COMMISSION_TIMEOUT_MS = 120_000;
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
  /*
   * TD-047 — WHAT THE COUNTS ON THIS PAYLOAD ARE COUNTING.
   *
   * The dashboard reported "7 open deals" on a screen whose own Total Deals tile read 6, and the
   * card was not wrong about its arithmetic: these counts are per COMMISSION LINE — one per team
   * member per deal — because that is what a commission total is a sum of. A deal with three
   * members contributes three. Counting deals instead would make the money and the count on the
   * same tile describe different things, so the number stays and the payload now says what it is.
   *
   * It is not the same for everybody, which is why this is a field rather than a note. An agent's
   * figures come from `commissionsSqlForAgent`, which LEFT JOINs each visible deal to that agent's
   * own line — one row per deal, including deals they are not a member of, at zero. For them the
   * count IS deals. It is derived from the same boolean that picks the query, so the two cannot
   * drift apart.
   */
  count_basis: 'deals' | 'commission_lines';
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

/** What a caller who can see nothing is shown — zeros, not an error and not everybody's figures. */
const emptyCommissions = (user: ResourceUser | null): DashboardCommissions => ({
  role: isAgent(user) ? 'agent' : 'admin',
  count_basis: isAgent(user) ? 'deals' : 'commission_lines',
  t4a: {
    closed_total: 0, closed_paid: 0, closed_pending: 0, closed_count: 0,
    paid_count: 0, pending_count: 0, upcoming_total: 0, upcoming_count: 0, overall_total: 0,
  },
  gross: { overall_total: 0 },
  referrals: { external_total: 0, client_total: 0 },
});

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
    private readonly people: PersonResolver,
  ) {}

  /**
   * The Dashboard's commission figures — computed by the database.
   *
   * WHAT THIS REPLACES. `commissionsInNode` below, which is still here and still correct: it read
   * every non-deleted transaction in the brokerage with three relations attached and ran the full
   * commission breakdown on each. Measured at 80,000 deals it took 9,580 ms for one office user and
   * had a 62,663 ms MEDIAN with a hundred people signed in — on the landing screen. No index helps
   * with that, because the work is not the query.
   *
   * The same nine figures now come back from one statement: `desk-commission.sql.ts`. That file is a
   * transliteration of the T4A path through `CommissionService.breakdown`, and the risk it carries —
   * a second copy of the commission math — is held down by `core/desk-sql-parity.spec.ts`, which
   * runs BOTH implementations over every transaction in the database, for every role, and requires
   * exact equality on every figure.
   *
   * `commissionsInNode` is therefore not dead code. It is the reference the SQL is measured against,
   * and deleting it would remove the only thing that makes the SQL trustworthy with money.
   */
  async commissions(user: ResourceUser | null): Promise<DashboardCommissions> {
    /*
     * ONE COMPUTATION AT A TIME PER SCOPE — everybody asking for the same figures waits on the same
     * query rather than starting their own.
     *
     * This is the concurrency half of the problem and it is separate from the speed half. Measured
     * with a hundred people signed in, the Dashboard's median was 62,663 ms against 9,580 ms for one
     * person alone: the endpoint was not six times slower under load, it was doing the same
     * brokerage-wide work once per visitor and they were all queueing behind each other's copy of it.
     *
     * Every office user shares one scope key, so a shift change — twenty people opening the
     * Dashboard within a few seconds — is now one aggregate, not twenty. Agents each get their own
     * key, which is correct: their figures are their own.
     *
     * NOTHING IS CACHED AND NOTHING IS SERVED STALE. The promise is dropped the moment it settles,
     * so the next request after it completes runs a fresh query. A result cache would be faster
     * again, but `transactions.updated_at` has one-second granularity, so no cheap version key can
     * prove a total is current — and a commission figure that is quietly a few seconds old is a
     * different thing from a slow one.
     */
    const key = isAgent(user) ? `agent:${user?.id ?? 0}:${user?.name ?? ''}` : 'office';
    const running = this.inflight.get(key);
    if (running) return running;

    const p = this.computeCommissions(user).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** In-progress commission aggregates, keyed by scope. See `commissions`. */
  private readonly inflight = new Map<string, Promise<DashboardCommissions>>();

  /**
   * FOUR STATEMENTS, RUN AT ONCE — three commission variants and the deal-level headline.
   *
   * As one statement this was 6,525 ms at 80,000 deals and could not be tuned below it, for a
   * structural reason: every CTE in it is MATERIALIZED (each is referenced more than once, so
   * PostgreSQL will not inline them), and a materialised CTE is evaluated by the leader process
   * alone. Eleven idle cores and no way to use them.
   *
   * The variants partition the deals — standard, listing, preconstruction, no overlap and no gaps —
   * so three statements on three connections give the planner three independent plans over about a
   * third of the rows each, on three backends. Wall-clock becomes the slowest branch instead of the
   * sum. The headline query touches every deal but needs no member resolution, so it rides along.
   *
   * ADDING THE SUBTOTALS IS EXACT. Each is a two-decimal `numeric` and decimal addition is
   * associative, so the order cannot move a cent — and `desk-sql-parity.spec.ts` compares the
   * assembled answer against the original TypeScript loop, which is what proves it.
   *
   * `work_mem` is raised for the duration of each statement. These queries sort the member set and
   * the line set; at the 4 MB default those sorts spill to disk, and measured over the load runs
   * PostgreSQL wrote 20 GB of temp files. It is set LOCAL, so it lasts exactly as long as the
   * transaction and affects nothing else on the connection.
   */
  private async computeCommissions(user: ResourceUser | null): Promise<DashboardCommissions> {
    const scope = await this.scopeSql(user);
    if (scope === null) return emptyCommissions(user);

    const agent = isAgent(user);
    const name = user?.name ?? '';

    const variantRows = await Promise.all(
      (['standard', 'listing', 'precon'] as CommissionVariant[]).map((v) =>
        this.withWorkMem<CommissionVariantRow>(
          agent ? commissionsSqlForAgent(scope, v) : commissionsSqlForOffice(scope, v),
          agent ? [name] : [],
        ),
      ),
    );
    const headline = await this.headline(scope);

    let paidTotal = 0, pendingTotal = 0, upcomingTotal = 0;
    let paidCount = 0, pendingCount = 0, upcomingCount = 0;
    for (const rows of variantRows) {
      const r = rows[0];
      if (!r) continue;
      paidTotal += Number(r.paid_total);
      pendingTotal += Number(r.pending_total);
      upcomingTotal += Number(r.upcoming_total);
      paidCount += Number(r.paid_count);
      pendingCount += Number(r.pending_count);
      upcomingCount += Number(r.upcoming_count);
    }
    const closedTotal = paidTotal + pendingTotal;

    return {
      role: agent ? 'agent' : 'admin',
      // TD-047 — `agent` is the same boolean that chose between the per-deal and the per-line
      // query a few lines above, so the basis reported here is the basis actually counted.
      count_basis: agent ? 'deals' : 'commission_lines',
      t4a: {
        closed_total: round2(closedTotal),
        closed_paid: round2(paidTotal),
        closed_pending: round2(pendingTotal),
        closed_count: paidCount + pendingCount,
        paid_count: paidCount,
        pending_count: pendingCount,
        upcoming_total: round2(upcomingTotal),
        upcoming_count: upcomingCount,
        overall_total: round2(closedTotal + upcomingTotal),
      },
      gross: { overall_total: round2(Number(headline.gross_total)) },
      referrals: {
        external_total: round2(Number(headline.ext_ref_total)),
        client_total: round2(Number(headline.client_ref_total)),
      },
    };
  }

  private async headline(scope: string): Promise<CommissionHeadlineRow> {
    const rows = await this.withWorkMem<CommissionHeadlineRow>(commissionsSqlHeadline(scope), []);
    return rows[0] ?? { gross_total: '0', ext_ref_total: '0', client_ref_total: '0' };
  }

  /** See `common/work-mem.ts` — shared with the Reports totals, which hit the same two traps. */
  private withWorkMem<T>(sql: string, params: unknown[]): Promise<T[]> {
    return withWorkMem(this.prisma, COMMISSION_WORK_MEM, COMMISSION_TIMEOUT_MS,
      (tx) => tx.$queryRawUnsafe<T[]>(sql, ...params));
  }

  /**
   * The visibility rule as a SQL predicate — resolved THROUGH `transactionScopeWhere`, never
   * re-spelled.
   *
   * This is the one place this service could get authorization wrong, so it does not write the rule.
   * `common/transaction-scope.ts` is deliberately the single definition of "which deals are mine" —
   * the id first, the name only for rows that never resolved to an account — because this brokerage
   * has two active accounts sharing a name, and a second spelling of that rule is exactly how one of
   * them ends up reading the other's deals. Hand-written SQL here would be that second spelling.
   *
   * So Prisma evaluates the rule, as everywhere else, and this asks it for the matching ids. For an
   * agent that is their own deals — tens or hundreds, not the brokerage — so the id list is small
   * beside the aggregate it scopes. For everybody else the rule is empty and no extra query runs.
   *
   * `null` means "matches nothing", which is a different answer from "matches everything" and must
   * never collapse into it.
   */
  private async scopeSql(user: ResourceUser | null): Promise<string | null> {
    const where = transactionScopeWhere(user);
    if (Object.keys(where).length === 0) return 'TRUE';
    const rows = await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, where] },
      select: { id: true },
    });
    if (rows.length === 0) return null;
    return `t.id IN (${rows.map((x) => x.id).join(',')})`;
  }

  /**
   * The ORIGINAL implementation, in Node — the reference the SQL aggregate is checked against.
   *
   * Kept verbatim and still exercised: `core/desk-sql-parity.spec.ts` calls this and `commissions()`
   * over the same data for every role and compares every numeric leaf for exact equality. It is not
   * on any request path.
   */
  async commissionsInNode(user: ResourceUser | null): Promise<DashboardCommissions> {
    const name = user?.name ?? null;

    // Scoped by the shared rule — by user id, with the name kept only for rows that never
    // resolved to an account. See `common/transaction-scope.ts`.
    const where: Prisma.transactionsWhereInput = { AND: [{ deleted_at: null }, transactionScopeWhere(user)] };

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

      // Before HST, for the same reason — this is the brokerage's gross COMMISSION, not its billings.
      grossOverall += summary.amount;

      const adj = parseJsonObject(t.adjustments);
      externalRef += this.externalReferral(adj);
      clientRef += this.clientReferral(adj);
    }

    const closedTotal = paidTotal + pendingTotal;
    const closedCount = paidCount + pendingCount;

    return {
      role: isAgent(user) ? 'agent' : 'admin',
      // TD-047 — `isAgent` is what narrowed `members` to the caller's own line per deal above;
      // the enrichment path and the SQL path therefore report the same basis for the same user.
      count_basis: isAgent(user) ? 'deals' : 'commission_lines',
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
   * IT NOW BATCHES, AND THE REASON IT PREVIOUSLY COULD NOT IS THE THING THAT CHANGED.
   *
   * This used to run one `findFirst({ where: { name } })` per name, deliberately, because that is
   * what the uncached path did and `findFirst` without an `orderBy` has NO DEFINED ORDER. Two
   * active accounts in this brokerage are both called "Akhil", with `agent_comm_pct` of 0 and 90;
   * an obvious "first by id wins" cache picked the 0% row and silently zeroed that agent's
   * commission — a $21,865.50 error the parity gate caught, to the cent. Matching the query exactly
   * was the only way to be sure the cache agreed with the uncached path.
   *
   * `PersonResolver` removes that constraint by making the rule explicit rather than leaving it to
   * the planner: an Active row wins, ties break on the lowest id, everywhere. Both paths now go
   * through it, so they cannot disagree — and one query replaces one per distinct person.
   *
   * The cache must still be COMPLETE for the names it will be asked about, because a miss is treated
   * as an empty profile and does NOT fall back to a query: a partially-filled map would quietly
   * substitute the default 90/95 split for somebody's real one.
   *
   * The duplicate name remains a hazard this only makes deterministic, not correct — two people
   * sharing a name is ambiguous by construction. What fixes it properly is the id: `agent_user_id`
   * and `team_members.user_id` are preferred wherever a row has them (migration
   * 20260803010000_person_user_ids), and the Users module now refuses to create a second account
   * with an existing name.
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

    /*
     * One query for the lot, resolved the same way the uncached path resolves.
     *
     * This was a `findFirst` per name with no `orderBy`, so which of two namesakes won was the
     * query planner's choice — and could change after a VACUUM or a restore with no code change.
     * `PersonResolver` applies one deterministic rule everywhere: an Active row wins, ties go to the
     * lowest id. The parity gate below is what proves the cached and uncached paths still agree to
     * the cent, which is the property that matters here.
     */
    const resolved = await this.people.resolveManyByName(names);
    const out = new Map<string, Record<string, unknown>>();
    for (const name of names) out.set(name, parseJsonObject(resolved.get(name)?.profile));
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
      /*
       * `commission`, not `total` — the agent's commission BEFORE HST.
       *
       * The `t4a` block is a Triple: commission, the HST on it, and their sum. Summing `total` made
       * every dashboard commission tile 13% higher than the money the brokerage or the agent
       * actually earned, because HST is collected on their behalf and remitted rather than kept.
       * Invoice tiles are the deliberate exception and are computed elsewhere: an invoice total is
       * what was billed, and HST belongs in that.
       */
      const t4a = line['t4a'] as { commission?: number } | undefined;
      out[lineName] = (out[lineName] ?? 0) + num(t4a?.commission ?? 0);
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
