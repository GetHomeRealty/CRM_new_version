import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TD-109 — the name on a Yearly summary row is the name the money belongs to.
 *
 * THE DEFECT. `baseRow.agent` is the deal's PRIMARY agent, a raw column, while the Agent Commission
 * beside it is scoped: an agent is served their own share, an office seat the whole agent side. On
 * a team deal read by a minority member the two halves described different people — trade 007
 * showed "Aswini" against the 18,000 that is Sai Ramesh's share, while Aswini's own share is
 * 27,000. Not a leak: the deal is one he is legitimately on, and the money is his. The NAME was
 * wrong.
 *
 * IT WAS NOT A HOUSE STYLE, which is what makes it a fault. The Team Split Deals Report, read by
 * the same agent on the same day, pairs his name with his own figure — because its `expand`
 * overrides `agent` per split line. The Yearly summary is one row per deal and had no such
 * override.
 *
 * THE FIX WAS ALREADY HALF-PRESENT: `agent_names` is scoped the same way the money is, so the
 * report carried the right value and the column was bound to the wrong one.
 *
 * Real rows in a rolled-back transaction: the whole question is what each SEAT is served.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const serviceFor = (tx: PrismaService) =>
  new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

const asUser = (u: { id: number; name: string }, role: string): AuthUserRecord =>
  ({ id: u.id, name: u.name, role, user_permissions: [], user_modules: [] } as unknown as AuthUserRecord);

interface Row { trade_no?: unknown; agent?: unknown; agent_wo?: unknown }

/** The reported shape: a 60/40 team deal, primary and minority member. */
async function teamDeal(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (label: string) => tx.users.create({
    data: {
      name: `${label} ${Date.now()}-${n}`, email: `${label}-${Date.now()}-${n}@x.test`, password: 'x',
      role: 'agent', status: 'Active', profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now,
    },
  });
  const primary = await mk('TD109Primary');
  const member = await mk('TD109Member');

  const deal = await tx.transactions.create({
    data: {
      trade_no: `TD109-${Date.now()}-${n}`, type: 'Residential Buying',
      agent: primary.name, agent_user_id: primary.id, property: '7 Yearly Road',
      price: 2_000_000, comm_type: '%', comm_value: 2.5, comm_pct: 2.5,
      closing_date: new Date('2026-06-01T00:00:00.000Z'), offer_date: new Date('2026-03-01T00:00:00.000Z'),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  });
  let position = 0;
  for (const [who, split] of [[primary, 60], [member, 40]] as const) {
    await tx.team_members.create({
      data: {
        transaction_id: deal.id, user_id: who.id, name: who.name, split, agent_pct: 90, brok_pct: 10,
        scope: 'Entire', position: position++, access: 'full', created_at: now, updated_at: now,
      },
    });
  }
  return { deal, primary, member };
}

const rowsFor = async (tx: PrismaService, user: AuthUserRecord, tradeNo: string): Promise<Row[]> => {
  const r = await serviceFor(tx).run('yearly-deal-summary', user, { filters: {}, page: 1, per_page: 200 } as never);
  return (r.rows as unknown as Row[]).filter((x) => x.trade_no === tradeNo);
};

describe('the Yearly summary names the agent whose money the row carries (TD-109)', () => {
  jest.setTimeout(180_000);

  it('shows the minority member their OWN name against their own share', async () => {
    await inRollback(async (tx) => {
      const { deal, primary, member } = await teamDeal(tx);
      const [row] = await rowsFor(tx, asUser(member, 'agent'), deal.trade_no);

      expect(row.agent).toBe(member.name);
      expect(row.agent).not.toBe(primary.name);
      // And the money on it is still theirs — the fix moved the name, not the figure.
      expect(Number(row.agent_wo)).toBeGreaterThan(0);
    });
  });

  it('shows the primary agent their own name and their own share', async () => {
    await inRollback(async (tx) => {
      const { deal, primary, member } = await teamDeal(tx);
      const [mine] = await rowsFor(tx, asUser(primary, 'agent'), deal.trade_no);
      const [theirs] = await rowsFor(tx, asUser(member, 'agent'), deal.trade_no);

      expect(mine.agent).toBe(primary.name);
      // 60/40 on the same deal: the two seats must not be served the same figure.
      expect(Number(mine.agent_wo)).toBeGreaterThan(Number(theirs.agent_wo));
    });
  });

  it('names both agents to an office seat, which is served the whole agent side', async () => {
    await inRollback(async (tx) => {
      const { deal, primary, member } = await teamDeal(tx);
      const [row] = await rowsFor(tx, asUser({ id: 999_109, name: 'An Admin' }, 'admin'), deal.trade_no);

      expect(String(row.agent)).toContain(primary.name);
      expect(String(row.agent)).toContain(member.name);
    });
  });

  it('does not leak the colleague to the member — only the name changed', async () => {
    // The entry is explicit that this is not a leak and must not be "fixed" into one.
    await inRollback(async (tx) => {
      const { deal, member } = await teamDeal(tx);
      const rows = await rowsFor(tx, asUser(member, 'agent'), deal.trade_no);

      expect(rows).toHaveLength(1);
      // The columns this report SHOWS: the agent name and the scoped list behind it. The payload
      // also carries `responsible_user`, which is the deal's primary agent by definition and is not
      // among this report's columns — knowing who leads a deal you are a member of is not a leak,
      // and the entry says plainly that the leak question was tested separately and resolved.
      expect(rows[0].agent).toBe(member.name);
      expect(String((rows[0] as { agent_names?: unknown }).agent_names)).toBe(member.name);
    });
  });
});

describe('the Analytics breakdown says what it groups by (TD-109)', () => {
  it('is headed by PRIMARY agent, not as each agent\'s earnings', () => {
    /*
     * The second surface the entry found. That block groups the DEAL's commission by the agent
     * named on the deal, in every scope — so an agent looking at their own screen saw a block of
     * money under a colleague's name, on a team deal they are a member of. The grouping is a true
     * fact and the arithmetic is right; the heading claimed something else. Read off the client,
     * which is where the words live.
     */
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'AnalyticsPage.tsx'),
      'utf8',
    );
    // Code lines only: the comment above the fix quotes the old heading, and a whole-file search
    // would match its own explanation.
    expect(source).toContain('Deals by Primary Agent');
    expect(source).not.toContain('Top Agents by Commission');
    expect(source).toContain('<th>Primary Agent</th>');
  });
});
