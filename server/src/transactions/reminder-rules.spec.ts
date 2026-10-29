import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { ReminderRulesService } from './reminder-rules.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import {
  DEFAULT_AFTER, afterClosingDue, applyRulesPatch, defaultRules, readRules,
} from './reminder-rules';
import {
  CLOSING_REMINDER_DAYS, CONDITION_WINDOW_DAYS, DEPOSIT_GRACE_DAYS, EXPIRY_WINDOW_DAYS, LAWYER_REMINDER_DAYS,
  closingReminderFor, conditionReminderFor, depositReminderFor, expiryReminderFor, lawyerReminderFor,
} from './reminder-schedule';

/**
 * REMINDER SWITCHES, EDITABLE DAYS AND AFTER-CLOSING REMINDERS (Sai, 29 Oct 2026).
 *
 *   - Every scheduled reminder has an On/Off switch and (except commission) days a Super Admin can
 *     change on the Triggers screen. Nothing set = exactly what ran before.
 *   - After the closing date, every other day (1, 3, 5 ... up to 60) until done:
 *       status still Firm/Conditional  -> agent + Documentation ("Handled by", else the team)
 *       required documents not Valid   -> agent
 *       lawyer details missing         -> agent, asking only for the missing side
 *   - "Hold the old deals": nothing for deals that closed before the go-live day.
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

type Dispatched = { category: string; userId: number; dedupeKey?: string; channels?: string[] };
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

async function makeUser(tx: PrismaService, role = 'agent', over: Record<string, unknown> = {}): Promise<{ id: number; name: string; email: string }> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  return tx.users.create({
    data: { name: `RR ${role} ${tag}`, email: `rr-${role}-${tag}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now, ...over },
    select: { id: true, name: true, email: true },
  });
}

async function makeDeal(tx: PrismaService, over: Record<string, unknown>, statuses: string[]): Promise<number> {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({
    data: { trade_no: `RR-${Date.now()}-${seq}`, type: 'Residential Buying', property: '9 After Close Way', created_at: now, updated_at: now, ...over },
  });
  for (const status of statuses) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  }
  return t.id;
}

const LAWYERS = {
  buyer_lawyer_name: 'B Law', buyer_lawyer_email: 'b@law.test', buyer_lawyer_phone: '1',
  seller_lawyer_name: 'S Law', seller_lawyer_email: 's@law.test', seller_lawyer_phone: '2',
};

/** Store rules (and the hold date) the way the Triggers screen does. */
async function setFlags(tx: PrismaService, flags: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await tx.company_settings.upsert({
    where: { id: 1 },
    create: { id: 1, feature_flags: JSON.stringify(flags), created_at: now, updated_at: now } as never,
    update: { feature_flags: JSON.stringify(flags) },
  });
}

// ---------------------------------------------------------------------------
// the rules on their own
// ---------------------------------------------------------------------------

