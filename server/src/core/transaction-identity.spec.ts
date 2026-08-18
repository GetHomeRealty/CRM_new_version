/*
 * `archiver` ships as ESM and this project's ts-jest transform does not process node_modules, so
 * importing `ExportJobService` — which reaches it through `BulkExportService` → `common/archive` —
 * fails to load. The ZIP writer is not what is under test here (the exporter is a spy), so the
 * module is stubbed. `jest.mock` is hoisted above the imports below.
 */
jest.mock('../common/archive', () => ({ createZip: () => ({}) }));

import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from './resource-access.service';
import { AgentsService } from '../agents/agents.service';
import { ExportJobService } from '../reports/export-job.service';
import type { BulkExportService } from '../reports/bulk-export.service';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  ownsTransaction,
  teamMemberIdentity,
  transactionScopeWhere,
} from '../common/transaction-scope';

/**
 * Identity is a user id, not a name.
 *
 * THE CASE THIS IS ABOUT. Two active accounts in this brokerage are called the same thing — that is
 * the measured fact `PersonResolver`, `transactions.agent_user_id` and `team_members.user_id` were
 * added for. Authorization went on comparing `transactions.agent` to `user.name`, so those two
 * people could read and edit each other's deals, and renaming somebody moved their access without
 * anybody touching a permission.
 *
 * Every test below creates TWO USERS WITH THE SAME NAME and asserts that the one who owns the deal
 * gets in and the other does not. The legacy path — a row whose `agent_user_id` was never resolved —
 * is asserted too, because keeping those working is what makes this safe to deploy: the name
 * fallback must survive for rows that have no id, and must NOT apply to rows that have one.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** Two agents who share a name, and a deal that belongs to the first of them by id. */
async function namesakes(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const name = `Sam Taylor ${n}`;
  const mine = await tx.users.create({
    data: { name, email: `sam-a-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
  });
  const theirs = await tx.users.create({
    data: { name, email: `sam-b-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
  });
  const txn = await tx.transactions.create({
    data: {
      agent: name, agent_user_id: mine.id,
      trade_no: 'ID' + Date.now() + n, type: 'Residential Buying', created_at: now, updated_at: now,
    },
  });
  return { name, mine, theirs, txn };
}

const asUser = (u: { id: number; name: string }) => ({ id: u.id, name: u.name, role: 'agent' });

describe('a deal belongs to a person, not to a name', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('lets the owner in and keeps their namesake out', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs, txn } = await namesakes(tx);
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(mine), txn.id)).resolves.toBeUndefined();
      // Same name, same role, different person — and this is the assertion that failed before.
      await expect(access.assertTransaction(asUser(theirs), txn.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it('shows the deal in the owner\'s list and not in their namesake\'s', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs, txn } = await namesakes(tx);
      const visible = async (u: { id: number; name: string }) =>
        (await tx.transactions.findMany({
          where: { AND: [{ deleted_at: null }, transactionScopeWhere(asUser(u))] },
          select: { id: true },
        })).map((r) => r.id);

      expect(await visible(mine)).toContain(txn.id);
      expect(await visible(theirs)).not.toContain(txn.id);
    });
  });

  it('keeps the name fallback for rows that never resolved to an account', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const n = ++seq;
      const user = await tx.users.create({
        data: { name: `Legacy Agent ${n}`, email: `leg-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
      });
      // A deal written before `agent_user_id` existed: the name is all there is.
      const legacy = await tx.transactions.create({
        data: { agent: user.name, agent_user_id: null, trade_no: 'LG' + Date.now() + n, type: 'Residential Buying', created_at: now, updated_at: now },
      });
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(user), legacy.id)).resolves.toBeUndefined();

      const ids = (await tx.transactions.findMany({
        where: { AND: [{ deleted_at: null }, transactionScopeWhere(asUser(user))] },
        select: { id: true },
      })).map((r) => r.id);
      expect(ids).toContain(legacy.id);
    });
  });

  it('does not let a namesake claim a row that already has an id', async () => {
    await inRollback(async (tx) => {
      const { mine, theirs, txn } = await namesakes(tx);
      // The row carries an id, so the name must not be consulted at all.
      expect(ownsTransaction(asUser(mine), txn)).toBe(true);
      expect(ownsTransaction(asUser(theirs), txn)).toBe(false);
    });
  });

  it('decides team membership by id too', async () => {
    await inRollback(async (tx) => {
      const { name, mine, theirs } = await namesakes(tx);
      const now = new Date();
      // A different agent's deal, with one of the two namesakes split into it BY ID.
      const owner = await tx.users.create({
        data: { name: `Owner ${++seq}`, email: `own-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
      });
      const deal = await tx.transactions.create({
        data: { agent: owner.name, agent_user_id: owner.id, trade_no: 'TM' + Date.now() + seq, type: 'Residential Buying', created_at: now, updated_at: now },
      });
      await tx.team_members.create({ data: { transaction_id: deal.id, name, user_id: theirs.id } });

      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(theirs), deal.id)).resolves.toBeUndefined();
      // `mine` shares the split row's NAME and is not on the deal.
      await expect(access.assertTransaction(asUser(mine), deal.id)).rejects.toThrow(ForbiddenException);

      const rowsFor = async (u: { id: number; name: string }) =>
        tx.team_members.count({ where: { transaction_id: deal.id, ...teamMemberIdentity(asUser(u)) } });
      expect(await rowsFor(theirs)).toBe(1);
      expect(await rowsFor(mine)).toBe(0);
    });
  });

  it('gives a principal with neither id nor name nothing, rather than everything', async () => {
    await inRollback(async (tx) => {
      await namesakes(tx);
      const ids = await tx.transactions.findMany({
        where: { AND: [{ deleted_at: null }, transactionScopeWhere({ id: undefined, name: '', role: 'agent' })] },
        select: { id: true },
      });
      expect(ids).toHaveLength(0);
    });
  });

  it('leaves everyone above agent unscoped', async () => {
    await inRollback(async (tx) => {
      await namesakes(tx);
      for (const role of ['admin', 'manager', 'accounting', 'documentation']) {
        expect(transactionScopeWhere({ id: 1, name: 'Somebody', role })).toEqual({});
      }
    });
  });
});

