import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DEPOSIT_GRACE_DAYS, depositReminderFor } from './reminder-schedule';

/**
 * TD-009 — the last two of the five events the entry names.
 *
 * BOTH WERE BLOCKED ON A QUESTION, not on missing code, and both questions are answered here rather
 * than worked around:
 *
 *   DEPOSIT DUE — "a deposit has no due date recorded against it". True, and it rules out a
 *   countdown, not a watch. A deal carries the deposit AMOUNT it expects and its admin activities
 *   carry the receipt, so the question asked is whether the money ARRIVED, not whether it is late
 *   against a date nobody entered. Chased once, five days after the offer date.
 *
 *   COMMISSION RECEIVED — could mean the trust deposit, the invoice being paid, or the agent being
 *   paid. This fires on the INVOICE, the only one of the three the system timestamps itself when
 *   `recordPayment` settles an invoice. The other two are typed into the Admin panel by hand; a
 *   trigger on them would announce somebody's data entry and fire again on every correction.
 *
 * Real rows in rolled-back transactions with a pinned day, in the shape
 * `closing-condition-reminders.spec.ts` established for the first two sweeps.
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

const stubs = () => {
  const sent: { event: string; vars: Record<string, string> }[] = [];
  return {
    sent,
    mailer: { send: async (event: string, vars: Record<string, string>) => { sent.push({ event, vars }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx));

/** A Tuesday in mid-June at midday — away from month end, DST and any date boundary. */
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);
const dayBefore = (d: Date, n: number): Date => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - n));

async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `TD009M Agent ${tag}`, email: `td009m-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.name;
}

async function makeDeal(tx: PrismaService, over: Record<string, unknown>, statuses: string[] = ['Secured Firm']): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD009M-${Date.now()}-${seq}`, type: 'Residential Buying', property: '4 Deposit Lane',
      created_at: now, updated_at: now, ...over,
    },
  });
  for (const status of statuses) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  }
  return t.id;
}

// ---------------------------------------------------------------------------
// the schedule, on its own
// ---------------------------------------------------------------------------

describe('when an unrecorded deposit is chased (TD-009)', () => {
  const today = anchor();
  const offerDaysAgo = (n: number): Date => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);

  it('chases on the day the grace period ends', () => {
    expect(depositReminderFor(today, offerDaysAgo(DEPOSIT_GRACE_DAYS)).due).toBe(true);
  });

  it('says nothing before then', () => {
    for (let n = 0; n < DEPOSIT_GRACE_DAYS; n++) {
      expect([n, depositReminderFor(today, offerDaysAgo(n)).due]).toEqual([n, false]);
    }
  });

  it('does not keep chasing afterwards', () => {
    // A deposit is one thing to go and ask about. Repeating it nightly until somebody types a date
    // is how a reminder becomes something people filter.
    for (const n of [DEPOSIT_GRACE_DAYS + 1, DEPOSIT_GRACE_DAYS + 10]) {
      expect([n, depositReminderFor(today, offerDaysAgo(n)).due]).toEqual([n, false]);
    }
  });
});

// ---------------------------------------------------------------------------
// the deposit sweep
// ---------------------------------------------------------------------------

describe('a deal whose deposit has not been recorded (TD-009)', () => {
  const offerDate = (): Date => dayBefore(anchor(), DEPOSIT_GRACE_DAYS);

  it('chases the agent, naming the amount the deal expects', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, deposit: 25_000, offer_date: offerDate(), admin_activities: '{}' });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      const sent = s.sent.filter((x) => x.event === 'transaction.deposit_outstanding');
      expect(sent).toHaveLength(1);
      expect(sent[0].vars.days_outstanding).toBe(String(DEPOSIT_GRACE_DAYS));
      expect(sent[0].vars.deposit_amount).toContain('25000');
    });
  }, 60000);

  it('says nothing once a deposit has been recorded', async () => {
    // The receipt lives in the admin activities JSON, and a row counts once it carries a DATE.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await makeDeal(tx, {
        agent, deposit: 25_000, offer_date: offerDate(),
        admin_activities: JSON.stringify({ deposits: [{ date: '2026-06-12', received_via: 'Wire' }] }),
      });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.deposit_outstanding')).toHaveLength(0);
    });
  }, 60000);

  it('is not fooled by the blank row the panel adds when it is opened', async () => {
    // Counting ROWS would report every deal somebody has ever looked at as settled — the same trap
    // the Adjustment panel documents.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await makeDeal(tx, {
        agent, deposit: 25_000, offer_date: offerDate(),
        admin_activities: JSON.stringify({ deposits: [{ date: '', received_via: '' }] }),
      });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.deposit_outstanding')).toHaveLength(1);
    });
  }, 60000);

  it('says nothing about a deal expecting no deposit', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, deposit: 0, offer_date: offerDate(), admin_activities: '{}' });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.deposit_outstanding')).toHaveLength(0);
    });
  }, 60000);

  it('says nothing about a deal that has already ended', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, deposit: 25_000, offer_date: offerDate(), admin_activities: '{}' }, ['Closed']);
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.deposit_outstanding')).toHaveLength(0);
    });
  }, 60000);
});

// ---------------------------------------------------------------------------
// the commission sweep
// ---------------------------------------------------------------------------

describe('a commission the brokerage has received (TD-009)', () => {
  const makeInvoice = async (tx: PrismaService, txnId: number, over: Record<string, unknown>) => {
    seq += 1;
    const now = new Date();
    await tx.invoices.create({
      data: {
        transaction_id: txnId, invoice_no: `ZZ-C-${Date.now()}-${seq}`, status: 'Paid', total: 8_500,
        invoice_date: new Date('2026-06-01T00:00:00.000Z'), created_at: now, updated_at: now, ...over,
      },
    });
  };

  it('tells the agent the night the commission date is recorded', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent });
      await makeInvoice(tx, id, {
        commission_received_date: dayBefore(anchor(), 0), commission_received_via: 'Wire',
      });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      const sent = s.sent.filter((x) => x.event === 'transaction.commission_received');
      expect(sent).toHaveLength(1);
      expect(sent[0].vars.received_via).toBe('Wire');
      expect(sent[0].vars.amount_received).toContain('8500');
    });
  }, 60000);

  it('does not announce a date back-filled to an earlier day', async () => {
    // Back-filling is bookkeeping. Announcing it would tell an agent money arrived today when it
    // did not — which is the kind of wrong this report keeps recording.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent });
      await makeInvoice(tx, id, { commission_received_date: dayBefore(anchor(), 30), commission_received_via: 'Cheque' });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.commission_received')).toHaveLength(0);
    });
  }, 60000);

  it('says nothing about an invoice that is not settled', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent });
      await makeInvoice(tx, id, { status: 'Unpaid', commission_received_date: dayBefore(anchor(), 0) });
      const s = stubs();

      await sweepFor(tx, s).sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.commission_received')).toHaveLength(0);
    });
  }, 60000);

  it('sends once however many times the sweep runs that night', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent });
      await makeInvoice(tx, id, { commission_received_date: dayBefore(anchor(), 0), commission_received_via: 'Wire' });
      const s = stubs();
      const sweep = sweepFor(tx, s);

      await sweep.sweep(anchor());
      await sweep.sweep(anchor());

      expect(s.sent.filter((x) => x.event === 'transaction.commission_received')).toHaveLength(1);
    });
  }, 60000);
});
