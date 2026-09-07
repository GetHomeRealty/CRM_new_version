import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReportDataService } from './report-data.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * TD-054 — 'docs only' means documents, not money, on every surface.
 *
 * THE ENTRY WAS REOPENED BECAUSE THE FIX COVERED ONE SURFACE OF THREE. The transaction detail
 * response was genuinely fixed and is not in question. What was not: the agent's own Export Data
 * file, which carried twenty-one money columns including the other agent's commission and the
 * brokerage's share, and the Brokerage Split Ratio Commission Report, which repeated the exact
 * figures the entry names — both reachable from the restricted seat.
 *
 * "A restriction that holds on the deal page and fails in the export and the report is arguably
 * worse than one that fails everywhere, because it looks fixed."
 *
 * SO THE RULE IS APPLIED WHERE THE DATA IS ASSEMBLED, which is what the entry asks for. Every
 * report and the bulk export read their rows from `ReportDataService.load`, so one pass covers all
 * of them — and covers a report added tomorrow, which is the property that stops this recurring.
 *
 * Real rows in rolled-back transactions. This is a data-exposure defect: a stubbed loader would
 * prove the code path runs, not that the money is gone.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const dataFor = (tx: PrismaService): ReportDataService =>
  new ReportDataService(tx, new CommissionService(new PersonResolver(tx)));

/** A deal worked by `owner`, with `mate` added to the team at the given access level. */
async function deal(tx: PrismaService, owner: { id: number; name: string }, mate: { id: number; name: string }, access: string) {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD054-${Date.now()}-${seq}`, type: 'Residential Buying', property: '7 Split Street',
      agent: owner.name, agent_user_id: owner.id,
      price: 445_654, deposit: 20_000,
      comm_type: '%', comm_value: 2, comm_pct: 2,
      offer_date: new Date('2026-04-01T00:00:00.000Z'),
      created_at: now, updated_at: now,
    },
  });
  await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Secured Firm', created_at: now, updated_at: now } });
  await tx.team_members.create({
    data: { transaction_id: t.id, name: owner.name, user_id: owner.id, is_primary: true, access: 'full', split: 60, agent_pct: 90, brok_pct: 10, position: 0, created_at: now, updated_at: now },
  });
  await tx.team_members.create({
    data: { transaction_id: t.id, name: mate.name, user_id: mate.id, is_primary: false, access, split: 40, agent_pct: 90, brok_pct: 10, position: 1, created_at: now, updated_at: now },
  });
  return t.id;
}

async function makeUser(tx: PrismaService, tag: string): Promise<{ id: number; name: string }> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `TD054 ${tag} ${stamp}`, email: `td054-${tag}-${stamp}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return { id: u.id, name: u.name };
}

/** What the reports and the export both read: the enriched row, as this caller would receive it. */
const loadAs = async (tx: PrismaService, who: { id: number; name: string }, id: number) => {
  const rows = await dataFor(tx).load({ lockedAgent: who.name, lockedUserId: who.id });
  return rows.find((r) => r.id === id);
};

describe('a docs-only team member is served no money (TD-054)', () => {
  it('still sees the deal — documents access means the deal is theirs to see', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const row = await loadAs(tx, mate, id);

      expect(row).toBeDefined();
      expect(row?.property).toBe('7 Split Street');
    });
  }, 60000);

  it('carries none of the figures the entry names', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const row = await loadAs(tx, mate, id);

      // The three numbers the reopening quotes off the Brokerage Split Ratio report.
      expect(row?.total.total).toBe(0);
      expect(row?.total.commission).toBe(0);
      expect(row?.brokerageComm.total).toBe(0);
      expect(row?.agentComm.total).toBe(0);
      // And the rates, because leaving them beside the price puts the totals a multiplication away.
      expect(row?.comm_value).toBe(0);
      expect(row?.comm_display).toBe('');
      // The split matrix — 'Team 1 Aswini / Deal Share 60 / Agent 90 / Brokerage 10'.
      expect(row?.splits).toEqual([]);
      expect(row?.split_ratios).toEqual([]);
    });
  }, 60000);

  it('withholds the payment trail as well as the commission', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const row = await loadAs(tx, mate, id);

      expect(row?.agent_payment_status).toBe('');
      expect(row?.agent_balance).toBe(0);
      expect(row?.agent_paid).toBe(0);
      expect(row?.advance).toBe(0);
      expect(row?.adjustments_total).toBe(0);
      expect(row?.referral).toBeNull();
    });
  }, 60000);

  it('keeps the identifying details, which the entry asks to stay visible', async () => {
    // "'Docs only' access should expose the documents and the identifying details of the deal."
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const row = await loadAs(tx, mate, id);

      expect(row?.trade_no).toBeTruthy();
      expect(row?.statuses).toContain('Secured Firm');
    });
  }, 60000);
});

describe('the rule does not reach past the people it is for (TD-054)', () => {
  it('leaves a FULL team member their figures', async () => {
    // The restriction is the access level, not team membership. A full member is on the deal
    // properly and reads it properly.
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'full');
      const id = await deal(tx, owner, mate, 'full');

      const row = await loadAs(tx, mate, id);

      expect(row?.total.total).toBeGreaterThan(0);
      expect(row?.comm_value).toBe(2);
    });
  }, 60000);

  it('leaves the deal’s own agent their figures', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const row = await loadAs(tx, owner, id);

      expect(row?.total.total).toBeGreaterThan(0);
    });
  }, 60000);

  it('leaves an administrator reading everything', async () => {
    // An unlocked scope is an administrator's read, and is not restricted by anyone's team row.
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner');
      const mate = await makeUser(tx, 'docs');
      const id = await deal(tx, owner, mate, 'docs');

      const rows = await dataFor(tx).load({});
      const row = rows.find((r) => r.id === id);

      expect(row?.total.total).toBeGreaterThan(0);
    });
  }, 60000);
});
