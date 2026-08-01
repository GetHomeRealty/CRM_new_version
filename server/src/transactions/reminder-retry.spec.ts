import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { isTransient } from '../email/mailer.service';

/**
 * Automatic retry for failed reminder deliveries.
 *
 * Two things have to be true and are easy to get wrong: a transient failure must come back, and a
 * permanent one must NOT — a rejected address asked again every hour is how a sender gets
 * blocklisted, and it buries the real failures in the history.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** A failure of the kind a mail server produces when it is briefly unwell, and one that is final. */
const transient = (): Error => Object.assign(new Error('Connection timed out'), { responseCode: 451 });
const permanent = (): Error => Object.assign(new Error('550 no such recipient'), { responseCode: 550 });

const stubs = (fail?: () => Error) => {
  const sent: string[] = [];
  return {
    sent,
    mailer: { send: async (event: string) => { if (fail) throw fail(); sent.push(event); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, s.mailer as never, s.settings as never, new AuditService(tx));

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `Retry Agent ${tag}`, email: `retry-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now },
  });
  return u.name;
}

async function makeListing(tx: PrismaService, agent: string, expiry: Date): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `RT-${Date.now()}-${seq}`, type: 'Residential Sale Listing', property: '1 Retry Road', agent, listing_expiry_date: expiry, company_id: 1, created_at: now, updated_at: now },
  });
  await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Active', created_at: now, updated_at: now } });
  return t.id;
}

const emailRow = (tx: PrismaService, txnId: number) =>
  tx.transaction_reminders.findFirst({ where: { transaction_id: txnId, delivery_method: 'email' } });

/** Bring a scheduled retry forward so the next sweep picks it up. */
const makeDue = async (tx: PrismaService, txnId: number): Promise<boolean> => {
  const row = await emailRow(tx, txnId);
  if (!row?.next_retry_at) return false;
  await tx.transaction_reminders.update({ where: { id: row.id }, data: { next_retry_at: new Date(Date.now() - 1000) } });
  return true;
};

describe('classifying a delivery failure', () => {
  it('treats 4xx, timeouts and dropped connections as worth retrying', () => {
    expect(isTransient({ responseCode: 421 })).toBe(true);
    expect(isTransient({ responseCode: 451 })).toBe(true);
    expect(isTransient({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransient({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransient({ message: 'Greylisted, please try again later' })).toBe(true);
  });

  it('treats a rejection as final, and anything unrecognised too', () => {
    expect(isTransient({ responseCode: 550 })).toBe(false);
    expect(isTransient({ responseCode: 535, message: 'Bad credentials' })).toBe(false);
    expect(isTransient(new Error('something nobody has seen before'))).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('retrying a failed reminder', () => {
  it('schedules another attempt after a transient failure', async () => {
    await inRollback(async (tx) => {
      const s = stubs(transient);
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));

      await sweepFor(tx, s).sweep(today);
      const row = await emailRow(tx, txnId);
      expect(row?.delivery_status).toBe('Failed');
      expect(row?.attempts).toBe(1);
      expect(row?.next_retry_at).toBeTruthy();
      expect(row?.detail).toContain('trying again later');
    });
  });

  it('does not schedule anything after a permanent rejection', async () => {
    await inRollback(async (tx) => {
      const s = stubs(permanent);
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));

      await sweepFor(tx, s).sweep(today);
      const row = await emailRow(tx, txnId);
      expect(row?.delivery_status).toBe('Failed');
      expect(row?.next_retry_at).toBeNull();
      expect(row?.detail).toContain('not retried');
    });
  });

  it('sends it on the next pass, and records which attempt got through', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));
      await sweepFor(tx, stubs(transient)).sweep(today);
      expect(await makeDue(tx, txnId)).toBe(true);

      const working = stubs();
      await sweepFor(tx, working).sweep(today);

      const after = await emailRow(tx, txnId);
      expect(after?.delivery_status).toBe('Sent');
      expect(after?.attempts).toBe(2);
      expect(after?.next_retry_at).toBeNull();
      expect(after?.detail).toContain('attempt 2');
    });
  });

  it('gives up after the fourth attempt rather than asking for ever', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));
      const sweep = sweepFor(tx, stubs(transient));
      await sweep.sweep(today);

      for (let i = 0; i < 6; i++) {
        if (!(await makeDue(tx, txnId))) break;
        await sweep.sweep(today);
      }

      const final = await emailRow(tx, txnId);
      expect(final?.attempts).toBe(4);
      expect(final?.next_retry_at).toBeNull();
      expect(final?.delivery_status).toBe('Failed');
    });
  });

  it('rebuilds the message rather than replaying it — a stale countdown is worse than none', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));
      await sweepFor(tx, stubs(transient)).sweep(today);
      await makeDue(tx, txnId);

      // Two days on, the listing is two days closer, and the retry has to say so.
      await sweepFor(tx, stubs()).sweep(day(today, 2));
      expect((await emailRow(tx, txnId))?.subject).toContain('expire in 4 days');
    });
  });

  it('stops chasing when the reason has gone away', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));
      await sweepFor(tx, stubs(transient)).sweep(today);

      // The listing sold before the retry came round.
      await tx.transaction_statuses.updateMany({ where: { transaction_id: txnId }, data: { status: 'Sold' } });
      await makeDue(tx, txnId);

      const working = stubs();
      await sweepFor(tx, working).sweep(today);
      const after = await emailRow(tx, txnId);
      expect(after?.delivery_status).toBe('Skipped');
      expect(after?.detail).toContain('No longer applicable');
      expect(working.sent).toHaveLength(0);
    });
  });

  it('leaves a retry that is not yet due alone', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const today = new Date();
      const txnId = await makeListing(tx, agent, day(today, 6));
      await sweepFor(tx, stubs(transient)).sweep(today);

      // The first backoff is an hour out, so this pass must not touch it.
      await sweepFor(tx, stubs()).sweep(today);
      expect((await emailRow(tx, txnId))?.attempts).toBe(1);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
