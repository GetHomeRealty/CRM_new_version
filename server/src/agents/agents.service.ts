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
  /**
   * TD-102 — IS THIS PLAN'S ACCOUNT SOMEBODY WHO CAN BE PUT ON A DEAL TODAY?
   *
   * The plan list answered for names the application will not offer: `listNames()` — the agent
   * picker — is role `agent` AND status `Active`, while this map had no filter at all. So a
   * departed agent, or a manager on a 95% plan, still resolved a rate whenever their name appeared
   * on a deal, typed by hand or carried in by an import. With the agent name being free text
   * (TD-045), a plan nobody can pick is a plan a typo can still reach.
   *
   * THE PLANS ARE NOT REMOVED, deliberately. The two screens that read this map look a member up BY
   * NAME on a deal that already exists, and fall back to 90/95 when there is no entry — so dropping
   * a departed agent's plan would quietly re-rate the historical deals they are on, which is the
   * same harm as the defect. Every plan still resolves; the ones that are not a current agent are
   * now labelled as such, and the screens say so where they apply one.
   */
  active_agent: boolean;
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

  /*
   * TD-037 — this had NO `where` clause at all: every row in `users`, any role, any status,
   * including people who left the brokerage.
   *
   * The one caller is the Deposit Receipt's Cc auto-fill, which looks up a deal's agent/team NAMES
   * in this map with no further check. An unscoped map means the lookup can resolve to anyone in
   * the company who happens to share that name — an admin, an accountant, someone inactive — and
   * whatever email is on THEIR account, personal Gmail included, goes out Cc on a document
   * carrying client and deposit figures. Reproduced: a deal's agent was "Akhil"; this database also
   * holds an unrelated admin named "Akhilesh" whose account email is a personal Gmail address. One
   * typo or a slightly different spelling in a team member's name is the entire distance between
   * Ccing the right agent and Ccing a stranger.
   *
   * Scoped the same way `listNames()` above already is — ACTIVE AGENTS ONLY — because that is the
   * only population this lookup has ever had a reason to search. It does not remove the underlying
   * risk of two active agents sharing a name (a systemic property of a name-keyed map this codebase
   * already accepts elsewhere, see `mine()`'s own comment on namesake collisions), but it removes
   * every case that put a NON-agent's address — the shape this defect actually reported — into a
   * transaction's outgoing mail.
   *
   * NOT THE ONLY FIX. `QuickSendService.agentEmails` resolves the SAME question again, independently,
   * at send time — with the same unscoped bug, until fixed there too. That is the send that actually
   * happens; this map only fills what the screen shows before somebody clicks Send.
   */
  /** Map of active agent name => email, in id order. Agents get their own only. */
  async emails(viewer: Viewer = null): Promise<Record<string, string>> {
    const rows = await this.prisma.users.findMany({
      where: { role: 'agent', status: 'Active' },
      select: { name: true, email: true },
      orderBy: { id: 'asc' },
    });
    const map: Record<string, string> = {};
    for (const u of rows) {
      if (u.email) map[u.name] = u.email;
    }
    return this.mine(map, viewer);
  }

  /** Map of name => registered default commission split. Agents get their own row only. */
  async commissions(viewer: Viewer = null): Promise<Record<string, AgentCommission>> {
    const rows = await this.prisma.users.findMany({
      // TD-102 — role and status come back so each plan can say whether its account is somebody
      // the application would let you put on a deal. The POPULATION is unchanged: every plan that
      // resolved before still resolves.
      select: { name: true, profile: true, role: true, status: true },
      orderBy: { id: 'asc' },
    });
    const map: Record<string, AgentCommission> = {};
    for (const u of rows) {
      const p = parseJsonObject(u.profile);
      const agent = p['agent_comm_pct'];
      if (agent === null || agent === undefined || agent === '') continue;
      const lease = p['lease_comm_pct'];
      map[u.name] = {
        agent_pct: phpFloat(agent),
        lease_pct: lease === null || lease === undefined || lease === '' ? null : phpFloat(lease),
        // The same rule `listNames()` uses to decide who may be offered as an agent, asked here
        // about the person the plan belongs to.
        active_agent: u.role === 'agent' && u.status === 'Active',
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
        /*
         * TD-111 — a repayment counts only while the Agent Adjust section is ON.
         *
         * This was the one consumer of `adjustment_rows` that did not ask. Every other reader gates
         * on the toggle — CommissionService.memberDeduction, the SQL transliteration, the reports'
         * own `loanRepayments`, the two client screens — so a row left behind a No toggle was
         * inert everywhere except here, where it went on repaying the loan. The entry says the
         * risk is entirely in the future; for the loan ledger it was not. An agent whose repayment
         * row was switched off had their outstanding balance reduced by it anyway, and the Agent
         * Financial report and this endpoint disagreed about the same loan.
         */
        if ((adj['agent_adjust'] ?? 'No') !== 'Yes') continue;
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
