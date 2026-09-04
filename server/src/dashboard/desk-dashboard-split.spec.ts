import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AreaDashboardService } from './area-dashboard.service';
import { PermissionService } from '../auth/permission.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import type { AuthUserRecord } from '../auth/auth.types';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * THE DASHBOARD AND THE TRANSACTIONS LIST COUNT THE SAME DEALS.
 *
 * They did not. The list uses `transactionScopeWhere` — the deals you are the agent on, plus the
 * deals you are split into — and the Dashboard used `transactionOwnerWhere`, which is only the
 * first half. An agent who is a team member on six deals and the named agent on none opened their
 * Transactions screen to six rows and their Dashboard to a total of zero.
 *
 * Every tile was affected, not just the headline: closings, the validation and commission
 * breakdowns and all three document counts are derived from the same `live` predicate.
 *
 * These tests assert the two screens AGREE, rather than asserting a particular number, because the
 * property that matters is the agreement. They also pin the three things that must NOT change while
 * making them agree:
 *
 *   · an unrelated agent still sees nothing — widening the rule must not widen access;
 *   · an unassigned deal is nobody's, however many team rows it carries;
 *   · a namesake cannot reach another agent's deals, because membership is matched by user id.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

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

/*
 * Both services built directly, with no Nest wiring.
 *
 * The collaborators the Transactions list does not use on this path are passed as null: `index()`
 * calls `reviews.countsFor`, which needs only Prisma. Constructing the mailer and the settings
 * service here would make these tests an exercise in dependency wiring rather than a check on who
 * can see which deal — and the whole point of comparing the two screens is that the SCOPE is the
 * thing under test.
 */
const dashboardFor = (tx: PrismaService) => new AreaDashboardService(tx, new PermissionService());
const listFor = (tx: PrismaService) =>
  new TransactionsService(
    tx,
    new CommissionService(new PersonResolver(tx)),
    new TransactionReviewService(tx, new PersonResolver(tx), null as never, null as never, null as never),
    // audit: a stub rather than null - applyExpiry now RECORDS the flip (TD-074), so a
    // fixture sitting past its expiry would call it. A no-op keeps these tests about scope.
    { record: async () => undefined } as never,
  );

const asAgent = (u: { id: number; name: string }): AuthUserRecord =>
  ({ id: u.id, name: u.name, role: 'agent', user_permissions: [] } as unknown as AuthUserRecord);

async function makeAgent(tx: PrismaService, name: string) {
  const stamp = `${Date.now()}-${++seq}`;
  return tx.users.create({
    data: {
      name, email: `split-${stamp}@spec.test`, username: `split-${stamp}`,
      role: 'agent', status: 'Active', password: 'x', profile: '{}',
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, name: true },
  });
}

/** A deal with an optional named agent and an optional list of team members. */
async function makeDeal(
  tx: PrismaService,
  opts: {
    agent?: { id: number; name: string } | null;
    agentName?: string | null;
    members?: { id: number | null; name: string; access?: string }[];
    closingInDays?: number;
    validation?: string;
    docs?: { validation: string; mandatory?: boolean }[];
  },
) {
  const now = new Date();
  const closing = opts.closingInDays === undefined ? null : new Date(Date.now() + opts.closingInDays * 86400000);
  const t = await tx.transactions.create({
    data: {
      trade_no: `SPLIT-${Date.now()}-${++seq}`,
      type: 'Residential Buying',
      agent: opts.agent ? opts.agent.name : (opts.agentName ?? null),
      agent_user_id: opts.agent ? opts.agent.id : null,
      price: 700_000, deposit: 20_000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
      comm_status: 'Pending', comm_paid_status: 'No',
      valid_status: opts.validation ?? 'Pending',
      closing_date: closing,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      created_at: now, updated_at: now,
    },
  });
  let pos = 0;
  for (const m of opts.members ?? []) {
    await tx.team_members.create({
      data: {
        transaction_id: t.id, name: m.name, user_id: m.id,
        split: 50, agent_pct: 90, brok_pct: 10,
        access: m.access ?? 'docs', scope: 'Entire', position: pos++,
        created_at: now, updated_at: now,
      },
    });
  }
  for (const d of opts.docs ?? []) {
    await tx.documents.create({
      data: {
        transaction_id: t.id, title: 'Agreement of Purchase and Sale',
        validation: d.validation, status: 'Pending', mandatory: d.mandatory ?? false,
        position: 0, created_at: now, updated_at: now,
      },
    });
  }
  return t.id;
}

