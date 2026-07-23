import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { normalizeCommissionTxn } from '../transactions/commission.loader';
import { parseJsonObject, round2 } from '../common/serialize';
import type { ResourceUser } from '../transactions/transaction.resource';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
    const isAgent = !!user && user.role === 'agent';
    const name = user?.name ?? null;

    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    if (isAgent && name) {
      where.OR = [{ agent: name }, { team_members: { some: { name } } }];
    }

    const txns = await this.prisma.transactions.findMany({
      where,
      orderBy: { id: 'asc' }, // match Laravel's PK-order iteration for identical fp sums
      include: {
        transaction_statuses: true,
        team_members: { include: { team_member_terms: true } },
        precon_terms: true,
      },
    });

    let paidTotal = 0;
    let pendingTotal = 0;
    let upcomingTotal = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let upcomingCount = 0;
    let grossOverall = 0;
    let externalRef = 0;
    let clientRef = 0;

    for (const t of txns) {
      const input = normalizeCommissionTxn(t);
      const summary = this.commission.summarize(input);
      const isClosed = t.transaction_statuses.some((s) => s.status === 'Closed');
      const adminActivities = parseJsonObject(t.admin_activities);

      const t4aByName = await this.t4aByMember(input);
      const members: Record<string, number> = isAgent
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
      role: isAgent ? 'agent' : 'admin',
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

  /** Member name → total agent T4A (HST-inclusive) across every commission variant. */
  private async t4aByMember(input: ReturnType<typeof normalizeCommissionTxn>): Promise<Record<string, number>> {
    const bd = await this.commission.breakdown(input);
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
