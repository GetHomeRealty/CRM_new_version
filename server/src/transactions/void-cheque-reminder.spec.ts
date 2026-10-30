import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { CommissionService } from './commission.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DEFAULT_VOID_CHEQUE, applyRulesPatch, defaultRules, readRules, voidChequeDays, voidChequeDue } from './reminder-rules';

/**
 * THE CLIENT VOID CHEQUE REMINDER (Sai, 29 Oct 2026).
 *
 * A Sold sale listing / Leased lease listing whose Financial shows money Payable to Client, with no void
 * cheque uploaded (Agent Payment Readiness) and "Client Void cheque Received" not Yes (Admin Activities):
 * the agent and co-agents are reminded every day from 7 days before closing to the closing day, then for
 * 15 days after closing every other day plus every Tuesday and Thursday - never on a Wednesday or Friday,
 * the payment days (Sai, 30 Oct) - while it is still not received. On/Off + timing on Triggers.
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

describe('void cheque rule (Sai, 30 Oct: never Wednesday or Friday; Tuesday and Thursday always)', () => {
  const ymdOf = (closing: Date, n: number) => ymd(day(closing, n));

  it('Sai\'s example: closing Wed 11 Nov 2026', () => {
    expect(defaultRules().void_cheque).toEqual({ on: true, before: 7, after: 15, gap: 2, never: [3, 5], always: [2, 4] });
    const closing = new Date(2026, 10, 11, 12);
    expect(closing.getDay()).toBe(3); // a Wednesday
    const sent = voidChequeDays(closing, DEFAULT_VOID_CHEQUE).map((n) => ymdOf(closing, n));
    expect(sent).toEqual([
      // before closing: every day except Wednesday and Friday (Wed 4, Fri 6 and the closing Wed 11 skipped)
      '2026-11-05', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10',
      // after closing: every other day from the last one, plus every Tue and Thu, never Wed or Fri
      '2026-11-12', '2026-11-14', '2026-11-16', '2026-11-17', '2026-11-19', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-26',
    ]);
  });

  it('for a closing on every weekday: never Wed/Fri, every Tue/Thu in the window, never more than 2 days apart after closing, nothing past day 15', () => {
    for (let k = 0; k < 7; k++) {
      const closing = new Date(2026, 10, 9 + k, 12); // Mon 9 .. Sun 15 Nov
      const sent = voidChequeDays(closing, DEFAULT_VOID_CHEQUE);
      for (const n of sent) expect([3, 5]).not.toContain(day(closing, n).getDay());
      for (let n = -7; n <= 15; n++) {
        if ([2, 4].includes(day(closing, n).getDay())) expect(sent).toContain(n);
      }
      expect(Math.max(...sent)).toBeLessThanOrEqual(15);
      const after = sent.filter((n) => n > 0);
      const gaps = [after[0] - Math.max(...sent.filter((n) => n <= 0)), ...after.slice(1).map((n, i) => n - after[i])];
      // a gap is 1 or 2 days, or 3 when a Wed/Fri had to be skipped
      for (const g of gaps) expect(g).toBeLessThanOrEqual(3);
      expect(voidChequeDue(day(closing, sent[0]), closing, DEFAULT_VOID_CHEQUE).due).toBe(true);
    }
  });

  it('is editable and validated like the others', () => {
    const r = applyRulesPatch(defaultRules(), { void_cheque: { before: '3', after: '10', gap: '3', never: [0, 6], always: [1] } });
    expect('rules' in r && r.rules.void_cheque).toEqual({ on: true, before: 3, after: 10, gap: 3, never: [0, 6], always: [1] });
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { before: '61' } })).toBe(true);
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { gap: '0' } })).toBe(true);
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { never: [2], always: [2] } })).toBe(true);
    expect('errors' in applyRulesPatch(defaultRules(), { void_cheque: { never: [9] } })).toBe(true);
    expect(readRules({ reminder_rules: { void_cheque: { on: false } } }).void_cheque.on).toBe(false);
    // the 29 Oct stored shape (days / every / until) reads as the new defaults, keeping its switch
    expect(readRules({ reminder_rules: { void_cheque: { on: true, days: [7, 0], every: 1, until: 60 } } }).void_cheque).toEqual(DEFAULT_VOID_CHEQUE);
  });
});

describe('void cheque reminder in the nightly sweep', () => {
  jest.setTimeout(60_000);
  const closing = anchor();
  const live = { reminder_rules: { after_closing_from: ymd(day(closing, -30)) } };

  it('a Sold listing owing the client: reminded before and after closing (never on a Wednesday), until it is uploaded', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const t = await listing(tx, agent, closing, ['Sold']);
      await setFlags(tx, live);
      const s = stubs();
      const sweep = sweepFor(tx, s);
      for (const n of [-8, -7, -1, 0, 1, 2]) await sweep.sweep(day(closing, n));
      await sweep.sweep(day(closing, 2)); // same day again: nothing new
      // closing Tue 16 Jun: -7 Tue, -1 Mon, 0 Tue; +1 is a Wednesday (skipped), +2 a Thursday
      expect(vcMails(s).map((m) => m.vars.when_phrase)).toEqual(['closing in 7 days', 'closing tomorrow', 'closing today', '2 days after closing']);
      expect(vcMails(s)[0].to).toBe(agent.email);
      expect(vcMails(s)[0].vars.payable_to_client).toBe('16,100.00');

      await tx.transactions.update({ where: { id: t.id }, data: { activity_tracker: JSON.stringify({ void_cheque: { name: 'vc.pdf', data: 'data:application/pdf;base64,AA==' } }) } });
      await sweep.sweep(day(closing, 3));
      expect(vcMails(s)).toHaveLength(4); // uploaded: stops
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
