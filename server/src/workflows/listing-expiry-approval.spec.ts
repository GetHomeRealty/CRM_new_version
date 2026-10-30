import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EditRequestsService, LISTING_EXPIRY_SCOPE } from './edit-requests.service';
import { mayDecide } from './team-review';
import { AuditService } from '../audit/audit.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * AN AGENT'S NEW LISTING EXPIRY DATE WAITS FOR APPROVAL (Sai, 30 Oct 2026): "b, documentation team
 * approves or super admin should approve it". The agent types the new date (no reason needed); it
 * changes only when Documentation or a Super Admin approves, through the ordinary save.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;
afterAll(async () => { await prisma.$disconnect(); });

const joinable = (tx: unknown): PrismaService => new Proxy(tx as Record<string, unknown>, {
  get(t, prop, r) {
    if (prop === '$transaction') return (fn: (c: unknown) => Promise<unknown>) => fn(t);
    return Reflect.get(t, prop, r);
  },
}) as unknown as PrismaService;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(joinable(tx)); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

function recorders() {
  const applied: { user: AuthUserRecord; txnId: number; body: Record<string, unknown> }[] = [];
  const told: { userId: number; title: string }[] = [];
  const writes = {
    update: async (user: AuthUserRecord, txnId: number, body: Record<string, unknown>) => { applied.push({ user, txnId, body }); return {}; },
  } as unknown as TransactionsWriteService;
  const dispatcher = {
    dispatch: async (r: { userId: number; title: string }) => { told.push(r); return {}; },
    dispatchMany: async (ids: number[], r: { title: string }) => { for (const id of ids) told.push({ userId: id, title: r.title }); return []; },
  } as unknown as NotificationDispatcher;
  return { applied, told, writes, dispatcher };
}

const svc = (tx: PrismaService, r: ReturnType<typeof recorders>) => new EditRequestsService(tx, new AuditService(tx), r.dispatcher, r.writes);
const as = (u: { id: number; name: string }, role: string) => ({ ...u, role, user_permissions: [] } as unknown as AuthUserRecord);

async function user(tx: PrismaService, role: string) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `ZZ LXA ${role} ${t}`, email: `zz-lxa-${role}-${t}@probe.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
    select: { id: true, name: true },
  });
}

async function listing(tx: PrismaService, agent: { id: number; name: string }, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  const row = await tx.transactions.create({
    data: {
      trade_no: `ZL${t}`.slice(0, 20), type: 'Residential Sale Listing', property: `ZZ Expiry Road ${t}`,
      agent: agent.name, agent_user_id: agent.id, listing_expiry_date: new Date('2026-11-03'),
      created_at: now, updated_at: now, ...over,
    } as never,
    select: { id: true },
  });
  await tx.transaction_statuses.create({ data: { transaction_id: row.id, status: 'Active', created_at: now, updated_at: now } });
  return row.id;
}

describe('an agent asks for a new listing expiry date', () => {
  jest.setTimeout(60_000);

  it('the agent on the listing asks without a reason; the date does not change; Documentation and Super Admins are told', async () => {
    await inRollback(async (tx) => {
      const r = recorders();
      const agent = await user(tx, 'agent');
      const handler = await user(tx, 'documentation');
      const id = await listing(tx, agent, { doc_handler_id: handler.id });
      const req = await svc(tx, r).store(as(agent, 'agent'), id, null, LISTING_EXPIRY_SCOPE, { listing_expiry_date: '2027-02-03' }) as { status?: string; data?: { status: string } };
      expect(JSON.stringify(req)).toContain('pending');
      const row = await tx.transactions.findUniqueOrThrow({ where: { id }, select: { listing_expiry_date: true } });
      expect(row.listing_expiry_date?.toISOString().slice(0, 10)).toBe('2026-11-03');
      expect(r.told.some((x) => x.userId === handler.id)).toBe(true);
    });
  });

  it('refuses another agent, and a deal that is not a listing', async () => {
    await inRollback(async (tx) => {
      const r = recorders();
      const agent = await user(tx, 'agent');
      const other = await user(tx, 'agent');
      const id = await listing(tx, agent);
      await expect(svc(tx, r).store(as(other, 'agent'), id, null, LISTING_EXPIRY_SCOPE, { listing_expiry_date: '2027-02-03' }))
        .rejects.toBeInstanceOf(ForbiddenException);
      const buying = await listing(tx, agent, { type: 'Residential Buying' });
      await expect(svc(tx, r).store(as(agent, 'agent'), buying, null, LISTING_EXPIRY_SCOPE, { listing_expiry_date: '2027-02-03' }))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('a Documentation member approves it and the new date is applied through the ordinary save', async () => {
    await inRollback(async (tx) => {
      const r = recorders();
      const agent = await user(tx, 'agent');
      const docs = await user(tx, 'documentation');
      const id = await listing(tx, agent);
      await svc(tx, r).store(as(agent, 'agent'), id, null, LISTING_EXPIRY_SCOPE, { listing_expiry_date: '2027-02-03' });
      const pending = await tx.transaction_edit_requests.findFirstOrThrow({ where: { transaction_id: id, scope: LISTING_EXPIRY_SCOPE } });
      await svc(tx, r).approve(as(docs, 'documentation'), pending.id);
      expect(r.applied).toHaveLength(1);
      expect(r.applied[0].body).toMatchObject({ listing_expiry_date: '2027-02-03' });
      expect((await tx.transaction_edit_requests.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('approved');
    });
  });

  it('only Documentation or a Super Admin may decide it - not another agent, not Accounting, not the agent themself', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx, 'agent');
      const docs = await user(tx, 'documentation');
      const acct = await user(tx, 'accounting');
      const admin = await user(tx, 'admin');
      expect(await mayDecide(tx as never, as(docs, 'documentation') as never, agent.id, LISTING_EXPIRY_SCOPE)).toBe(true);
      expect(await mayDecide(tx as never, as(admin, 'admin') as never, agent.id, LISTING_EXPIRY_SCOPE)).toBe(true);
      expect(await mayDecide(tx as never, as(acct, 'accounting') as never, agent.id, LISTING_EXPIRY_SCOPE)).toBe(false);
      expect(await mayDecide(tx as never, as(agent, 'agent') as never, agent.id, LISTING_EXPIRY_SCOPE)).toBe(false);
      // and Documentation's new power is for this one scope only
      expect(await mayDecide(tx as never, as(docs, 'documentation') as never, agent.id, 'closing_date')).toBe(false);
    });
  });
});

describe('the agent can no longer change it directly', () => {
  it('listing_expiry_date is among the fields an agent\'s save drops', () => {
    const src = readFileSync(join(__dirname, '..', 'transactions', 'transactions-write.service.ts'), 'utf8');
    const block = src.slice(src.indexOf('const AGENT_LOCKED = ['), src.indexOf('];', src.indexOf('const AGENT_LOCKED = [')));
    expect(block).toContain("'listing_expiry_date'");
  });
});
