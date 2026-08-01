import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CalendarAnalyticsService } from './calendar-analytics.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * What the calendar reports about itself.
 *
 * The figures that matter are the rates, and the way a rate goes wrong is its denominator: counting
 * still-scheduled appointments would make every rate sag as the diary fills with future work, which
 * says nothing about how the past went.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const svc = (tx: PrismaService) => new CalendarAnalyticsService(tx);

async function makeUser(tx: PrismaService): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `An User ${t}`, email: `an-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

async function makeEvent(tx: PrismaService, userId: number, date: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.calendar_events.create({
    data: {
      title: `Ev ${tag()}`, date: new Date(`${date}T00:00:00.000Z`), time: '10:00',
      type: 'showing', status: 'scheduled', user_id: userId, domain: 'crm', company_id: 1,
      created_at: now, updated_at: now, ...over,
    },
  });
}

const RANGE = ['2026-06-01', '2026-06-30'] as const;

describe('counting what happened', () => {
  it('counts each status separately', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-02', { status: 'completed' });
      await makeEvent(tx, u.id!, '2026-06-03', { status: 'completed' });
      await makeEvent(tx, u.id!, '2026-06-04', { status: 'cancelled' });
      await makeEvent(tx, u.id!, '2026-06-05', { status: 'no-show' });
      await makeEvent(tx, u.id!, '2026-06-06', { status: 'scheduled' });

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      expect(a.totals).toMatchObject({ total: 5, completed: 2, cancelled: 1, no_show: 1, scheduled: 1 });
    });
  });

  it('computes rates over settled appointments, not the whole diary', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-02', { status: 'completed' });
      await makeEvent(tx, u.id!, '2026-06-03', { status: 'completed' });
      await makeEvent(tx, u.id!, '2026-06-04', { status: 'no-show' });
      await makeEvent(tx, u.id!, '2026-06-05', { status: 'cancelled' });
      // Four settled. These two are still to come and must not drag the rates down.
      await makeEvent(tx, u.id!, '2026-06-20', { status: 'scheduled' });
      await makeEvent(tx, u.id!, '2026-06-21', { status: 'scheduled' });

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      expect(a.rates.settled).toBe(4);
      expect(a.rates.completion).toBe(50);
      expect(a.rates.no_show).toBe(25);
      expect(a.rates.cancellation).toBe(25);
    });
  });

  it('reports no rate at all when nothing has settled', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-10', { status: 'scheduled' });

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      // Null, not zero. "0% kept" would read as every appointment being missed.
      expect(a.rates.completion).toBeNull();
      expect(a.rates.no_show).toBeNull();
      expect(a.rates.settled).toBe(0);
    });
  });
});

describe('when the work happens', () => {
  it('puts each appointment on the right weekday', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      // 1 June 2026 is a Monday.
      await makeEvent(tx, u.id!, '2026-06-01');
      await makeEvent(tx, u.id!, '2026-06-08');
      await makeEvent(tx, u.id!, '2026-06-06');   // Saturday

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      const byDay = Object.fromEntries(a.by_weekday.map((d) => [d.day, d.total]));
      expect(byDay.Monday).toBe(2);
      expect(byDay.Saturday).toBe(1);
      expect(a.busiest.weekday).toBe('Monday');
      // Every weekday is listed even at zero — "nothing on Sundays" is a finding.
      expect(a.by_weekday).toHaveLength(7);
    });
  });

  it('groups by hour and names the fullest single day', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-09', { time: '09:00' });
      await makeEvent(tx, u.id!, '2026-06-09', { time: '09:30' });
      await makeEvent(tx, u.id!, '2026-06-10', { time: '14:00' });

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      expect(a.by_hour).toEqual([{ hour: '09:00', total: 2 }, { hour: '14:00', total: 1 }]);
      expect(a.busiest.hour).toBe('09:00');
      expect(a.busiest.date).toBe('2026-06-09');
      expect(a.busiest.date_count).toBe(2);
    });
  });

  it('breaks the outcome down by kind of appointment', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-02', { type: 'showing', status: 'completed' });
      await makeEvent(tx, u.id!, '2026-06-03', { type: 'showing', status: 'no-show' });
      await makeEvent(tx, u.id!, '2026-06-04', { type: 'closing', status: 'completed' });

      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      const showing = a.by_type.find((x) => x.type === 'showing');
      expect(showing).toMatchObject({ total: 2, completed: 1, no_show: 1, label: 'Showing' });
      expect(a.by_type.find((x) => x.type === 'closing')).toMatchObject({ total: 1, completed: 1 });
    });
  });
});

describe('what it refuses to count', () => {
  it('ignores appointments outside the range', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-15');
      await makeEvent(tx, u.id!, '2026-05-31');   // the day before
      await makeEvent(tx, u.id!, '2026-07-01');   // the day after

      expect((await svc(tx).summary(u, 'crm', ...RANGE)).totals.total).toBe(1);
    });
  });

  it('ignores a deleted appointment', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-15');
      await makeEvent(tx, u.id!, '2026-06-16', { deleted_at: new Date() });

      expect((await svc(tx).summary(u, 'crm', ...RANGE)).totals.total).toBe(1);
    });
  });

  it('never reports on somebody else\'s diary', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await makeEvent(tx, mine.id!, '2026-06-15');
      await makeEvent(tx, theirs.id!, '2026-06-16');
      await makeEvent(tx, theirs.id!, '2026-06-17');

      expect((await svc(tx).summary(mine, 'crm', ...RANGE)).totals.total).toBe(1);
    });
  });

  it('reports on one area at a time', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await makeEvent(tx, u.id!, '2026-06-15', { domain: 'crm' });
      await makeEvent(tx, u.id!, '2026-06-16', { domain: 'desk' });

      expect((await svc(tx).summary(u, 'crm', ...RANGE)).totals.total).toBe(1);
      expect((await svc(tx).summary(u, 'desk', ...RANGE)).totals.total).toBe(1);
    });
  });

  it('returns an empty report rather than failing on an empty diary', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const a = await svc(tx).summary(u, 'crm', ...RANGE);
      expect(a.totals.total).toBe(0);
      expect(a.busiest.weekday).toBeNull();
      expect(a.by_weekday).toHaveLength(7);
      expect(a.by_type).toEqual([]);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