describe('agent reference data is not a brokerage-wide financial disclosure', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** Two agents, each with a commission split and a loan on their profile. */
  async function withProfiles(tx: PrismaService) {
    const now = new Date();
    const n = ++seq;
    const profile = (pct: number, loan: number) =>
      JSON.stringify({ agent_comm_pct: pct, lease_comm_pct: pct, has_loan: 1, loan_amount: loan });
    const a = await tx.users.create({
      data: { name: `Ref A ${n}`, email: `ra-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', profile: profile(90, 5000), created_at: now, updated_at: now },
    });
    const b = await tx.users.create({
      data: { name: `Ref B ${n}`, email: `rb-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', profile: profile(85, 9000), created_at: now, updated_at: now },
    });
    return { a, b, agents: new AgentsService(tx) };
  }

  it('gives an agent their own split and loan, and nobody else\'s', async () => {
    await inRollback(async (tx) => {
      const { a, b, agents } = await withProfiles(tx);
      const viewer = asUser(a);

      const commissions = await agents.commissions(viewer);
      expect(Object.keys(commissions)).toEqual([a.name]);
      expect(commissions[a.name].agent_pct).toBe(90);

      const loans = await agents.loans(viewer);
      expect(Object.keys(loans)).toEqual([a.name]);
      expect(loans[b.name]).toBeUndefined();

      const emails = await agents.emails(viewer);
      expect(Object.keys(emails)).toEqual([a.name]);
    });
  });

  it('still gives the office the whole map', async () => {
    await inRollback(async (tx) => {
      const { a, b, agents } = await withProfiles(tx);
      const office = { id: 1, name: 'An Admin', role: 'admin' };
      const commissions = await agents.commissions(office);
      expect(commissions[a.name]).toBeDefined();
      expect(commissions[b.name]).toBeDefined();
      const loans = await agents.loans(office);
      expect(loans[a.name]).toBeDefined();
      expect(loans[b.name]).toBeDefined();
    });
  });
});

