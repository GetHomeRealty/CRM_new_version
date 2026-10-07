import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { QuickSendService } from './quick-send.service';

/*
 * THE DEPOSIT RECEIPT IS THE ADMIN TEAM'S DOCUMENT - 2026-10-07.
 *
 * The brokerage's rule (23 September, confirmed 3 October): the Notice of Sale, the Trade Record
 * Sheet and the Deposit Receipt are prepared by the admin team and raised to the agent for signing.
 * The first two were refused to the agent role on the server on 23 September; the Deposit Receipt
 * was left with only its hidden button, so an agent calling the address could still mail a receipt
 * - trade number, property and deposit - to any address. Proved on 2026-10-05 and again 2026-10-07.
 *
 * Real rows in a rolled-back transaction, the pattern the other quick-action specs use.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (t) => { await fn(t as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 20000 });
  } catch (e) {
    if (String((e as Error).message).includes(ROLLBACK) === false) throw e;
  }
}

async function scene(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const agent = await tx.users.create({ data: { name: `DR Agent ${n}`, email: `dr-agent-${Date.now()}-${n}@x.test`, password: 'x', role: 'agent', status: 'Active', created_at: now, updated_at: now } });
  const deal = await tx.transactions.create({ data: {
    agent: agent.name, agent_user_id: agent.id, trade_no: `DRSO-${Date.now()}-${n}`,
    type: 'Residential Sale Listing', property: '1 Staff Only St', deposit: 50000, created_at: now, updated_at: now,
  } });
  const sent: { to: unknown }[] = [];
  const svc = new QuickSendService(
    tx,
    { record: async () => undefined, log: async () => undefined } as never,
    { send: async (_t: unknown, _v: unknown, to: unknown) => { sent.push({ to }); } } as never,
    { current: async () => ({ name: 'Test Brokerage' }) } as never,
    new ResourceAccessService(tx),
  );
  return { agent, deal, sent, svc };
}

const attempt = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; } catch (e) { return e; }
};

describe('the Deposit Receipt is sent by brokerage staff only', () => {
  it('refuses the agent on their OWN listing, and sends nothing', async () => {
    await inRollback(async (tx) => {
      const { agent, deal, sent, svc } = await scene(tx);
      const err = await attempt(() => svc.depositReceipt({ id: agent.id, name: agent.name, role: 'agent' } as never, deal.id, { email: 'anyone@example.test', cc: 'other@example.test' }));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(((err as ForbiddenException).getResponse() as { message: string }).message).toBe('Only brokerage staff can send the Deposit Receipt.');
      expect(sent).toEqual([]);
    });
  });

  it('refuses the agent BEFORE looking at the deal, so the answer says nothing about it', async () => {
    await inRollback(async (tx) => {
      const { agent, svc } = await scene(tx);
      const err = await attempt(() => svc.depositReceipt({ id: agent.id, name: agent.name, role: 'agent' } as never, 2_000_000_000, { email: 'a@b.test' }));
      expect(err).toBeInstanceOf(ForbiddenException);
    });
  });

  it.each(['admin', 'manager', 'accounting', 'documentation'])('still lets %s send it, exactly as before', async (role) => {
    await inRollback(async (tx) => {
      const { deal, sent, svc } = await scene(tx);
      const res = await svc.depositReceipt({ id: 1, name: `A ${role}`, role } as never, deal.id, { email: 'client@example.test' });
      expect(res).toMatchObject({ ok: true, email: 'client@example.test' });
      expect(sent).toHaveLength(1);
    });
  });

  it('leaves the agent the Cc look-up on their own deal, which sends nothing', async () => {
    await inRollback(async (tx) => {
      const { agent, deal, sent, svc } = await scene(tx);
      const cc = await svc.ccSuggestions({ id: agent.id, name: agent.name, role: 'agent' } as never, deal.id);
      expect(Array.isArray(cc)).toBe(true);
      expect(sent).toEqual([]);
    });
  });
});