describe('reminder rules - defaults are exactly what ran before', () => {
  it('starts every existing reminder On with today\'s days, and the after-closing ones Off', () => {
    const r = defaultRules();
    expect(r.lawyer).toEqual({ on: true, days: [30, 23, 15, 11, 7, 5, 3, 1, 0] });
    expect(r.closing).toEqual({ on: true, days: [10, 7, 4, 3, 2, 1, 0] });
    expect(r.condition).toEqual({ on: true, days: [7, 6, 5, 4, 3, 2, 1, 0] });
    expect(r.listing_expiry).toEqual({ on: true, days: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] });
    expect(r.deposit).toEqual({ on: true, days: 5 });
    expect(r.commission).toEqual({ on: true });
    // The after-closing ones start OFF (Sai, answer A) - switched on from the Triggers screen.
    for (const k of ['after_status', 'after_docs', 'after_lawyer'] as const) expect(r[k]).toEqual({ on: false, first: 1, every: 2, until: 60 });
    expect(readRules({})).toEqual(r);
  });

  it('the default day lists give the same answer as before on every day of a 70-day run-up', () => {
    const today = anchor();
    for (let n = -5; n <= 65; n++) {
      const d = day(today, n);
      expect(closingReminderFor(today, d).due).toBe(CLOSING_REMINDER_DAYS.includes(n));
      expect(lawyerReminderFor(today, d).due).toBe(LAWYER_REMINDER_DAYS.includes(n));
      expect(conditionReminderFor(today, d).due).toBe(n >= 0 && n <= CONDITION_WINDOW_DAYS);
      expect(expiryReminderFor(today, d).due).toBe(n >= 1 && n <= EXPIRY_WINDOW_DAYS);
      expect(depositReminderFor(today, day(today, -n)).due).toBe(n === DEPOSIT_GRACE_DAYS);
    }
  });

  it('the lawyer switch is still lawyer_reminder_days: 0 is Off, unset or 3 is On', () => {
    expect(readRules({ lawyer_reminder_days: 0 }).lawyer.on).toBe(false);
    expect(readRules({ lawyer_reminder_days: 3 }).lawyer.on).toBe(true);
    expect(readRules({}).lawyer.on).toBe(true);
  });

  it('a stored value that cannot be used falls back to the default for that reminder only', () => {
    const r = readRules({ reminder_rules: { closing: { on: false, days: [5, 99] }, condition: 'junk', deposit: { days: 0 }, after_docs: { first: 9, every: 2, until: 3 } } });
    expect(r.closing).toEqual({ on: false, days: [10, 7, 4, 3, 2, 1, 0] });
    expect(r.condition.on).toBe(true);
    expect(r.deposit.days).toBe(5);
    expect(r.after_docs).toEqual(DEFAULT_AFTER);
  });
});

describe('reminder rules - what the Triggers screen may save', () => {
  const base = defaultRules();

  it('takes typed days in any order and stores them largest first', () => {
    const r = applyRulesPatch(base, { closing: { days: '1, 5, 3' } });
    expect('rules' in r && r.rules.closing.days).toEqual([5, 3, 1]);
  });

  it('a blank box goes back to the default days', () => {
    const r = applyRulesPatch({ ...base, closing: { on: true, days: [5] } }, { closing: { days: '' } });
    expect('rules' in r && r.rules.closing.days).toEqual([10, 7, 4, 3, 2, 1, 0]);
  });

  it('refuses more than 60, fractions, words and a day given twice - and saves nothing', () => {
    for (const days of ['61', '3, 2.5', 'ten', '5, 5']) {
      const r = applyRulesPatch(base, { closing: { days }, commission: { on: false } });
      expect('errors' in r).toBe(true);
    }
  });

  it('a listing expiry reminder cannot be on day 0 (that is the day it is expired)', () => {
    expect('errors' in applyRulesPatch(base, { listing_expiry: { days: '0, 3' } })).toBe(true);
    expect('rules' in applyRulesPatch(base, { condition: { days: '0, 3' } })).toBe(true);
  });

  it('deposit is one number from 1 to 60', () => {
    expect('errors' in applyRulesPatch(base, { deposit: { days: '3, 4' } })).toBe(true);
    expect('errors' in applyRulesPatch(base, { deposit: { days: 0 } })).toBe(true);
    const r = applyRulesPatch(base, { deposit: { days: '7' } });
    expect('rules' in r && r.rules.deposit.days).toBe(7);
  });

  it('after closing: first day, every N days, last day - first must not be after the last', () => {
    const r = applyRulesPatch(base, { after_docs: { first: 2, every: 7, until: 30 } });
    expect('rules' in r && r.rules.after_docs).toEqual({ on: false, first: 2, every: 7, until: 30 });
    expect('errors' in applyRulesPatch(base, { after_docs: { first: 40, until: 30 } })).toBe(true);
    expect('errors' in applyRulesPatch(base, { after_docs: { until: 61 } })).toBe(true);
  });
});

