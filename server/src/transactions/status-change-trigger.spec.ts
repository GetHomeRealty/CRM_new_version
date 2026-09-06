import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { NOTIFIABLE_STATUSES, isNotifiableStatus } from '../reference/transaction.constants';

/**
 * TD-009 — the third of the five events the entry names: a deal's status changing.
 *
 * WHAT WAS MISSING. Closing dates and condition deadlines were built as nightly sweeps; deposit-due
 * and commission-received are still blocked on decisions nobody has taken (a deposit carries no due
 * date, and "commission received" could mean the trust deposit, the invoice being paid or the agent
 * being paid). Status change was the one gap with nothing in its way, and QA measured it twice:
 * "nothing fires on a deal's status changing", and "there is no status-change event anywhere in the
 * list".
 *
 * NOT A SWEEP. Every other trigger in this service asks "what is due today" once a night; this one
 * is sent by the save that changed the status, so the agent hears about it when it happens. It goes
 * through `deliver` all the same, which is what gives it the in-app row, the push, the email, the
 * retry ladder and — the part that matters most — one preference switch that turns off all three.
 *
 * Real rows in rolled-back transactions with a pinned day, in the shape
 * `closing-condition-reminders.spec.ts` established for the other two.
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
  const sent: { event: string; vars: Record<string, string>; to: unknown }[] = [];
  return {
    sent,
    mailer: { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx));

/** A Tuesday in mid-June at midday — away from month end, DST and any date boundary. */
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `TD009S Agent ${tag}`, email: `td009s-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.name;
}

async function makeDeal(tx: PrismaService, agent: string | null): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD009S-${Date.now()}-${seq}`, type: 'Residential Buying',
      property: '9 Status Street', agent, created_at: now, updated_at: now,
    },
  });
  return t.id;
}

// ---------------------------------------------------------------------------
// which changes are worth a message
// ---------------------------------------------------------------------------

describe('the statuses a deal’s agent is told about (TD-009)', () => {
  it('announces becoming firm, and every way of ending', () => {
    for (const s of ['Secured Firm', 'Sold', 'Leased', 'Closed', 'DFT', 'Void', 'Mutual Release', 'Terminated', 'Expired']) {
      expect([s, isNotifiableStatus(s)]).toEqual([s, true]);
    }
  });

  it('stays quiet on ordinary progress, which is most saves', () => {
    // Why the whole set is the wrong answer: a deal moves through these as a matter of course, and
    // an administrator correcting a mis-set status would be emailing the agent about a correction.
    for (const s of ['Active', 'Open', 'Secured Conditional', 'Sold Conditional', 'Suspended']) {
      expect([s, isNotifiableStatus(s)]).toEqual([s, false]);
    }
  });

  it('covers a firm/sold milestone for every transaction family, so no family is silent', () => {
    // Leased is the one a hand-written list drops, which would leave lease deals announcing nothing.
    for (const s of ['Secured Firm', 'Sold', 'Leased']) expect(NOTIFIABLE_STATUSES).toContain(s);
  });
});

// ---------------------------------------------------------------------------
// the send
// ---------------------------------------------------------------------------