describe('a queued export runs as the person who asked for it', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /**
   * Records the principal the exporter is handed, then stops.
   *
   * It throws rather than returning a buffer on purpose: the job would otherwise write a real file
   * into `storage/exports`, which the rollback around each test cannot undo. What is under test is
   * WHO the exporter was called as, and that is already captured by the time it throws.
   */
  function spyBulk(): { calls: AuthUserRecord[]; service: BulkExportService } {
    const calls: AuthUserRecord[] = [];
    const record = (user: AuthUserRecord): never => { calls.push(user); throw new Error('stopped after recording the caller'); };
    const service = {
      resolve: async (_sel: unknown, user: AuthUserRecord) => record(user),
      completeXlsx: async (_sel: unknown, user: AuthUserRecord) => record(user),
    } as unknown as BulkExportService;
    return { calls, service };
  }

  async function queuedJobFor(tx: PrismaService, user: { id: number; name: string }) {
    const now = new Date();
    return tx.export_jobs.create({
      data: {
        export_id: 'EXP-TEST-' + Date.now() + ++seq,
        token: 'tok' + Date.now() + seq,
        action_type: 'transaction-complete-xlsx',
        format: 'XLSX',
        status: 'Queued',
        transaction_count: 1,
        selection: JSON.stringify({ transaction_ids: [], all_matching: true, filters: {} }),
        requested_by: user.name,
        requested_by_id: user.id,
        requested_at: now,
        expires_at: new Date(now.getTime() + 3600_000),
        created_at: now,
        updated_at: now,
      },
    });
  }

  it('hands the exporter the requester\'s real role — not admin', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const agent = await tx.users.create({
        data: { name: `Queue Agent ${++seq}`, email: `qa-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
      });
      const job = await queuedJobFor(tx, agent);
      const { calls, service } = spyBulk();

      await new ExportJobService(tx, service).run(job.id);

      /*
       * The whole fix, in one assertion. This was `role: 'admin'`, hard-coded, so
       * `BulkExportService.resolve` skipped agent scoping and the file came back containing the
       * brokerage's deals — for an agent who pressed "Download All Transactions".
       */
      expect(calls.length).toBeGreaterThan(0);
      for (const seen of calls) {
        expect(seen.role).toBe('agent');
        expect(seen.id).toBe(agent.id);
      }
    });
  });

  it('carries the permission and module rows a live request would have', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const agent = await tx.users.create({
        data: { name: `Queue Perms ${++seq}`, email: `qp-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
      });
      await tx.user_permissions.create({ data: { user_id: agent.id, screen: 'transactions', level: 'view', created_at: now, updated_at: now } });
      await tx.user_modules.create({ data: { user_id: agent.id, module_name: 'desk', status: 'active', created_at: now, updated_at: now } });
      const job = await queuedJobFor(tx, agent);
      const { calls, service } = spyBulk();

      await new ExportJobService(tx, service).run(job.id);

      expect(calls[0].user_permissions).toEqual([expect.objectContaining({ screen: 'transactions', level: 'view' })]);
      expect(calls[0].user_modules).toEqual([expect.objectContaining({ module_name: 'desk', status: 'active' })]);
    });
  });

  it('refuses to run a job whose requester has been deactivated', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const gone = await tx.users.create({
        data: { name: `Gone ${++seq}`, email: `gone-${Date.now()}-${seq}@x.test`, password: 'x', role: 'agent', status: 'Inactive', created_at: now, updated_at: now },
      });
      const job = await queuedJobFor(tx, gone);
      const { calls, service } = spyBulk();

      await new ExportJobService(tx, service).run(job.id);

      // Nothing was generated, and the job says why rather than falling back to some other identity.
      expect(calls).toHaveLength(0);
      const after = await tx.export_jobs.findUnique({ where: { id: job.id } });
      expect(after?.status).toBe('Failed');
      expect(after?.failure_reason).toMatch(/no longer exists/i);
    });
  });
});