describe('after-closing timing (Sai: 1, 3, 5, 7 ... until filled, up to 60 days)', () => {
  it('goes 1, 3, 5 ... 59 days after closing with the defaults - never on the closing day, never after 60', () => {
    const closing = anchor();
    const days = Array.from({ length: 70 }, (_, i) => i - 3).filter((n) => afterClosingDue(day(closing, n), closing, DEFAULT_AFTER).due);
    expect(days).toEqual(Array.from({ length: 30 }, (_, i) => 1 + 2 * i));
  });

  it('follows edited timing', () => {
    const closing = anchor();
    const rule = { on: true, first: 2, every: 7, until: 30 };
    const days = Array.from({ length: 40 }, (_, i) => i).filter((n) => afterClosingDue(day(closing, n), closing, rule).due);
    expect(days).toEqual([2, 9, 16, 23, 30]);
  });
});

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

describe('switches and edited days in the nightly sweep', () => {
  it('a closing reminder switched Off is not sent; edited days are followed', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const today = anchor();
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(day(today, 5)), ...LAWYERS }, ['Secured Firm']);

      await setFlags(tx, { reminder_rules: { closing: { on: false } } });
      let s = stubs();
      await sweepFor(tx, s).sweep(today);
      expect(s.sent.filter((m) => m.event === 'transaction.closing_reminder')).toHaveLength(0);

      await setFlags(tx, { reminder_rules: { closing: { on: true, days: [5] } } });
      s = stubs();
      await sweepFor(tx, s).sweep(today);
      expect(s.sent.filter((m) => m.event === 'transaction.closing_reminder')).toHaveLength(1);
    });
  });

  it('lawyer reminders switched off with lawyer_reminder_days = 0 stay off', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const today = anchor();
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(day(today, 7)) }, ['Secured Firm']);
      await setFlags(tx, { lawyer_reminder_days: 0 });
      const s = stubs();
      await sweepFor(tx, s).sweep(today);
      expect(s.sent.filter((m) => m.event.startsWith('transaction.lawyer_'))).toHaveLength(0);
    });
  });
});