/** The ids the Transactions list shows this user — the reference behaviour. */
async function listedIds(tx: PrismaService, user: AuthUserRecord): Promise<number[]> {
  const res = await listFor(tx).index(user as unknown as ResourceUser, { page: 1, per_page: 200 });
  return (res.data as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
}

describe('the Agent Dashboard counts the deals the Transactions list shows', () => {
  it('a split-only agent sees their team deals on BOTH screens', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Split Owner');
      const member = await makeAgent(tx, 'Split Member');

      const shared = await makeDeal(tx, { agent: owner, members: [{ id: member.id, name: member.name }] });
      const alsoShared = await makeDeal(tx, { agent: owner, members: [{ id: member.id, name: member.name }] });
      await makeDeal(tx, { agent: owner }); // owner only — not the member's

      const ids = await listedIds(tx, asAgent(member));
      expect(ids).toEqual([shared, alsoShared].sort((a, b) => a - b));

      const dash = await dashboardFor(tx).desk(asAgent(member));
      // The property under test: the tile equals the list, not merely "greater than zero".
      expect(dash.transactions.total).toBe(ids.length);
    });
  });

  it('an agent who is BOTH the named agent and a team member counts each deal once', async () => {
    await inRollback(async (tx) => {
      const me = await makeAgent(tx, 'Both Roles');
      // Two team rows naming the same person on one deal — the shape that would double-count if the
      // team clause were a join rather than a semi-join.
      const mine = await makeDeal(tx, {
        agent: me,
        members: [{ id: me.id, name: me.name }, { id: me.id, name: me.name, access: 'full' }],
      });

      expect(await listedIds(tx, asAgent(me))).toEqual([mine]);
      const dash = await dashboardFor(tx).desk(asAgent(me));
      expect(dash.transactions.total).toBe(1);
    });
  });

  it('an unrelated agent still sees nothing — the wider rule did not widen access', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Someone Else');
      const member = await makeAgent(tx, 'Their Partner');
      const stranger = await makeAgent(tx, 'No Relation');
      await makeDeal(tx, { agent: owner, members: [{ id: member.id, name: member.name }] });

      expect(await listedIds(tx, asAgent(stranger))).toEqual([]);
      const dash = await dashboardFor(tx).desk(asAgent(stranger));
      expect(dash.transactions.total).toBe(0);
    });
  });

  it('an UNASSIGNED deal is nobody\'s, however many team rows it carries', async () => {
    await inRollback(async (tx) => {
      const member = await makeAgent(tx, 'Team On Orphan');
      // No agent on the deal at all — brokerage work, administrator-only, even with a team row.
      await makeDeal(tx, { agentName: null, members: [{ id: member.id, name: member.name }] });

      expect(await listedIds(tx, asAgent(member))).toEqual([]);
      const dash = await dashboardFor(tx).desk(asAgent(member));
      expect(dash.transactions.total).toBe(0);
    });
  });

  it('a NAMESAKE cannot reach the other one\'s deals through the team clause', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Deal Owner');
      const first = await makeAgent(tx, 'Akhil');
      const second = await makeAgent(tx, 'Akhil');
      // The team row carries the FIRST Akhil's id and both people's name.
      const theirs = await makeDeal(tx, { agent: owner, members: [{ id: first.id, name: 'Akhil' }] });

      expect(await listedIds(tx, asAgent(first))).toEqual([theirs]);
      expect(await listedIds(tx, asAgent(second))).toEqual([]);

      expect((await dashboardFor(tx).desk(asAgent(first))).transactions.total).toBe(1);
      expect((await dashboardFor(tx).desk(asAgent(second))).transactions.total).toBe(0);
    });
  });

  it('a LEGACY team row with no user id still resolves by name, as it always did', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Legacy Owner');
      const member = await makeAgent(tx, 'Legacy Member');
      const legacy = await makeDeal(tx, { agent: owner, members: [{ id: null, name: 'Legacy Member' }] });

      expect(await listedIds(tx, asAgent(member))).toEqual([legacy]);
      expect((await dashboardFor(tx).desk(asAgent(member))).transactions.total).toBe(1);
    });
  });

  it('the ACCESS LEVEL on the team row does not change what is counted — the list is the reference', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Access Owner');
      const member = await makeAgent(tx, 'Docs Only');
      // `docs` is the narrowest team access. The Transactions list shows these deals, so the
      // Dashboard counts them; narrowing here would make the two screens disagree again in the
      // other direction.
      const a = await makeDeal(tx, { agent: owner, members: [{ id: member.id, name: member.name, access: 'docs' }] });
      const b = await makeDeal(tx, { agent: owner, members: [{ id: member.id, name: member.name, access: 'full' }] });

      expect(await listedIds(tx, asAgent(member))).toEqual([a, b].sort((x, y) => x - y));
      expect((await dashboardFor(tx).desk(asAgent(member))).transactions.total).toBe(2);
    });
  });
});

describe('every Dashboard tile follows the same scope, not only the headline', () => {
  it('closings, validation, commission and document counts all include split deals', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Tile Owner');
      const member = await makeAgent(tx, 'Tile Member');

      // One deal closing next week, Invalid validation, with a mandatory document not yet Valid —
      // so it must appear in the closings tile, the validation breakdown and two document counts.
      await makeDeal(tx, {
        agent: owner,
        members: [{ id: member.id, name: member.name }],
        closingInDays: 7,
        validation: 'Invalid',
        docs: [{ validation: 'Pending', mandatory: true }],
      });

      const dash = await dashboardFor(tx).desk(asAgent(member));
      expect(dash.transactions.total).toBe(1);
      expect(dash.transactions.by_validation.Invalid).toBe(1);
      expect(dash.transactions.by_commission.Pending).toBe(1);
      expect(dash.closings.next_30_days).toBe(1);
      expect(dash.documents.mandatory_missing).toBe(1);
      expect(dash.documents.pending).toBe(1);
    });
  });

  it('a stranger sees zero on every one of those tiles', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Tile Owner 2');
      const member = await makeAgent(tx, 'Tile Member 2');
      const stranger = await makeAgent(tx, 'Tile Stranger');
      await makeDeal(tx, {
        agent: owner, members: [{ id: member.id, name: member.name }],
        closingInDays: 7, validation: 'Invalid', docs: [{ validation: 'Pending', mandatory: true }],
      });

      const dash = await dashboardFor(tx).desk(asAgent(stranger));
      expect(dash.transactions.total).toBe(0);
      expect(dash.closings.next_30_days).toBe(0);
      expect(dash.documents.pending).toBe(0);
      expect(dash.documents.mandatory_missing).toBe(0);
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