describe('a deal that becomes firm or ends tells its agent (TD-009)', () => {
  it('sends the status-change event to the deal’s agent, saying what it was and what it is', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();

      await sweepFor(tx, s).statusChanged(id, ['Secured Firm'], 'Priya Raman', ['Open'], anchor());

      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].event).toBe('transaction.status_changed');
      expect(s.sent[0].vars.new_status).toBe('Secured Firm');
      expect(s.sent[0].vars.previous_status).toBe('Open');
      expect(s.sent[0].vars.changed_by).toBe('Priya Raman');
      expect(s.sent[0].vars.property_address).toBe('9 Status Street');
    });
  }, 60000);

  it('leaves an in-app notification too, not only an email', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);

      await sweepFor(tx, stubs()).statusChanged(id, ['Closed'], 'Priya Raman', ['Secured Firm'], anchor());

      const rows = await tx.transaction_reminders.findMany({ where: { transaction_id: id, delivery_method: 'in-app' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('status');
      expect(rows[0].variant).toBe('Closed');
      expect(rows[0].recipient).toBe(agent);
    });
  }, 60000);

  it('does NOT tell an agent about their own change', async () => {
    // A trigger that answers your own click is the quickest way to teach somebody to ignore the
    // ones that matter.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();

      await sweepFor(tx, s).statusChanged(id, ['Sold'], agent, ['Active'], anchor());

      expect(s.sent).toHaveLength(0);
      expect(await tx.transaction_reminders.count({ where: { transaction_id: id } })).toBe(0);
    });
  }, 60000);

  it('sends once for the same status on the same day, however many times it is called', async () => {
    // Setting a deal Sold, undoing it and setting it Sold again is one thing to know about.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();
      const sweep = sweepFor(tx, s);

      await sweep.statusChanged(id, ['Sold'], 'Priya Raman', ['Active'], anchor());
      await sweep.statusChanged(id, ['Sold'], 'Priya Raman', ['Active'], anchor());

      expect(s.sent).toHaveLength(1);
    });
  }, 60000);

  it('names every status one save entered, in a single message', async () => {
    // The rule `conditionDeadlines` already follows: one message per deal per day covering
    // everything, rather than one message per item. A listing taken to Sold and Closed together is
    // one thing to deal with, and two emails about it is how people learn to skim them.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();

      await sweepFor(tx, s).statusChanged(id, ['Sold', 'Closed'], 'Priya Raman', ['Active'], anchor());

      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].vars.new_status).toBe('Sold, Closed');
    });
  }, 60000);

  it('says the morning’s change only, when a second one follows the same day', async () => {
    /*
     * NOT THE BEHAVIOUR ANYONE WOULD CHOOSE, pinned so it is a known cost rather than a surprise.
     *
     * `transaction_reminders` is unique on (transaction_id, kind, scheduled_for, delivery_method)
     * and `variant` is not in that key, so the day's second send is refused by the database. Moving
     * a deal to Sold in the morning and Closed in the afternoon announces Sold alone.
     *
     * The fix, if same-day sequences ever matter, is a migration putting `variant` in the unique
     * key — NOT a second `kind`, which would double every other message the deal sends. This test
     * exists so that decision is made deliberately rather than by somebody finding it in a mailbox.
     */
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();
      const sweep = sweepFor(tx, s);

      await sweep.statusChanged(id, ['Sold'], 'Priya Raman', ['Active'], anchor());
      await sweep.statusChanged(id, ['Closed'], 'Priya Raman', ['Sold'], anchor());

      expect(s.sent.map((x) => x.vars.new_status)).toEqual(['Sold']);
    });
  }, 60000);

  it('sends again the NEXT day, so the key does not silence a deal for good', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();
      const sweep = sweepFor(tx, s);
      const today = anchor();
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);

      await sweep.statusChanged(id, ['Sold'], 'Priya Raman', ['Active'], today);
      await sweep.statusChanged(id, ['Closed'], 'Priya Raman', ['Sold'], tomorrow);

      expect(s.sent.map((x) => x.vars.new_status)).toEqual(['Sold', 'Closed']);
    });
  }, 60000);

  it('says nothing when the deal has no agent to tell', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, null);
      const s = stubs();

      await sweepFor(tx, s).statusChanged(id, ['Closed'], 'Priya Raman', ['Active'], anchor());

      expect(s.sent).toHaveLength(0);
    });
  }, 60000);

  it('says nothing when no notifiable status was entered', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, agent);
      const s = stubs();

      await sweepFor(tx, s).statusChanged(id, [], 'Priya Raman', ['Active'], anchor());

      expect(s.sent).toHaveLength(0);
    });
  }, 60000);
});