describe('after-closing reminders in the nightly sweep', () => {
  const closing = anchor();
  const ON = { after_status: { on: true }, after_docs: { on: true }, after_lawyer: { on: true } };
  const held = { reminder_rules: { after_closing_from: ymd(day(closing, -10)), ...ON } };

  it('they start OFF: with only the go-live day recorded, nothing after closing is sent', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await makeUser(tx, 'documentation');
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing) }, ['Secured Firm']);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(closing, -10)) } });
      const s = stubs();
      for (let n = 1; n <= 7; n++) await sweepFor(tx, s).sweep(day(closing, n));
      expect(s.sent.filter((m) => m.event.startsWith('transaction.after_closing'))).toHaveLength(0);
      expect(s.dispatched.filter((d) => d.category === 'after_closing')).toHaveLength(0);
    });
  });

  it('status still Firm: the agent and the deal\'s Documentation handler, every other day, until it is Closed', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const handler = await makeUser(tx, 'documentation');
      await makeUser(tx, 'documentation'); // somebody else in the team, NOT told: the deal names its handler
      const id = await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing), doc_handler_id: handler.id, ...LAWYERS }, ['Secured Firm']);
      await setFlags(tx, held);
      const s = stubs();
      const sweep = sweepFor(tx, s);

      await sweep.sweep(day(closing, 0)); // closing day: nothing after-closing yet
      await sweep.sweep(day(closing, 1));
      await sweep.sweep(day(closing, 1)); // second run the same day: nothing new
      await sweep.sweep(day(closing, 2)); // off day
      await sweep.sweep(day(closing, 3));

      const agentMails = s.sent.filter((m) => m.event === 'transaction.after_closing_status');
      expect(agentMails.map((m) => m.vars.days_after)).toEqual(['1', '3']);
      expect(agentMails[0].to).toBe(agent.email);
      expect(agentMails[0].vars.current_status).toBe('Secured Firm');
      const teamMails = s.sent.filter((m) => m.event === 'transaction.after_closing_status_team');
      expect(teamMails.map((m) => m.to)).toEqual([handler.email, handler.email]);
      const teamBell = s.dispatched.filter((d) => d.category === 'after_closing' && d.userId === handler.id);
      expect(teamBell.length).toBe(3); // day 1, the repeat (refused as duplicate), day 3

      const st = await tx.transaction_statuses.findFirst({ where: { transaction_id: id } });
      await tx.transaction_statuses.update({ where: { id: st!.id }, data: { status: 'Closed' } });
      await sweep.sweep(day(closing, 5));
      expect(s.sent.filter((m) => m.event.startsWith('transaction.after_closing_status'))).toHaveLength(4);
    });
  });

  it('no Handled by: everyone active in Documentation for the deal\'s country', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await tx.users.updateMany({ where: { role: 'documentation' }, data: { status: 'Inactive' } });
      const a = await makeUser(tx, 'documentation');
      const b = await makeUser(tx, 'documentation', { markets: 'CA,IN' });
      await makeUser(tx, 'documentation', { markets: 'IN' }); // India only - not told about a Canada deal
      await makeUser(tx, 'documentation', { status: 'Inactive' });
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing), ...LAWYERS }, ['Secured Conditional']);
      await setFlags(tx, held);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 1));
      expect(s.sent.filter((m) => m.event === 'transaction.after_closing_status_team').map((m) => m.to).sort()).toEqual([a.email, b.email].sort());
    });
  });

  it('required documents not Valid: the agent only, listing them, until every one is Valid', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const id = await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing), ...LAWYERS }, ['Closed']);
      const now = new Date();
      const doc = await tx.documents.create({ data: { transaction_id: id, title: 'APS', mandatory: true, status: 'Received', validation: 'Invalid', created_at: now, updated_at: now } });
      await tx.documents.create({ data: { transaction_id: id, title: 'Optional thing', mandatory: false, status: 'Pending', validation: 'Pending', created_at: now, updated_at: now } });
      await setFlags(tx, held);
      const s = stubs();
      const sweep = sweepFor(tx, s);
      await sweep.sweep(day(closing, 1));
      const mails = s.sent.filter((m) => m.event === 'transaction.after_closing_documents');
      expect(mails).toHaveLength(1);
      expect(mails[0].vars.document_list).toBe('APS (Invalid)');
      expect(s.sent.some((m) => m.event === 'transaction.after_closing_status_team')).toBe(false); // agent only

      await tx.documents.update({ where: { id: doc.id }, data: { validation: 'Valid' } });
      await sweep.sweep(day(closing, 3));
      expect(s.sent.filter((m) => m.event === 'transaction.after_closing_documents')).toHaveLength(1);
    });
  });

  it('lawyer details: asks only for the missing side; a dead deal is left alone', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const { buyer_lawyer_name, buyer_lawyer_email, buyer_lawyer_phone } = LAWYERS;
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing), buyer_lawyer_name, buyer_lawyer_email, buyer_lawyer_phone }, ['Closed']);
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing) }, ['Terminated']);
      await setFlags(tx, held);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 1));
      const mails = s.sent.filter((m) => m.event === 'transaction.after_closing_lawyer');
      expect(mails).toHaveLength(1);
      expect(mails[0].vars.missing_details).toBe('Seller Lawyer Details');
    });
  });

  it('holds the old deals: a deal that closed before the go-live day is never chased', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing) }, ['Secured Firm']);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(closing, 1)), ...ON } });
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 3));
      expect(s.sent.filter((m) => m.event.startsWith('transaction.after_closing'))).toHaveLength(0);
    });
  });

  it('before go-live is recorded, nothing is chased; each switch turns its own reminder off', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing) }, ['Secured Firm']);
      await setFlags(tx, {});
      let s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 1));
      expect(s.sent.filter((m) => m.event.startsWith('transaction.after_closing'))).toHaveLength(0);

      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(closing, -1)), ...ON, after_status: { on: false }, after_lawyer: { on: false } } });
      s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 1));
      expect(s.sent.filter((m) => m.event.startsWith('transaction.after_closing'))).toHaveLength(0);
    });
  });

  it('stops at 60 days after closing', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(closing) }, ['Secured Firm']);
      await setFlags(tx, held);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 59));
      await sweepFor(tx, s).sweep(day(closing, 61));
      expect(s.sent.filter((m) => m.event === 'transaction.after_closing_status').map((m) => m.vars.days_after)).toEqual(['59']);
    });
  });
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

