import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { CommissionService } from './commission.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DEFAULT_VOID_CHEQUE, applyRulesPatch, defaultRules, readRules, voidChequeDue } from './reminder-rules';

/**
 * THE CLIENT VOID CHEQUE REMINDER (Sai, 29 Oct 2026).
 *
 * A Sold sale listing / Leased lease listing whose Financial shows money Payable to Client, with no void
 * cheque uploaded (Agent Payment Readiness) and "Client Void cheque Received" not Yes (Admin Activities):
 * the agent and co-agents are reminded every day from 7 days before closing to the closing day, then
 * every day after closing (up to 60 days) while it is still not received. On/Off + days on Triggers.
 * After closing, only deals closing on or after the go-live day (old deals held).
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
    sent, dispatched,
    mailer: { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
    dispatcher: {
      dispatch: async (r: Dispatched) => {
        dispatched.push(r);
        const k = `${r.userId}|${r.category}|${r.dedupeKey}`;
        if (r.dedupeKey && ledger.has(k)) return { delivered: [], skipped: [{ channel: 'in_app', reason: 'duplicate' }], failed: [] };
        if (r.dedupeKey) ledger.add(k);
        return { delivered: r.channels ?? [], skipped: [], failed: [] };
      },
      shouldSend: async () => true,
    },
  };
};
const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx), s.dispatcher as never, new CommissionService(new PersonResolver(tx)));

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dbDate = (d: Date): Date => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

async function user(tx: PrismaService) {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  return tx.users.create({
    data: { name: `VC Agent ${tag}`, email: `vc-${tag}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
    select: { id: true, name: true, email: true },
  });
}

/** Price 1,500,000, 1% + 1% -> 33,900 with HST; deposit 50,000 -> 16,100 Payable to Client. */
async function listing(tx: PrismaService, agent: { id: number; name: string }, closing: Date, statuses: string[], over: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({ data: {
    trade_no: `VC-${Date.now()}-${seq}`, type: 'Residential Sale Listing', property: '1 Cheque Court',
    agent: agent.name, agent_user_id: agent.id, price: 1500000, deposit: 50000,
    listing_comm_pct: 1, coop_comm_pct: 1, closing_date: dbDate(closing),
    adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now, ...over,
  } as never });
  for (const status of statuses) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  return t;
}

async function setFlags(tx: PrismaService, flags: Record<string, unknown>) {
  const now = new Date();
  await tx.company_settings.upsert({ where: { id: 1 }, create: { id: 1, feature_flags: JSON.stringify(flags), created_at: now, updated_at: now } as never, update: { feature_flags: JSON.stringify(flags) } });
}

const vcMails = (s: ReturnType<typeof stubs>) => s.sent.filter((m) => m.event === 'transaction.void_cheque_reminder');

describe('void cheque rule', () => {
  it('starts On: 7..0 days before closing, then every day after closing up to day 60', () => {
    expect(defaultRules().void_cheque).toEqual({ on: true, days: [7, 6, 5, 4, 3, 2, 1, 0], every: 1, until: 60 });
    const closing = anchor();
    // n = the day relative to closing: -7 is a week before, 0 the closing day, 5 five days after.
    const due = Array.from({ length: 80 }, (_, i) => i - 10).filter((n) => voidChequeDue(day(closing, n), closing, DEFAULT_VOID_CHEQUE).due);
    expect(due).toEqual([-7, -6, -5, -4, -3, -2, -1, 0, ...Array.from({ length: 60 }, (_, i) => i + 1)]);
  });

  it('is editable and validated like the others', () => {
    const r = applyRulesPatch(defaultRules(), { void_cheque: { days: '3, 0', every: '2', until: '30' } });
    expect('rules' in r && r.rules.void_cheque).toEqual({ on: true, days: [3, 0], every: 2, until: 30 });
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { days: '61' } })).toBe(true);
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { until: '0' } })).toBe(true);
    expect(readRules({ reminder_rules: { void_cheque: { on: false } } }).void_cheque.on).toBe(false);
  });
});

