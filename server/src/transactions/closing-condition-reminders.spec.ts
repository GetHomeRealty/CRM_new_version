import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import {
  CLOSING_WINDOW_DAYS, CONDITION_WINDOW_DAYS, closingReminderFor, conditionReminderFor, deadlinePhrase,
} from './reminder-schedule';

/**
 * TD-009 — the two dates on a deal that nothing was watching.
 *
 * WHAT THE ENTRY ASKED FOR. "Key lifecycle events (closing approaching, deposit due, condition
 * expiring, status changed, commission received) should raise notifications." The brokerage chose
 * the two that are driven by dates the system already keeps and can be trusted to chase: the run-up
 * to a CLOSING DATE and a CONDITION DEADLINE. The money events wait on rules that do not exist yet
 * — there is no deposit-due date column, and "commission received" could mean the trust deposit,
 * the invoice, or the agent being paid.
 *
 * WHAT WAS THERE BEFORE. Two kinds of reminder: listing expiry, and chasing an agent for lawyer
 * details. The closing date was read ONLY to decide how hard to chase for a lawyer, so a deal with
 * both lawyers on file — the well-run one — went silent all the way to closing. A condition deadline
 * raised nothing at all, though it is the shortest fuse on the deal: a financing condition that
 * lapses unsatisfied can cost the buyer their deposit.
 *
 * BUILT ON THE MACHINERY THAT ALREADY WORKS rather than beside it: the same nightly sweep, the same
 * claim-then-send that makes a second run harmless, the same delivery history, the same retry, and
 * a preference switch of its own so anybody who does not want these can turn them off without
 * touching the ones they do.
 *
 * Real rows in rolled-back transactions, and a pinned "today" — every assertion here is a day
 * countdown, and a countdown asserted against the wall clock is how the older sweep spec came to
 * fail intermittently.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

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
  const sent: { event: string; vars: Record<string, string>; to: unknown }[] = [];
  return {
    sent,
    mailer: { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx));

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** A Tuesday in mid-June, at midday: far from a month end, from DST, and from any date boundary. */
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

