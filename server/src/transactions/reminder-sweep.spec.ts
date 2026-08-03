import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * The nightly sweep against the real schema, inside transactions that are rolled back.
 *
 * The schedule arithmetic is proved on its own in reminder-schedule.spec.ts. What is tested here is
 * everything that touches the database and could be quietly wrong: the duplicate protection, the
 * status guard on auto-expiry, and the content following the CURRENT missing details rather than
 * what was missing when the run-up started.
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

const stubs = () => {
  const sent: { event: string; to: unknown }[] = [];
  return {
    sent,
    mailer: { send: async (event: string, _v: unknown, to: unknown) => { sent.push({ event, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx));

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const midnight = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * The "today" these tests reason from — fixed, not the wall clock.
 *
 * WHY IT IS PINNED. Every assertion here is a day countdown: a listing five days out must produce
 * `days_remaining` of 5 and then 4. Deriving that from `new Date()` makes the expected values a
 * function of when the suite happens to run, which is how
 * `chases again the next day — a new occurrence, a new reminder` came to fail intermittently and
 * then stop, with no change to `src/transactions/` between the two.
 *
 * The trigger was never identified — a midnight boundary, DST and a timezone-dependent write of the
 * `@db.Date` column were each tested and ruled out. What is certain is that a countdown asserted
 * against a moving clock cannot be relied on, whatever the trigger turns out to be. Pinning removes
 * the whole class: month ends, DST changes, the date rolling over mid-run, and a CI box in another
 * zone all stop mattering.
 *
 * Chosen deliberately: a Tuesday in mid-June, far from any month end and from both DST transitions,
 * at midday so nothing here is ever within hours of a date boundary. `sweep()` takes the date as a
 * parameter, so nothing about the product is being faked — only the question the test asks.
 */
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

/** An agent with an address, so the email path actually runs. */
async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `Sweep Agent ${tag}`, email: `sweep-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now },
  });
  return u.name;
}

async function makeTxn(tx: PrismaService, over: Record<string, unknown>, statuses: string[]): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `SW-${Date.now()}-${seq}`, type: 'Residential Sale Listing', property: '1 Test Road',
      company_id: 1, created_at: now, updated_at: now, ...over,
    },
  });
  for (const status of statuses) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  }
  return t.id;
}

describe('listing expiry reminders', () => {
  it('chases an Active listing nine days out, on both channels', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 9) }, ['Active']);

      const result = await sweepFor(tx, s).sweep(today);
      expect(result.expiryReminders).toBe(1);
      expect(s.sent.map((m) => m.event)).toEqual(['transaction.listing_expiry_reminder']);

      const rows = await tx.transaction_reminders.findMany({ where: { transaction_id: txnId } });
      expect(rows.map((r) => r.delivery_method).sort()).toEqual(['email', 'in-app']);
      expect(rows.every((r) => r.delivery_status === 'Sent')).toBe(true);
      expect(rows[0].days_remaining).toBe(9);
    });
  });

  it('sends nothing twice on the same day, however often the sweep runs', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 5) }, ['Active']);
      const sweep = sweepFor(tx, s);

      expect((await sweep.sweep(today)).expiryReminders).toBe(1);
      expect((await sweep.sweep(today)).expiryReminders).toBe(0);
      expect((await sweep.sweep(today)).expiryReminders).toBe(0);

      expect(s.sent).toHaveLength(1);
      expect(await tx.transaction_reminders.count({ where: { transaction_id: txnId } })).toBe(2);
    });
  });

  it('chases again the next day — a new occurrence, a new reminder', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 5) }, ['Active']);
      const sweep = sweepFor(tx, s);

      await sweep.sweep(today);
      await sweep.sweep(day(today, 1));
      expect(s.sent).toHaveLength(2);

      const rows = await tx.transaction_reminders.findMany({ where: { transaction_id: txnId, delivery_method: 'in-app' }, orderBy: { id: 'asc' } });
      expect(rows.map((r) => r.days_remaining)).toEqual([5, 4]);
    });
  });

  it('leaves a listing that is not Active alone', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      await makeTxn(tx, { agent, listing_expiry_date: day(today, 5) }, ['Sold']);

      expect((await sweepFor(tx, s).sweep(today)).expiryReminders).toBe(0);
      expect(s.sent).toHaveLength(0);
    });
  });
});

describe('automatic expiry', () => {
  it('moves an Active listing to Expired once the date has passed, and audits it', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const txnId = await makeTxn(tx, { agent: 'Nobody', listing_expiry_date: day(today, -1) }, ['Active']);

      expect((await sweepFor(tx, s).sweep(today)).expired).toBe(1);
      const statuses = await tx.transaction_statuses.findMany({ where: { transaction_id: txnId } });
      expect(statuses.map((x) => x.status)).toEqual(['Expired']);

      const audit = await tx.audit_logs.findFirst({ where: { transaction_id: txnId, action: 'Listing automatically expired' } });
      expect(audit?.old_value).toBe('Active');
      expect(audit?.new_value).toBe('Expired');
      expect(audit?.who).toBe('System');
      expect(audit?.details).toContain('automatically changed from Active to Expired');
    });
  });

  it('never overwrites a status somebody else set', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const sweep = sweepFor(tx, s);

      for (const status of ['Sold', 'Leased', 'Closed', 'Suspended', 'Terminated', 'Mutual Release', 'Void', 'DFT']) {
        const txnId = await makeTxn(tx, { agent: 'Nobody', listing_expiry_date: day(today, -3) }, [status]);
        await sweep.sweep(today);
        const after = await tx.transaction_statuses.findMany({ where: { transaction_id: txnId } });
        expect(after.map((x) => x.status)).toEqual([status]);
      }
    });
  });

  it('leaves a listing alone on its expiry day — it is live until the day is over', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const txnId = await makeTxn(tx, { agent: 'Nobody', listing_expiry_date: midnight(today) }, ['Active']);

      expect((await sweepFor(tx, s).sweep(today)).expired).toBe(0);
      const after = await tx.transaction_statuses.findMany({ where: { transaction_id: txnId } });
      expect(after.map((x) => x.status)).toEqual(['Active']);
    });
  });
});

describe('lawyer-detail reminders', () => {
  /** A Monday inside the last phase, so a reminder is always due on the test's "today". */
  const mondayNear = (): { today: Date; closing: Date } => {
    const base = anchor();
    const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    while (today.getDay() !== 1) today.setDate(today.getDate() + 1);
    return { today, closing: day(today, 5) };
  };

  const dealFor = async (tx: PrismaService, agent: string, closing: Date, lawyers: Record<string, unknown>) =>
    makeTxn(tx, { agent, type: 'Residential Buying', closing_date: closing, ...lawyers }, ['Open']);

  /**
   * What was sent for ONE deal.
   *
   * The sweep reads every transaction in the database, and a development database holds real ones,
   * so a global counter says nothing about the row under test. The reminder rows do.
   */
  const variantsFor = async (tx: PrismaService, txnId: number): Promise<(string | null)[]> => {
    const rows = await tx.transaction_reminders.findMany({
      where: { transaction_id: txnId, kind: 'lawyer', delivery_method: 'in-app' },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.variant);
  };

  it('asks for both when both are missing', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await dealFor(tx, agent, closing, {});

      await sweepFor(tx, s).sweep(today);
      expect(await variantsFor(tx, txnId)).toEqual(['both']);
      expect(s.sent.some((m) => m.event === 'transaction.lawyer_both_reminder')).toBe(true);
    });
  });

  it('asks only for the seller once the buyer has been filled in', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await dealFor(tx, agent, closing, { buyer_lawyer_name: 'Ada Lawyer' });

      await sweepFor(tx, s).sweep(today);
      expect(await variantsFor(tx, txnId)).toEqual(['seller']);
    });
  });

  it('asks only for the buyer once the seller has been filled in', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await dealFor(tx, agent, closing, { seller_lawyer_name: 'Grace Lawyer' });

      await sweepFor(tx, s).sweep(today);
      expect(await variantsFor(tx, txnId)).toEqual(['buyer']);
    });
  });

  it('stops the moment both are present', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await dealFor(tx, agent, closing, { buyer_lawyer_name: 'Ada', seller_lawyer_name: 'Grace' });

      await sweepFor(tx, s).sweep(today);
      expect(await variantsFor(tx, txnId)).toEqual([]);
    });
  });

  it('follows the details as they change between one reminder and the next', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await dealFor(tx, agent, closing, {});
      const sweep = sweepFor(tx, s);

      await sweep.sweep(today);                       // Monday: both missing
      await tx.transactions.update({ where: { id: txnId }, data: { buyer_lawyer_name: 'Ada Lawyer' } });
      await sweep.sweep(day(today, 2));               // Wednesday: only the seller now
      await tx.transactions.update({ where: { id: txnId }, data: { seller_lawyer_name: 'Grace Lawyer' } });
      await sweep.sweep(day(today, 4));               // Friday: nothing left to ask for

      expect(await variantsFor(tx, txnId)).toEqual(['both', 'seller']);
    });
  });

  it('ignores a listing, which has no lawyers to chase', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const { today, closing } = mondayNear();
      const txnId = await makeTxn(tx, { agent, type: 'Residential Sale Listing', closing_date: closing }, ['Active']);

      await sweepFor(tx, s).sweep(today);
      expect(await variantsFor(tx, txnId)).toEqual([]);
    });
  });
});

describe('history and the bell', () => {
  it('records what was sent, and clears the bell when the deal is opened', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 3) }, ['Active']);
      const sweep = sweepFor(tx, s);
      await sweep.sweep(today);

      const bell = await sweep.notifications(agent);
      expect(bell.count).toBe(1);
      expect(String(bell.items[0].summary)).toContain('expire in 3 days');

      await sweep.markSeen(agent, txnId);
      expect((await sweep.notifications(agent)).count).toBe(0);

      const history = await sweep.history(txnId) as { data: Record<string, unknown>[]; meta: { total: number } };
      expect(history.meta.total).toBe(2);
      expect(history.data.every((r) => r.delivery_status === 'Sent')).toBe(true);
    });
  });

  it('records a failure instead of losing it, and does not retry the same occurrence', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      s.mailer.send = async () => { throw new Error('smtp down'); };
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 4) }, ['Active']);
      const sweep = sweepFor(tx, s);

      const result = await sweep.sweep(today);
      expect(result.failed).toBe(1);

      const email = await tx.transaction_reminders.findFirst({ where: { transaction_id: txnId, delivery_method: 'email' } });
      expect(email?.delivery_status).toBe('Failed');
      expect(email?.detail).toContain('smtp down');
      // A failure nobody can classify is treated as permanent, so it is recorded and left alone
      // rather than asked again every hour — see reminder-retry.spec.ts for the transient case.
      expect(email?.detail).toContain('not retried');
      expect(email?.next_retry_at).toBeNull();

      // The occurrence itself is claimed either way: today is done.
      expect((await sweep.sweep(today)).failed).toBe(0);
    });
  });

  it('says so when the agent has no address, rather than failing silently', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const txnId = await makeTxn(tx, { agent: 'Nobody On File', listing_expiry_date: day(today, 6) }, ['Active']);

      await sweepFor(tx, s).sweep(today);
      const email = await tx.transaction_reminders.findFirst({ where: { transaction_id: txnId, delivery_method: 'email' } });
      expect(email?.delivery_status).toBe('Skipped');
      expect(email?.detail).toContain('No email address on file');
      expect(s.sent).toHaveLength(0);
    });
  });
});

describe('when a date moves', () => {
  it('records the recalculation and releases today’s claim', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const agent = await makeAgent(tx);
      const today = anchor();
      const txnId = await makeTxn(tx, { agent, listing_expiry_date: day(today, 20) }, ['Active']);
      const sweep = sweepFor(tx, s);

      // Nothing yet: twenty days out is outside the window.
      expect((await sweep.sweep(today)).expiryReminders).toBe(0);

      const moved = day(today, 4);
      await tx.transactions.update({ where: { id: txnId }, data: { listing_expiry_date: moved } });
      await sweep.dateChanged(txnId, 'listing_expiry_date', day(today, 20), moved);

      const audit = await tx.audit_logs.findFirst({ where: { transaction_id: txnId, action: 'Reminder schedule recalculated' } });
      expect(audit).toBeTruthy();

      // The new date is inside the window, so it is chased today rather than tomorrow.
      expect((await sweep.sweep(today)).expiryReminders).toBe(1);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
