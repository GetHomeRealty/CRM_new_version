import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TD-060 — "Split n of m" counts the DEAL's agents, not the rows the reader is allowed to see.
 *
 * THE DEFECT. On the Team Split Deals Report an agent saw "Split 1 of 1" on deals that carry two
 * agents. The row scoping was right and stays: an agent is served only their own line, with their
 * own figures. The LABEL was built from that scoped array — `Split ${i + 1} of ${t.splits.length}`
 * — so the denominator was "how many rows may you see" rather than "how many agents are on this
 * deal". It fails in the one direction that matters: it hides the existence of a co-agent from
 * somebody reconciling their own commission.
 *
 * WHY IT LOOKED FIXED. An administrator is not scoped, so for them the two counts coincide and
 * every label reads correctly. A re-test that runs the report as a Super Admin cannot see this
 * defect at all — which is what the entry records, and why this test runs it BOTH ways over one
 * fixture and compares.
 *
 * WHAT MUST NOT WIDEN WITH IT. Only the count crosses the scope. The agent's rows must still carry
 * no other agent's name, ratio or money, and there must still be exactly one row per agent —
 * asserted below, because "show them the whole split" would be a data leak dressed as a fix.
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

interface Row { agent?: unknown; split_no?: unknown; split_ratio?: unknown; trade_no?: unknown }

/** A closed two-agent deal: 60/40 between the primary and a second member. */
async function twoAgentDeal(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = async (label: string) => tx.users.create({
    data: {
      name: `${label} ${Date.now()}-${n}`, email: `${label}-${Date.now()}-${n}@x.test`, password: 'x',
      role: 'agent', status: 'Active', profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now,
    },
  });
  const primary = await mk('TD060Primary');
  const second = await mk('TD060Second');

  const deal = await tx.transactions.create({
    data: {
      trade_no: `TD060-${Date.now()}-${n}`, type: 'Residential Buying',
      agent: primary.name, agent_user_id: primary.id, property: '1 Split Road',
      price: 800_000, comm_type: '%', comm_value: 2.5, comm_pct: 2.5,
      offer_date: new Date('2026-03-01T00:00:00.000Z'), closing_date: new Date('2026-06-01T00:00:00.000Z'),
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  });
  await tx.transaction_statuses.create({
    data: { transaction_id: deal.id, status: 'Closed', created_at: now, updated_at: now },
  });
  let position = 0;
  for (const [member, split] of [[primary, 60], [second, 40]] as const) {
    await tx.team_members.create({
      data: {
        transaction_id: deal.id, user_id: member.id, name: member.name, split, agent_pct: 90, brok_pct: 10,
        scope: 'Entire', position: position++, access: 'full', created_at: now, updated_at: now,
      },
    });
  }
  return { deal, primary, second };
}

const run = async (tx: PrismaService, user: AuthUserRecord): Promise<Row[]> => {
  const r = await serviceFor(tx).run('team-split-deals', user, { filters: {}, page: 1, per_page: 200 } as never);
  return (r.rows as unknown as Row[]);
};

describe('the Team Split report numbers rows by the deal (TD-060)', () => {
  jest.setTimeout(180_000);

  it('labels an agent\'s single row with its real place among the deal\'s agents', async () => {
    await inRollback(async (tx) => {
      const { deal, primary, second } = await twoAgentDeal(tx);

      for (const [who, expected] of [[primary, 'Split 1 of 2'], [second, 'Split 2 of 2']] as const) {
        const rows = (await run(tx, asUser(who, 'agent'))).filter((r) => r.trade_no === deal.trade_no);

        // The scoping is untouched: their own line, and only theirs.
        expect([who.name, rows.length]).toEqual([who.name, 1]);
        expect([who.name, rows[0].agent]).toEqual([who.name, who.name]);
        // The label describes the deal — this is the assertion the defect fails: it read "1 of 1".
        expect([who.name, rows[0].split_no]).toEqual([who.name, expected]);
      }
    });
  });

  it('tells an administrator exactly the same thing, on every row', async () => {
    await inRollback(async (tx) => {
      const { deal, primary, second } = await twoAgentDeal(tx);
      const rows = (await run(tx, asUser({ id: 999_000, name: 'An Admin' }, 'admin')))
        .filter((r) => r.trade_no === deal.trade_no);

      expect(rows.map((r) => r.split_no)).toEqual(['Split 1 of 2', 'Split 2 of 2']);
      expect(rows.map((r) => r.agent)).toEqual([primary.name, second.name]);
    });
  });

  it('does not leak the other agent while widening the count', async () => {
    // The fix must add a NUMBER and nothing else. If somebody "fixes" this by dropping the row
    // scoping, this is what fails.
    await inRollback(async (tx) => {
      const { deal, primary, second } = await twoAgentDeal(tx);
      const rows = (await run(tx, asUser(primary, 'agent'))).filter((r) => r.trade_no === deal.trade_no);

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(second.name);
    });
  });

  it('numbers the middle of a three-agent deal, not just the ends', async () => {
    // Position, not "first or last": the second of three must read 2, which a fix that merely
    // corrected the denominator would get wrong.
    await inRollback(async (tx) => {
      const { deal, second } = await twoAgentDeal(tx);
      const now = new Date();
      const third = await tx.users.create({
        data: {
          name: `TD060Third ${Date.now()}-${++seq}`, email: `td060third-${Date.now()}-${seq}@x.test`,
          password: 'x', role: 'agent', status: 'Active', profile: '{"agent_comm_pct":"90"}',
          created_at: now, updated_at: now,
        },
      });
      await tx.team_members.create({
        data: {
          transaction_id: deal.id, user_id: third.id, name: third.name, split: 0, agent_pct: 90, brok_pct: 10,
          scope: 'Entire', position: 2, access: 'full', created_at: now, updated_at: now,
        },
      });

      const mine = (await run(tx, asUser(second, 'agent'))).filter((r) => r.trade_no === deal.trade_no);
      expect(mine.map((r) => r.split_no)).toEqual(['Split 2 of 3']);
    });
  });

  it('leaves a single-agent deal off this report entirely, as it always has', async () => {
    // Which is why "1 of 1" cannot be reached here honestly: the report is team deals, and
    // `is_team` counts the deal's agents — a rule the count change does not touch.
    await inRollback(async (tx) => {
      const { deal, primary, second } = await twoAgentDeal(tx);
      await tx.team_members.deleteMany({ where: { transaction_id: deal.id, user_id: second.id } });

      const rows = (await run(tx, asUser(primary, 'agent'))).filter((r) => r.trade_no === deal.trade_no);
      expect(rows).toEqual([]);
    });
  });
});
