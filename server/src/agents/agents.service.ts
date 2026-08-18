import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAgent } from '../core/authz';
import { parseJsonObject, phpEmpty, phpFloat, round2, toDateString, toFloat } from '../common/serialize';

interface Repayment {
  trade_no: string;
  property: string | null;
  closing_date: string | null;
  amount: number;
}
interface LoanAgg {
  loan_amount: number;
  loan_repaid: number;
  repayments: Repayment[];
}
export interface AgentCommission {
  agent_pct: number;
  lease_pct: number | null;
}
export interface AgentLoan {
  loan_amount: number;
  loan_repaid: number;
  loan_balance: number;
  repayments: Repayment[];
}

/** Just enough of the signed-in user to decide whose rows they may read. */
type Viewer = { name?: string | null; role?: string | null } | null;

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Narrow a name-keyed map to the caller's own entry when the caller is an agent.
   *
   * These three maps carry money — commission splits, loan balances, contact addresses — and were
   * returned whole to every authenticated caller. An agent has a legitimate need for exactly one
   * row of each: their own, which is what the Team Split and Financial screens read to show them
   * their default split. Everyone above agent works across the brokerage by definition and keeps
   * the full map.
   *
   * Keyed by NAME because that is the shape the screens consume; the caller's own name is not an
   * authorization decision here, only a lookup of the row they are already entitled to. A namesake
   * collision therefore discloses nothing that is not already ambiguous in the underlying data —
   * unlike the transaction scope, where the id rule is what keeps two people apart.
   */
  private mine<T>(map: Record<string, T>, viewer: Viewer): Record<string, T> {
    if (!viewer || !isAgent(viewer)) return map;
    const name = (viewer.name ?? '').trim();
    const own = name === '' ? undefined : map[name];
    return own === undefined ? {} : { [name]: own };
  }

  /** Active Agent-role users, case-insensitively by name (matches MySQL ci ordering). */
  async listNames(): Promise<string[]> {
    const rows = await this.prisma.users.findMany({
      // status is NOT NULL in the DB, so Laravel's `orWhereNull('status')` branch
      // can never match — this equals `where role='agent' AND status='Active'`.
      where: { role: 'agent', status: 'Active' },
      select: { name: true },
    });
    return rows
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }

  /** Map of user name => email (users with an email), in id order. Agents get their own only. */
  async emails(viewer: Viewer = null): Promise<Record<string, string>> {
    const rows = await this.prisma.users.findMany({ select: { name: true, email: true }, orderBy: { id: 'asc' } });
    const map: Record<string, string> = {};
    for (const u of rows) {
      if (u.email) map[u.name] = u.email;
    }
    return this.mine(map, viewer);
  }

  /** Map of name => registered default commission split. Agents get their own row only. */
  async commissions(viewer: Viewer = null): Promise<Record<string, AgentCommission>> {
    const rows = await this.prisma.users.findMany({ select: { name: true, profile: true }, orderBy: { id: 'asc' } });
    const map: Record<string, AgentCommission> = {};
    for (const u of rows) {
      const p = parseJsonObject(u.profile);
      const agent = p['agent_comm_pct'];
      if (agent === null || agent === undefined || agent === '') continue;
      const lease = p['lease_comm_pct'];
      map[u.name] = {
        agent_pct: phpFloat(agent),
        lease_pct: lease === null || lease === undefined || lease === '' ? null : phpFloat(lease),
      };
    }
    return this.mine(map, viewer);
  }

  /** Per-agent loan position. Agents get their own row only — see `mine`. */
  async loans(viewer: Viewer = null): Promise<Record<string, AgentLoan>> {
    const users = await this.prisma.users.findMany({ select: { name: true, profile: true }, orderBy: { id: 'asc' } });
    const loans: Record<string, LoanAgg> = {};
    for (const u of users) {
      const p = parseJsonObject(u.profile);
      const amount = toFloat(p['loan_amount'] ?? 0);
      if (!phpEmpty(p['has_loan']) && amount > 0) {
        loans[u.name] = { loan_amount: amount, loan_repaid: 0, repayments: [] };
      }
    }

    if (Object.keys(loans).length > 0) {
      const txns = await this.prisma.transactions.findMany({
        where: { deleted_at: null, adjustments: { not: null } },
        select: { id: true, trade_no: true, property: true, closing_date: true, adjustments: true },
        orderBy: { id: 'asc' },
      });
      for (const t of txns) {
        const adj = parseJsonObject(t.adjustments);
        const rows = Array.isArray(adj['adjustment_rows']) ? (adj['adjustment_rows'] as Record<string, unknown>[]) : [];
        for (const r of rows) {
          if (phpEmpty(r['is_loan'])) continue;
          const name = (r['agent'] ?? null) as string | null;
          if (name === null || !(name in loans)) continue;
          const amt = toFloat(r['amount'] ?? 0);
          if (amt > 0) {
            loans[name].loan_repaid += amt;
            loans[name].repayments.push({
              trade_no: t.trade_no,
              property: t.property,
              closing_date: toDateString(t.closing_date),
              amount: round2(amt),
            });
          }
        }
      }
    }

    const out: Record<string, AgentLoan> = {};
    for (const [name, v] of Object.entries(loans)) {
      out[name] = {
        loan_amount: round2(v.loan_amount),
        loan_repaid: round2(v.loan_repaid),
        loan_balance: Math.max(0, round2(v.loan_amount - v.loan_repaid)),
        repayments: v.repayments,
      };
    }
    return this.mine(out, viewer);
  }
}
