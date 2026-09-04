import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DashboardService } from './dashboard.service';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * TD-047 — the commission tiles count COMMISSION LINES for the office, and DEALS for an agent.
 *
 * The defect was read as arithmetic: "Upcoming Commissions" said 7 open deals on a screen whose
 * Total Deals tile said 6. The aggregation was right and the caption was wrong — each agent's share
 * of a deal is its own commission line, and a card showing the SUM of those lines has to count the
 * same things it added up. A deal with three team members contributes three.
 *
 * That distinction was invisible in the payload, so the screen had to guess at it. It no longer
 * does: `count_basis` is derived from the query the service actually ran. These tests pin the two
 * bases against fixtures whose line count deliberately differs from their deal count — the exact
 * shape QA measured (14 deals, 21 lines) in miniature.
 *
 * OFFICE FIGURES ARE MEASURED AS A DELTA, because an administrator's scope is the whole brokerage
 * and the development database is not empty. The agent's are absolute: a freshly-named agent has
 * no other deals, which is what makes "one row per visible deal" assertable at all.
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
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const serviceFor = (tx: PrismaService) =>
  new DashboardService(tx, new CommissionService(new PersonResolver(tx)), new PersonResolver(tx));
const asUser = (name: string, role: string): ResourceUser => ({ id: 90_000 + seq, name, role } as unknown as ResourceUser);

/** An OPEN deal (no Closed status), with an explicit team split so the money needs no profile. */
async function openDeal(tx: PrismaService, agent: string, members: string[]) {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD047-${Date.now()}-${++seq}`, type: 'Sale', agent,
      price: 500_000, comm_type: 'percentage', comm_value: 2.5, comm_pct: 2.5,
      adjustments: '{}', admin_activities: '{}', created_at: now, updated_at: now,
    },
  });
  await tx.transaction_statuses.create({
    data: { transaction_id: t.id, status: 'Active', created_at: now, updated_at: now },
  });
  const split = Math.floor(100 / members.length);
  for (const name of members) {
    await tx.team_members.create({
      data: {
        transaction_id: t.id, name, split, agent_pct: 90, brok_pct: 10, scope: 'Entire',
        created_at: now, updated_at: now,
      },
    });
  }
  return t;
}

describe('the dashboard says what its commission counts are counting (TD-047)', () => {
  it('counts one line per TEAM MEMBER for the office — two deals, four lines', async () => {
    await inRollback(async (tx) => {
      const svc = serviceFor(tx);
      const office = asUser('An Admin', 'admin');
      const before = await svc.commissions(office);

      // Two open deals carrying four agent lines between them: the shape that made the tile and
      // the Total Deals tile look like they disagreed.
      const stamp = `TD047-${Date.now()}`;
      await openDeal(tx, `${stamp}-A`, [`${stamp}-A`, `${stamp}-B`, `${stamp}-C`]);
      await openDeal(tx, `${stamp}-D`, [`${stamp}-D`]);

      const after = await svc.commissions(office);

      expect(after.count_basis).toBe('commission_lines');
      // Four, not two. Changing this to two would leave `upcoming_total` — the sum of four lines —
      // describing a different set from the number printed beside it.
      expect(after.t4a.upcoming_count - before.t4a.upcoming_count).toBe(4);
    });
  });

  it('counts one row per VISIBLE DEAL for an agent, even on a three-member deal', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const name = `TD047Agent-${Date.now()}-${++seq}`;
      await tx.users.create({
        data: {
          name, username: name, email: `${name}@x.test`, password: 'x', role: 'agent',
          status: 'Active', profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now,
        },
      });

      // Two deals they are on — one shared with two colleagues, one their own.
      await openDeal(tx, name, [name, `${name}-mate1`, `${name}-mate2`]);
      await openDeal(tx, name, [name]);

      const mine = await serviceFor(tx).commissions(asUser(name, 'agent'));

      expect(mine.count_basis).toBe('deals');
      // Their own line on each deal — the colleagues' lines are not theirs to count.
      expect(mine.t4a.upcoming_count).toBe(2);
    });
  });

  it('reports the same basis from the enrichment path as from the SQL path', async () => {
    // The two implementations are kept in parity on every other figure; the basis has to travel
    // with them, or a fallback to the slow path would relabel the tiles.
    await inRollback(async (tx) => {
      const svc = serviceFor(tx);
      const office = asUser('An Admin', 'admin');
      const agent = asUser(`TD047Parity-${Date.now()}`, 'agent');

      expect((await svc.commissionsInNode(office)).count_basis).toBe('commission_lines');
      expect((await svc.commissions(office)).count_basis).toBe('commission_lines');
      expect((await svc.commissionsInNode(agent)).count_basis).toBe('deals');
      expect((await svc.commissions(agent)).count_basis).toBe('deals');
    });
  });
});
