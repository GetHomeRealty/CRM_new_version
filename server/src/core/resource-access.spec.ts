import { PrismaClient } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from './resource-access.service';
import { MessagesService } from '../transactions/messages.service';

/**
 * Ownership, the authorization question tenant isolation cannot answer.
 *
 * The tenant filter stops one brokerage reading another's rows. It says nothing about one agent
 * reading a colleague's, because both belong to the same company and the filter is satisfied.
 *
 * The chat thread is here by name because it was genuinely open: `GET /api/transactions/:id/messages`
 * returned the whole conversation to any signed-in agent, including ones with no part in the deal.
 * It was found by signing in as a real agent and asking the running application — every other route
 * hanging off a transaction refused them, and this one did not, because nothing in it ever asked.
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

/** Two agents and a deal belonging to the first. */
async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const owner = await tx.users.create({
    data: { name: `Owner ${n}`, email: `own-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', company_id: 1, created_at: now, updated_at: now },
  });
  const other = await tx.users.create({
    data: { name: `Other ${n}`, email: `oth-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', company_id: 1, created_at: now, updated_at: now },
  });
  const admin = { id: 999000 + n, name: 'An Admin', role: 'admin' };
  const txn = await tx.transactions.create({
    data: { agent: owner.name, trade_no: 'T' + n, type: 'Residential Buying', company_id: 1, created_at: now, updated_at: now },
  });
  return { owner, other, admin, txn };
}

const asUser = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role });

describe('an agent reaches their own work and nobody else\'s', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('lets the agent named on the deal in', async () => {
    await inRollback(async (tx) => {
      const { owner, txn } = await scene(tx);
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(owner), txn.id)).resolves.toBeUndefined();
    });
  });

  it('keeps another agent out', async () => {
    await inRollback(async (tx) => {
      const { other, txn } = await scene(tx);
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(other), txn.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it('lets an agent split into the deal in', async () => {
    await inRollback(async (tx) => {
      const { other, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: other.name, company_id: 1 } });
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(other), txn.id)).resolves.toBeUndefined();
    });
  });

  it('treats an unassigned deal as nobody\'s', async () => {
    await inRollback(async (tx) => {
      const { owner, other } = await scene(tx);
      const now = new Date();
      const orphan = await tx.transactions.create({ data: { agent: null, trade_no: 'O' + Date.now(), type: 'Residential Buying', company_id: 1, created_at: now, updated_at: now } });
      // A team row on an unassigned deal grants nothing — there is no agent to be part of.
      await tx.team_members.create({ data: { transaction_id: orphan.id, name: other.name, company_id: 1 } });
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(asUser(owner), orphan.id)).rejects.toThrow(ForbiddenException);
      await expect(access.assertTransaction(asUser(other), orphan.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it('does not restrict anyone above agent', async () => {
    await inRollback(async (tx) => {
      const { admin, txn } = await scene(tx);
      const access = new ResourceAccessService(tx);
      await expect(access.assertTransaction(admin, txn.id)).resolves.toBeUndefined();
      await expect(access.assertTransaction({ id: 1, name: 'A Manager', role: 'manager' }, txn.id)).resolves.toBeUndefined();
    });
  });

  it('answers "does this deal exist?" the same way for everyone', async () => {
    await inRollback(async (tx) => {
      const { owner, admin } = await scene(tx);
      const access = new ResourceAccessService(tx);
      // 404 for both. If a stranger got 403 and a colleague got 404, the status code itself would
      // tell an attacker which ids are real.
      await expect(access.assertTransaction(asUser(owner), 2_000_000_001)).rejects.toThrow(NotFoundException);
      await expect(access.assertTransaction(admin, 2_000_000_001)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('the chat thread is not readable by someone with no part in the deal', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('refuses to list it', async () => {
    await inRollback(async (tx) => {
      const { owner, other, txn } = await scene(tx);
      await tx.transaction_messages.create({
        data: { transaction_id: txn.id, company_id: 1, body: 'commission dispute', created_at: new Date(), updated_at: new Date() },
      });
      const messages = new MessagesService(tx, new ResourceAccessService(tx));

      // The owner reads it; the stranger does not — and this is the assertion that was failing
      // against the running application before the check existed.
      await expect(messages.list(txn.id, asUser(owner))).resolves.toHaveLength(1);
      await expect(messages.list(txn.id, asUser(other))).rejects.toThrow(ForbiddenException);
    });
  });

  it('refuses to write into it', async () => {
    await inRollback(async (tx) => {
      const { other, txn } = await scene(tx);
      const messages = new MessagesService(tx, new ResourceAccessService(tx));
      await expect(messages.post(txn.id, asUser(other), 'let me in')).rejects.toThrow(ForbiddenException);
      // And nothing was written on the way to being refused.
      expect(await tx.transaction_messages.count({ where: { transaction_id: txn.id } })).toBe(0);
    });
  });

  it('still lets the people on the deal talk', async () => {
    await inRollback(async (tx) => {
      const { owner, other, txn } = await scene(tx);
      await tx.team_members.create({ data: { transaction_id: txn.id, name: other.name, company_id: 1 } });
      const messages = new MessagesService(tx, new ResourceAccessService(tx));
      await expect(messages.post(txn.id, asUser(owner), 'hello')).resolves.toHaveLength(1);
      await expect(messages.post(txn.id, asUser(other), 'hello back')).resolves.toHaveLength(2);
    });
  });
});