describe('saving the reminders (Super Admin only)', () => {
  const asUser = (u: { id: number; name: string }, role: string) => ({ ...u, role }) as never;

  it('only a Super Admin may change them; the change is audited', async () => {
    await inRollback(async (tx) => {
      await setFlags(tx, { lawyer_reminder_days: 3, other_flag: true });
      const svc = new ReminderRulesService(tx, new AuditService(tx));
      const manager = await makeUser(tx, 'manager');
      await expect(svc.save(asUser(manager, 'manager'), { closing: { on: false } })).rejects.toThrow();

      const admin = await makeUser(tx, 'admin');
      const out = await svc.save(asUser(admin, 'admin'), { closing: { days: '5, 2' }, lawyer: { on: false } });
      expect(out.data.closing.days).toEqual([5, 2]);
      expect(out.data.lawyer.on).toBe(false);
      const flags = JSON.parse(String((await tx.company_settings.findUnique({ where: { id: 1 } }))!.feature_flags));
      expect(flags.lawyer_reminder_days).toBe(0);
      expect(flags.other_flag).toBe(true);
      const trail = await tx.audit_logs.findMany({ where: { section: 'Triggers', user_id: admin.id } });
      expect(trail.map((a) => a.field).sort()).toEqual(['Closing-date reminders', 'Lawyer-detail reminders']);

      await expect(svc.save(asUser(admin, 'admin'), { closing: { days: '99' } })).rejects.toThrow();
    });
  });

  it('switching an after-closing reminder On holds every deal that closed before that day', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeUser(tx);
      const admin = await makeUser(tx, 'admin');
      // Go-live was ten days ago; the reminder was Off until now.
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(today, -10)) } });
      const closedYesterday = await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(day(today, -1)) }, ['Secured Firm']);
      const closesToday = await makeDeal(tx, { agent: agent.name, agent_user_id: agent.id, closing_date: dbDate(today) }, ['Secured Firm']);

      const svc = new ReminderRulesService(tx, new AuditService(tx));
      const out = await svc.save(asUser(admin, 'admin'), { after_status: { on: true } });
      expect(out.data.after_status.on).toBe(true);
      expect(out.data.after_started.after_status).toBe(ymd(today));

      const s = stubs();
      await sweepFor(tx, s).sweep(day(today, 1));
      await sweepFor(tx, s).sweep(day(today, 2));
      const mails = s.sent.filter((m) => m.event === 'transaction.after_closing_status');
      const deals = await tx.transactions.findMany({ where: { id: { in: [closedYesterday, closesToday] } }, select: { id: true, trade_no: true } });
      const no = (id: number) => deals.find((d) => d.id === id)!.trade_no;
      expect(mails.map((m) => m.vars.deal_number)).toEqual([no(closesToday)]); // day 1 of the new deal only
    });
  });

  it('records the go-live day once, and never moves it', async () => {
    await inRollback(async (tx) => {
      await setFlags(tx, {});
      const svc = new ReminderRulesService(tx, new AuditService(tx));
      await svc.markAfterClosingStart(new Date(2026, 9, 30, 9));
      await svc.markAfterClosingStart(new Date(2026, 10, 5, 9));
      const flags = JSON.parse(String((await tx.company_settings.findUnique({ where: { id: 1 } }))!.feature_flags));
      expect(flags.reminder_rules.after_closing_from).toBe('2026-10-30');
    });
  });
});
