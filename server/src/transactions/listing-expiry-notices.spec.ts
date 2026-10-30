import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { AuditService } from '../audit/audit.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * LISTING EXPIRY (Sai, 30 Oct 2026).
 *
 *   countdown       10, 8, 6, 4, 3, 2, 1 days before the expiry date (reminder-schedule.spec / reminder-sweep.spec)
 *   the expiry day  the agent is told the listing expires today (extend it or relist); the office - the
 *                   Documentation "Handled by" person, else the team - gets a bell + phone message
 *   extended        the office is told when a listing's expiry date is moved LATER, and by whom
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
    sent, dispatched,
    mailer: { send: async (event: string, vars: Record<string, string>, to: unknown) => { sent.push({ event, vars, to }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
    dispatcher: {
      dispatch: async (r: Dispatched) => {
        const k = `${r.userId}|${r.category}|${r.dedupeKey}`;
        if (r.dedupeKey && ledger.has(k)) return { delivered: [], skipped: [{ channel: 'in_app', reason: 'duplicate' }], failed: [] };
        if (r.dedupeKey) ledger.add(k);
        dispatched.push(r);
        return { delivered: r.channels ?? [], skipped: [], failed: [] };
      },
      shouldSend: async () => true,
    },
  };
};
const sweepFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new ReminderSweepService(tx, new PersonResolver(tx), s.mailer as never, s.settings as never, new AuditService(tx), s.dispatcher as never);

const day = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dbDate = (d: Date): Date => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const anchor = (): Date => new Date(2026, 5, 16, 12, 0, 0, 0);

async function user(tx: PrismaService, role = 'agent') {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const now = new Date();
  return tx.users.create({
    data: { name: `LX ${role} ${tag}`, email: `lx-${role}-${tag}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
    select: { id: true, name: true, email: true },
  });
}

async function listing(tx: PrismaService, agent: { id: number; name: string }, expiry: Date, statuses: string[], over: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date();
  const t = await tx.transactions.create({ data: {
    trade_no: `LX-${Date.now()}-${seq}`, type: 'Residential Sale Listing', property: '3 Expiry Lane',
    agent: agent.name, agent_user_id: agent.id, listing_expiry_date: dbDate(expiry), created_at: now, updated_at: now, ...over,
  } as never });
  for (const status of statuses) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
  return t;
}

describe('the expiry day', () => {
  jest.setTimeout(60_000);

  it('tells the agent the listing expires today, and the office by bell + phone - once a day', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const handler = await user(tx, 'documentation');
      const today = anchor();
      const t = await listing(tx, agent, today, ['Active'], { doc_handler_id: handler.id });
      const s = stubs();
      await sweepFor(tx, s).sweep(today);
      await sweepFor(tx, s).sweep(today);

      expect(s.sent.map((m) => m.event)).toEqual(['transaction.listing_expired']);
      expect(s.sent[0].to).toBe(agent.email);
      const office = s.dispatched.filter((d) => d.category === 'listing_expiry' && d.userId === handler.id);
      expect(office).toHaveLength(1);
      expect(office[0].channels).toEqual(['in_app', 'push']);
      expect(office[0].title).toContain('Listing expires today, not extended');
      // the status is not touched on the day itself - the automatic expiry comes the next morning
      expect((await tx.transaction_statuses.findFirst({ where: { transaction_id: t.id } }))?.status).toBe('Active');
    });
  });

  it('nothing for a listing that is not Active, or when the listing reminders are switched off', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const today = anchor();
      await listing(tx, agent, today, ['Sold']);
      const s = stubs();
      await sweepFor(tx, s).sweep(today);
      expect(s.sent.filter((m) => m.event === 'transaction.listing_expired')).toHaveLength(0);

      await listing(tx, agent, today, ['Active']);
      const now = new Date();
      await tx.company_settings.upsert({
        where: { id: 1 },
        create: { id: 1, feature_flags: JSON.stringify({ reminder_rules: { listing_expiry: { on: false } } }), created_at: now, updated_at: now } as never,
        update: { feature_flags: JSON.stringify({ reminder_rules: { listing_expiry: { on: false } } }) },
      });
      const off = stubs();
      await sweepFor(tx, off).sweep(today);
      expect(off.sent).toHaveLength(0);
    });
  });
});

describe('extended', () => {
  jest.setTimeout(60_000);

  it('the office hears when a listing\'s expiry is moved later, and by whom', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      const handler = await user(tx, 'documentation');
      const today = anchor();
      const t = await listing(tx, agent, today, ['Active'], { doc_handler_id: handler.id });
      const s = stubs();
      await sweepFor(tx, s).dateChanged(t.id, 'listing_expiry_date', dbDate(today), dbDate(day(today, 90)), agent.name);
      const msgs = s.dispatched.filter((d) => d.category === 'listing_expiry');
      expect(msgs.map((d) => d.userId)).toEqual([handler.id]);
      expect(msgs[0].title).toBe(`Listing extended - 3 Expiry Lane: expiry 2026-06-16 -> 2026-09-14, by ${agent.name}`);
    });
  });

  it('not when the date is brought earlier, set for the first time, a closing date, or not a listing', async () => {
    await inRollback(async (tx) => {
      const agent = await user(tx);
      await user(tx, 'documentation');
      const today = anchor();
      const t = await listing(tx, agent, today, ['Active']);
      const buying = await listing(tx, agent, today, ['Secured Firm'], { type: 'Residential Buying' });
      const s = stubs();
      const sweep = sweepFor(tx, s);
      await sweep.dateChanged(t.id, 'listing_expiry_date', dbDate(today), dbDate(day(today, -5)), 'X');
      await sweep.dateChanged(t.id, 'listing_expiry_date', null, dbDate(day(today, 30)), 'X');
      await sweep.dateChanged(t.id, 'closing_date', dbDate(today), dbDate(day(today, 30)), 'X');
      await sweep.dateChanged(buying.id, 'listing_expiry_date', dbDate(today), dbDate(day(today, 30)), 'X');
      expect(s.dispatched).toHaveLength(0);
    });
  });
});