async function makeAgent(tx: PrismaService): Promise<string> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `TD009 Agent ${tag}`, email: `td009-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.name;
}

async function makeDeal(tx: PrismaService, over: Record<string, unknown>, statuses: string[]): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `TD009-${Date.now()}-${seq}`, type: 'Residential Buying', property: '1 Closing Road',
      created_at: now, updated_at: now, ...over,
    },
  });
  for (const status of statuses) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  }
  return t.id;
}

async function addCondition(tx: PrismaService, txnId: number, over: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await tx.conditions.create({
    data: { transaction_id: txnId, type: 'Financing', status: 'Pending', position: 0, created_at: now, updated_at: now, ...over },
  });
}

// ---------------------------------------------------------------------------
// the schedules, on their own
// ---------------------------------------------------------------------------

describe('when each of the two new reminders is due (TD-009)', () => {
  const today = anchor();

  it('chases a closing from ten days out', () => {
    expect(closingReminderFor(today, day(today, CLOSING_WINDOW_DAYS)).due).toBe(true);
    expect(closingReminderFor(today, day(today, CLOSING_WINDOW_DAYS + 1)).due).toBe(false);
  });

  it('includes the closing day itself, unlike the expiry countdown', () => {
    // The expiry countdown stops at one day out because the auto-expiry pass acts on the day. This
    // one acts on nothing, so the morning of a closing is exactly when somebody wants telling.
    expect(closingReminderFor(today, today).due).toBe(true);
    expect(closingReminderFor(today, day(today, -1)).due).toBe(false); // and not afterwards
  });

  it('chases a condition from a week out, deadline day included', () => {
    expect(conditionReminderFor(today, day(today, CONDITION_WINDOW_DAYS)).due).toBe(true);
    expect(conditionReminderFor(today, day(today, CONDITION_WINDOW_DAYS + 1)).due).toBe(false);
    expect(conditionReminderFor(today, today)).toEqual({ due: true, daysRemaining: 0 });
    expect(conditionReminderFor(today, day(today, -1)).due).toBe(false);
  });

  it('says "due today" and "due tomorrow" at the sharp end', () => {
    expect(deadlinePhrase(0)).toBe('due today');
    expect(deadlinePhrase(1)).toBe('due tomorrow');
    expect(deadlinePhrase(5)).toBe('due in 5 days');
  });
});

// ---------------------------------------------------------------------------
// closing dates
// ---------------------------------------------------------------------------

describe('the closing-date reminder (TD-009)', () => {
  jest.setTimeout(180_000);

  it('tells the agent, on both channels, with the days remaining', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent, closing_date: day(today, 6) }, ['Secured Firm']);

      const result = await sweepFor(tx, s).sweep(today);

      expect(result.closingReminders).toBe(1);
      const mail = s.sent.find((m) => m.event === 'transaction.closing_reminder');
      expect(mail).toBeDefined();
      expect(mail!.vars.days_remaining).toBe('6');
      expect(mail!.vars.closing_phrase).toBe('closing in 6 days');

      const rows = await tx.transaction_reminders.findMany({ where: { transaction_id: id, kind: 'closing' } });
      expect(rows.map((r) => r.delivery_method).sort()).toEqual(['email', 'in-app']);
      expect(rows.every((r) => r.delivery_status === 'Sent')).toBe(true);
    });
  });

  it('sends nothing twice, however often the sweep runs that day', async () => {
    // The claim on the in-app row is the lock; nothing here keeps its own bookkeeping.
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, closing_date: day(today, 3) }, ['Secured Firm']);

      await sweepFor(tx, s).sweep(today);
      const second = await sweepFor(tx, s).sweep(today);

      expect(second.closingReminders).toBe(0);
      expect(s.sent.filter((m) => m.event === 'transaction.closing_reminder')).toHaveLength(1);
    });
  });

  it('says nothing about a deal that has already ended', async () => {
    // A closed deal reaching its closing date is not news, and chasing it reads as a fault.
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, closing_date: day(today, 2) }, ['Closed']);

      const result = await sweepFor(tx, s).sweep(today);
      expect(result.closingReminders).toBe(0);
      expect(s.sent.filter((m) => m.event === 'transaction.closing_reminder')).toHaveLength(0);
    });
  });

  it('starts once the deal is inside the window and not before', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      await makeDeal(tx, { agent, closing_date: day(today, CLOSING_WINDOW_DAYS + 1) }, ['Secured Firm']);

      expect((await sweepFor(tx, s).sweep(today)).closingReminders).toBe(0);
      // A day later the same deal is ten days out, and is chased.
      expect((await sweepFor(tx, s).sweep(day(today, 1))).closingReminders).toBe(1);
    });
  });

  it('is a separate message from the lawyer chase on the same deal', async () => {
    /*
     * The two overlap by design: one is about the date, the other about a missing detail, and a deal
     * that is closing in a week with no lawyer on file genuinely has two problems. What matters is
     * that they are two records, so switching one off does not silence the other.
     */
    await inRollback(async (tx) => {
      const s = stubs();
      // A MONDAY. The lawyer chase is anchored to weekdays rather than to a count of days - inside
      // a week of closing it goes out on Monday, Wednesday and Friday - so the overlap this test is
      // about only exists on those days. Asking about it on the Tuesday the other tests use would
      // prove the opposite of what it looks like it proves.
      const today = day(anchor(), 6);
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent, closing_date: day(today, 7), type: 'Residential Buying' }, ['Secured Firm']);

      await sweepFor(tx, s).sweep(today);

      const kinds = (await tx.transaction_reminders.findMany({ where: { transaction_id: id }, select: { kind: true } }))
        .map((r) => r.kind);
      expect(new Set(kinds)).toEqual(new Set(['closing', 'lawyer']));
    });
  });
});

// ---------------------------------------------------------------------------
// condition deadlines
// ---------------------------------------------------------------------------

describe('the condition-deadline reminder (TD-009)', () => {
  jest.setTimeout(180_000);

  it('names the condition and when it is due', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent, closing_date: day(today, 60) }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 2) });

      const result = await sweepFor(tx, s).sweep(today);

      expect(result.conditionReminders).toBe(1);
      const mail = s.sent.find((m) => m.event === 'transaction.condition_deadline_reminder');
      expect(mail!.vars.condition_list).toBe('Financing');
      expect(mail!.vars.condition_count).toBe('1');
      expect(mail!.vars.deadline_phrase).toBe('due in 2 days');
    });
  });

  it('uses the condition\'s own name where it has one', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Other', custom_name: 'Status Certificate Review', deadline: day(today, 1) });

      await sweepFor(tx, s).sweep(today);
      const mail = s.sent.find((m) => m.event === 'transaction.condition_deadline_reminder');
      expect(mail!.vars.condition_list).toBe('Status Certificate Review');
      expect(mail!.vars.deadline_phrase).toBe('due tomorrow');
    });
  });

  it('is ONE message for a deal with several conditions due, not one each', async () => {
    /*
     * The reminder table is keyed by (deal, kind, day, channel), so this is what the schema already
     * allows — and it is the right answer anyway: a deal whose financing and inspection fall on the
     * same day is one thing to deal with, and three emails about it is how people learn to skim.
     */
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 4) });
      await addCondition(tx, id, { type: 'Inspection', deadline: day(today, 2), position: 1 });

      const result = await sweepFor(tx, s).sweep(today);

      expect(result.conditionReminders).toBe(1);
      const mail = s.sent.find((m) => m.event === 'transaction.condition_deadline_reminder');
      expect(mail!.vars.condition_count).toBe('2');
      // Soonest first, not the order they sit in the panel: the list is read as a countdown.
      expect(mail!.vars.condition_list).toBe('Inspection, Financing');
      // The soonest one sets the urgency: a deal is as urgent as its nearest deadline.
      expect(mail!.vars.days_remaining).toBe('2');
    });
  });

  it('leaves alone a condition that is already satisfied, however it was worded', async () => {
    // 'Fulfilled', 'Satisfied' and 'Completed' all appear in this column after years of typing and
    // importing. Chasing somebody over work their own reports show as done is the same defect.
    for (const status of ['Fulfilled', 'Satisfied', 'completed', 'Waived']) {
      await inRollback(async (tx) => {
        const s = stubs();
        const today = anchor();
        const agent = await makeAgent(tx);
        const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
        await addCondition(tx, id, { type: 'Financing', status, deadline: day(today, 2) });

        expect([status, (await sweepFor(tx, s).sweep(today)).conditionReminders]).toEqual([status, 0]);
      });
    }
  });

  it('leaves alone a condition on a deal that has ended', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Closed']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 2) });

      expect((await sweepFor(tx, s).sweep(today)).conditionReminders).toBe(0);
    });
  });

  it('does not chase a deadline that has already passed', async () => {
    // A reminder to do something by yesterday is not a reminder.
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, -1) });

      expect((await sweepFor(tx, s).sweep(today)).conditionReminders).toBe(0);
    });
  });

  it('sends nothing twice on the same day', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 3) });

      await sweepFor(tx, s).sweep(today);
      expect((await sweepFor(tx, s).sweep(today)).conditionReminders).toBe(0);
      expect(s.sent.filter((m) => m.event === 'transaction.condition_deadline_reminder')).toHaveLength(1);
    });
  });

  it('chases again the next day, with the count moved on', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 3) });

      await sweepFor(tx, s).sweep(today);
      await sweepFor(tx, s).sweep(day(today, 1));

      const mails = s.sent.filter((m) => m.event === 'transaction.condition_deadline_reminder');
      expect(mails.map((m) => m.vars.days_remaining)).toEqual(['3', '2']);
    });
  });
});

// ---------------------------------------------------------------------------
// the record each one leaves
// ---------------------------------------------------------------------------

describe('what the new reminders leave behind (TD-009)', () => {
  jest.setTimeout(180_000);

  it('writes each kind to the audit trail under its own name', async () => {
    /*
     * The label was `kind === 'lawyer' ? 'Lawyer details reminder' : 'Listing expiry reminder'` — a
     * ternary that reads as exhaustive and silently mislabels anything added after it. A closing
     * reminder filed as a listing expiry would be the sort of wrong that is only found by somebody
     * reading a trail and disbelieving it.
     */
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeAgent(tx);
      const id = await makeDeal(tx, { agent, closing_date: day(today, 5) }, ['Secured Conditional']);
      await addCondition(tx, id, { type: 'Financing', deadline: day(today, 5) });

      await sweepFor(tx, s).sweep(today);

      const fields = (await tx.audit_logs.findMany({ where: { transaction_id: id, section: 'Reminders' }, select: { field: true } }))
        .map((a) => a.field);
      expect(fields).toContain('Closing date reminder');
      expect(fields).toContain('Condition deadline reminder');
      expect(fields).not.toContain('Listing expiry reminder');
    });
  });

  it('records a Skipped delivery when the agent has no address, rather than failing', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const id = await makeDeal(tx, { agent: 'Nobody On File', closing_date: day(today, 4) }, ['Secured Firm']);

      const result = await sweepFor(tx, s).sweep(today);

      expect(result.closingReminders).toBe(1); // the in-app half still happened
      expect(s.sent.filter((m) => m.event === 'transaction.closing_reminder')).toHaveLength(0);
      const email = await tx.transaction_reminders.findFirst({ where: { transaction_id: id, kind: 'closing', delivery_method: 'email' } });
      expect(email?.delivery_status).toBe('Skipped');
    });
  });
});
