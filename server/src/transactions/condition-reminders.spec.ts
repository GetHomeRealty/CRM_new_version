import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ReminderSweepService, conditionDocumentIn, conditionDueSentence, conditionOverdueSentence, conditionOverdueSummary,
} from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { CONDITION_OVERDUE_DAYS, conditionOverdueFor, shortDay } from './reminder-schedule';
import { MAIL_EVENTS } from '../email/mail-event-registry';

/**
 * CONDITION REMINDERS ASK FOR THE DOCUMENT, AND CARRY ON PAST THE DEADLINE (Sai, 31 Oct 2026).
 *
 *   - Before the deadline (same days as before): "The Financing condition on 12 Main St is due in 3
 *     days (05 Nov). Upload the signed Waiver or Notice of Fulfilment, or an Amendment if the
 *     deadline is being extended."
 *   - After it: every other day for 15 days (1, 3 ... 15), to the agent by email, and to
 *     Documentation by bell + phone only. Then it stops.
 *   - Stops when the condition is Fulfilled / Waived, its document is in, or the deal has ended.
 *   - Old conditions are left alone: only deadlines from the go-live day (after_closing_from).
 *
 * Real rows in rolled-back transactions and a pinned "today", like the other reminder specs.
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

type Dispatched = { category: string; userId: number; title: string; dedupeKey?: string; channels?: string[] };
const stubs = () => {
  const sent: { event: string; vars: Record<string, string>; to: unknown }[] = [];
  const dispatched: Dispatched[] = [];
  const ledger = new Set<string>();
  return {
    sent,
    dispatched,
    mailer: { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
    dispatcher: {
      dispatch: async (r: Dispatched) => {
        dispatched.push(r);
        const key = `${r.userId}|${r.category}|${r.dedupeKey}`;
        if (r.dedupeKey && ledger.has(key)) return { category: r.category, userId: r.userId, delivered: [], skipped: [{ channel: 'in_app', reason: 'duplicate' }], failed: [] };
        ledger.add(key);
        return { category: r.category, userId: r.userId, delivered: ['in_app'], skipped: [], failed: [] };
      },
      shouldSend: async () => true,
    },
  };
};

const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx), s.dispatcher as never);

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dbDate = (d: Date): Date => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
/** A Tuesday in mid-June, at midday: far from a month end, from DST, and from any date boundary. */
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