describe('void cheque reminder in the nightly sweep', () => {
  jest.setTimeout(60_000);
  const closing = anchor();
  const live = { reminder_rules: { after_closing_from: ymd(day(closing, -30)) } };

  it('a Sold listing owing the client: daily from 7 days before closing, and after closing, until it is uploaded', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const t = await listing(tx, agent, closing, ['Sold']);
      await setFlags(tx, live);
      const s = stubs();
      const sweep = sweepFor(tx, s);
      for (const n of [-8, -7, -1, 0, 1, 2]) await sweep.sweep(day(closing, n));
      await sweep.sweep(day(closing, 2)); // same day again: nothing new
      expect(vcMails(s).map((m) => m.vars.when_phrase)).toEqual(['closing in 7 days', 'closing tomorrow', 'closing today', '1 day after closing', '2 days after closing']);
      expect(vcMails(s)[0].to).toBe(agent.email);
      expect(vcMails(s)[0].vars.payable_to_client).toBe('16,100.00');

      await tx.transactions.update({ where: { id: t.id }, data: { activity_tracker: JSON.stringify({ void_cheque: { name: 'vc.pdf', data: 'data:application/pdf;base64,AA==' } }) } });
      await sweep.sweep(day(closing, 3));
      expect(vcMails(s)).toHaveLength(5); // uploaded: stops
    });
  });

  it('stops when Admin Activities says received; nothing when nothing is payable to the client', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      await listing(tx, agent, closing, ['Sold'], { admin_activities: JSON.stringify({ void_cheque_received: 'Yes' }) });
      await listing(tx, agent, closing, ['Sold'], { deposit: 20000 }); // deposit below the commission: $0 to the client
      await setFlags(tx, live);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, -3));
      expect(vcMails(s)).toHaveLength(0);
    });
  });

  it('only Sold sale listings and Leased lease listings - not Active, Sold Conditional or a dead deal', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      await listing(tx, agent, closing, ['Active']);
      await listing(tx, agent, closing, ['Sold Conditional']);
      await listing(tx, agent, closing, ['Sold', 'Terminated']);
      await listing(tx, agent, closing, ['Sold'], { type: 'Residential Lease Listing' }); // a lease must be Leased
      const leased = await listing(tx, agent, closing, ['Leased'], { type: 'Residential Lease Listing', price: 3000, deposit: 6000, listing_comm_pct: 50, coop_comm_pct: 50 });
      await setFlags(tx, live);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, -3));
      expect(vcMails(s).map((m) => m.vars.deal_number)).toEqual([leased.trade_no]);
    });
  });

  it('after closing, old deals are held: a deal that closed before go-live is not chased', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      await listing(tx, agent, closing, ['Sold']);
      await setFlags(tx, { reminder_rules: { after_closing_from: ymd(day(closing, 1)) } });
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, 2));
      expect(vcMails(s)).toHaveLength(0);
    });
  });

  it('co-agents get it too (bell + phone + email), once a day; switched Off sends nothing', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const co = await user(tx);
      const t = await listing(tx, agent, closing, ['Sold']);
      await tx.team_members.create({ data: { transaction_id: t.id, name: agent.name, user_id: agent.id, is_primary: true } as never });
      await tx.team_members.create({ data: { transaction_id: t.id, name: co.name, user_id: co.id } as never });
      await setFlags(tx, live);
      const s = stubs();
      await sweepFor(tx, s).sweep(day(closing, -2));
      await sweepFor(tx, s).sweep(day(closing, -2));
      expect(vcMails(s).map((m) => m.to).sort()).toEqual([agent.email, co.email].sort());
      expect(s.dispatched.filter((d) => d.category === 'void_cheque' && d.userId === co.id)[0].channels).toEqual(['in_app', 'push']);

      await setFlags(tx, { reminder_rules: { ...live.reminder_rules, void_cheque: { on: false } } });
      const off = stubs();
      await sweepFor(tx, off).sweep(day(closing, -1));
      expect(vcMails(off)).toHaveLength(0);
    });
  });
});