async function makeUser(tx: PrismaService, role = 'agent'): Promise<{ id: number; name: string }> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  return tx.users.create({
    data: { name: `CR ${role} ${tag}`, email: `cr-${role}-${tag}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
    select: { id: true, name: true },
  });
}

async function makeDeal(tx: PrismaService, agent: { id: number; name: string }, over: Record<string, unknown> = {}, statuses = ['Secured Conditional']): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `CR-${Date.now()}-${seq}`, type: 'Residential Buying', property: '12 Main St', agent: agent.name, agent_user_id: agent.id, conditional_offer: true, created_at: now, updated_at: now, ...over },
  });
  for (const status of statuses) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  return t.id;
}

async function addCondition(tx: PrismaService, txnId: number, over: Record<string, unknown>): Promise<number> {
  const now = new Date();
  const c = await tx.conditions.create({
    data: { transaction_id: txnId, type: 'Financing', status: 'Pending', position: 0, created_at: now, updated_at: now, ...over },
  });
  // Its "Condition: ..." document, empty, as the Legal & Documents panel creates it.
  await tx.documents.create({
    data: { transaction_id: txnId, title: `Condition: ${String(over.custom_name ?? over.type ?? 'Financing')}`, is_condition: true, condition_id: c.id, created_at: now, updated_at: now } as never,
  });
  return c.id;
}

async function setFlags(tx: PrismaService, flags: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await tx.company_settings.upsert({
    where: { id: 1 },
    create: { id: 1, feature_flags: JSON.stringify(flags), created_at: now, updated_at: now } as never,
    update: { feature_flags: JSON.stringify(flags) },
  });
}

// ---------------------------------------------------------------------------
// the days and the wording, on their own
// ---------------------------------------------------------------------------

describe('condition reminders - days and wording', () => {
  const today = anchor();

  it('after the deadline: every other day for 15 days, then it stops', () => {
    const sent = Array.from({ length: 20 }, (_, i) => i).filter((n) => conditionOverdueFor(today, day(today, -n)).due);
    expect(sent).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect([...CONDITION_OVERDUE_DAYS]).toEqual(sent);
  });

  it('says it the way Sai approved', () => {
    const d = new Date(Date.UTC(2026, 10, 5));
    expect(shortDay(d)).toBe('05 Nov');
    expect(conditionDueSentence('12 Main St', [{ label: 'Financing', deadline: d, daysRemaining: 3 }]))
      .toBe('The Financing condition on 12 Main St is due in 3 days (05 Nov).');
    expect(conditionOverdueSentence('12 Main St', [{ label: 'Financing', deadline: d, daysPast: 2 }]))
      .toBe('The Financing condition on 12 Main St was due 2 days ago (05 Nov) and is still open.');
    expect(conditionOverdueSummary('12 Main St', [{ label: 'Financing', daysPast: 2 }]))
      .toBe('Financing condition still open, 2 days past its deadline - 12 Main St');
  });

  it('reads several conditions as one sentence', () => {
    const d = new Date(Date.UTC(2026, 10, 5));
    const e = new Date(Date.UTC(2026, 10, 7));
    expect(conditionDueSentence('12 Main St', [{ label: 'Financing', deadline: d, daysRemaining: 1 }, { label: 'Inspection', deadline: d, daysRemaining: 1 }]))
      .toBe('The Financing and Inspection conditions on 12 Main St are due tomorrow (05 Nov).');
    expect(conditionDueSentence('12 Main St', [{ label: 'Financing', deadline: d, daysRemaining: 0 }, { label: 'Inspection', deadline: e, daysRemaining: 2 }]))
      .toBe('Conditions on 12 Main St are coming up: Financing due today (05 Nov), Inspection due in 2 days (07 Nov).');
    expect(conditionOverdueSentence('12 Main St', [{ label: 'Financing', deadline: d, daysPast: 3 }, { label: 'Inspection', deadline: e, daysPast: 1 }]))
      .toBe('Conditions on 12 Main St are still open past their deadline: Financing due 05 Nov (3 days ago), Inspection due 07 Nov (1 day ago).');
  });

  it('a condition\'s document counts as in when a file is submitted or the office marked it Received / Valid - not when rejected or only a draft', () => {
    const base = { condition_id: 7, file_path: null, files: null, status: 'Pending', validation: 'Pending' };
    expect(conditionDocumentIn(7, [base])).toBe(false);
    expect(conditionDocumentIn(7, [{ ...base, file_path: 'deals/1/a.pdf' }])).toBe(true);
    expect(conditionDocumentIn(7, [{ ...base, files: '[{"file_path":"x"}]' }])).toBe(true);
    expect(conditionDocumentIn(7, [{ ...base, status: 'Received' }])).toBe(true);
    expect(conditionDocumentIn(7, [{ ...base, validation: 'Valid' }])).toBe(true);
    expect(conditionDocumentIn(7, [{ ...base, file_path: 'deals/1/a.pdf', validation: 'Invalid' }])).toBe(false);
    expect(conditionDocumentIn(7, [{ ...base, files: 'not json' }])).toBe(false);
    expect(conditionDocumentIn(8, [{ ...base, file_path: 'deals/1/a.pdf' }])).toBe(false); // another condition's
  });

  it('the stored email is moved to the new wording only while nobody has edited it', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20261031100000_condition_reminder_wording', 'migration.sql'), 'utf8');
    const newBody = /\$new\$([\s\S]*?)\$new\$/.exec(sql)![1];
    const oldBody = /\$old\$([\s\S]*?)\$old\$/.exec(sql)![1];
    // The migration writes exactly the wording the app now ships, and only over the old shipped one.
    expect(newBody).toBe(MAIL_EVENTS['transaction.condition_deadline_reminder'].default_body_html);
    expect(oldBody).toContain('{{ condition_count }} condition(s) on');
    expect(sql).toContain('AND "body_html" = $old$');
    expect(MAIL_EVENTS['transaction.condition_overdue'].default_body_html).toContain('{{ condition_sentence }} Upload the signed Waiver or Notice of Fulfilment, or an Amendment if the deadline was extended.');
  });
});

// ---------------------------------------------------------------------------
// before the deadline
// ---------------------------------------------------------------------------

describe('condition reminders - before the deadline', () => {
  jest.setTimeout(180_000);

  it('asks for the document, with the approved sentence', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, 3)) });

      expect((await sweepFor(tx, s).sweep(today)).conditionReminders).toBe(1);
      const mail = s.sent.find((m) => m.event === 'transaction.condition_deadline_reminder')!;
      expect(mail.vars.condition_sentence).toBe(`The Financing condition on 12 Main St is due in 3 days (${shortDay(dbDate(day(today, 3)))}).`);
      expect(mail.vars.condition_list).toBe('Financing'); // the old fields are still there for edited templates
    });
  });

  it('stops once the condition\'s document is uploaded - other conditions on the deal still chased', async () => {
    await inRollback(async (tx) => {
      const s = stubs();
      const today = anchor();
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      const fin = await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, 2)) });
      await addCondition(tx, id, { type: 'Inspection', deadline: dbDate(day(today, 2)), position: 1 });
      await tx.documents.updateMany({ where: { condition_id: fin }, data: { file_path: 'deals/x/waiver.pdf', file_name: 'waiver.pdf' } });

      await sweepFor(tx, s).sweep(today);
      const mail = s.sent.find((m) => m.event === 'transaction.condition_deadline_reminder')!;
      expect(mail.vars.condition_list).toBe('Inspection');

      // and with both in, nothing at all
      await tx.documents.updateMany({ where: { transaction_id: id, condition_id: { not: null } }, data: { file_path: 'deals/x/doc.pdf' } });
      const s2 = stubs();
      expect((await sweepFor(tx, s2).sweep(day(today, 1))).conditionReminders).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// after the deadline
// ---------------------------------------------------------------------------

describe('condition reminders - after the deadline', () => {
  jest.setTimeout(180_000);

  it('goes every other day for 15 days to the agent (email) and Documentation (bell + phone, no email), then stops', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      const deadline = day(today, -1);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(deadline, -5)) } });
      const agent = await makeUser(tx);
      const docs = await makeUser(tx, 'documentation');
      const id = await makeDeal(tx, agent, { doc_handler_id: docs.id });
      await addCondition(tx, id, { type: 'Financing', deadline: dbDate(deadline) });

      const s = stubs();
      const sentOn: number[] = [];
      for (let n = 1; n <= 18; n += 1) {
        const before = s.sent.length;
        await sweepFor(tx, s).sweep(day(deadline, n));
        if (s.sent.length > before) sentOn.push(n);
      }
      expect(sentOn).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
      expect(s.sent.every((m) => m.event === 'transaction.condition_overdue')).toBe(true);
      expect(s.sent[1].vars.condition_sentence).toBe(`The Financing condition on 12 Main St was due 3 days ago (${shortDay(dbDate(deadline))}) and is still open.`);
      // Documentation: one bell + phone line per reminder day, never an email (the agent is the only address mailed)
      const team = s.dispatched.filter((d) => d.userId === docs.id);
      expect(team).toHaveLength(8);
      expect(team.every((d) => d.category === 'condition_deadline' && JSON.stringify(d.channels) === JSON.stringify(['in_app', 'push']))).toBe(true);
      expect(team[0].title).toBe('Financing condition still open, 1 day past its deadline - 12 Main St');
      expect(s.sent.every((m) => String(m.to).startsWith('cr-agent-'))).toBe(true);
    });
  });

  it('sends nothing twice on the same day', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
      const agent = await makeUser(tx);
      const docs = await makeUser(tx, 'documentation');
      const id = await makeDeal(tx, agent, { doc_handler_id: docs.id });
      await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -3)) });

      const s = stubs();
      expect((await sweepFor(tx, s).sweep(today)).conditionOverdueReminders).toBe(1);
      expect((await sweepFor(tx, s).sweep(today)).conditionOverdueReminders).toBe(0);
      expect(s.sent).toHaveLength(1);
      expect(s.dispatched.filter((d) => d.userId === docs.id && d.category === 'condition_deadline')).toHaveLength(2); // asked twice, ledger refuses the second
    });
  });

  it('stops when the condition is Fulfilled or Waived, its document is in, or the deal has ended', async () => {
    const cases: [string, (tx: PrismaService, id: number, c: number) => Promise<void>][] = [
      ['fulfilled', async (tx, _id, c) => { await tx.conditions.update({ where: { id: c }, data: { status: 'Fulfilled' } }); }],
      ['waived', async (tx, _id, c) => { await tx.conditions.update({ where: { id: c }, data: { status: 'Waived' } }); }],
      ['document uploaded', async (tx, _id, c) => { await tx.documents.updateMany({ where: { condition_id: c }, data: { file_path: 'deals/x/notice.pdf' } }); }],
      ['marked received', async (tx, _id, c) => { await tx.documents.updateMany({ where: { condition_id: c }, data: { status: 'Received' } }); }],
      ['deal closed', async (tx, id) => { await tx.transaction_statuses.create({ data: { transaction_id: id, status: 'Closed', created_at: new Date(), updated_at: new Date() } }); }],
    ];
    for (const [name, settle] of cases) {
      await inRollback(async (tx) => {
        const today = anchor();
        await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
        const agent = await makeUser(tx);
        const id = await makeDeal(tx, agent);
        const c = await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -1)) });
        await settle(tx, id, c);
        const s = stubs();
        expect([name, (await sweepFor(tx, s).sweep(today)).conditionOverdueReminders, s.dispatched.length]).toEqual([name, 0, 0]);
      });
    }
  });

  it('an Invalid (rejected) upload keeps it going', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      const c = await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -1)) });
      await tx.documents.updateMany({ where: { condition_id: c }, data: { file_path: 'deals/x/wrong.pdf', validation: 'Invalid' } });
      expect((await sweepFor(tx, stubs()).sweep(today)).conditionOverdueReminders).toBe(1);
    });
  });

  it('leaves alone deadlines from before go-live, and sends nothing when no go-live day is recorded yet', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -3)) });

      await setFlags(tx, {});
      expect((await sweepFor(tx, stubs()).sweep(today)).conditionOverdueReminders).toBe(0);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -2)) } });
      expect((await sweepFor(tx, stubs()).sweep(today)).conditionOverdueReminders).toBe(0);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -3)) } });
      expect((await sweepFor(tx, stubs()).sweep(today)).conditionOverdueReminders).toBe(1);
    });
  });

  it('is switched off with the condition switch on Triggers', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)), condition: { on: false } } });
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -1)) });
      const s = stubs();
      expect((await sweepFor(tx, s).sweep(today)).conditionOverdueReminders).toBe(0);
      expect(s.sent).toHaveLength(0);
    });
  });

  it('a new deadline from an Amendment moves it back to the countdown', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      const c = await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -1)) });
      await tx.conditions.update({ where: { id: c }, data: { deadline: dbDate(day(today, 5)) } });
      const s = stubs();
      const r = await sweepFor(tx, s).sweep(today);
      expect([r.conditionOverdueReminders, r.conditionReminders]).toEqual([0, 1]);
    });
  });

  it('a failed email is retried with today\'s state, and dropped once the document is in', async () => {
    await inRollback(async (tx) => {
      const today = anchor();
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, agent);
      const c = await addCondition(tx, id, { type: 'Financing', deadline: dbDate(day(today, -1)) });

      const failing = stubs();
      failing.mailer.send = async () => { const e = new Error('connect ETIMEDOUT') as Error & { code?: string }; e.code = 'ETIMEDOUT'; throw e; };
      await sweepFor(tx, failing).sweep(today);
      const row = await tx.transaction_reminders.findFirstOrThrow({ where: { transaction_id: id, kind: 'condition_overdue', delivery_method: 'email' } });
      expect(row.delivery_status).toBe('Failed');

      await tx.transaction_reminders.update({ where: { id: row.id }, data: { next_retry_at: new Date(Date.now() - 1000) } });
      await tx.documents.updateMany({ where: { condition_id: c }, data: { file_path: 'deals/x/waiver.pdf' } });
      await sweepFor(tx, stubs()).sweep(today);
      expect((await tx.transaction_reminders.findUniqueOrThrow({ where: { id: row.id } })).delivery_status).toBe('Skipped');
    });
  });
});
