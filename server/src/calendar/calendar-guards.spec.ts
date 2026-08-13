import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from './calendar.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The rules that stop the Calendar leaking, clashing or crashing.
 *
 * Each of these was found on the running screen, not reasoned about. The deal link checked only
 * that a deal EXISTED, which let an agent read every address in the brokerage back out of a 201.
 * Two appointments at the same minute were both accepted in silence. A NUL byte in a title reached
 * the driver and came back as a 500.
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
const noopAudit = { record: async () => {} };
const noopGoogle = { pushEvent: async () => {}, updateEvent: async () => {}, removeEvent: async () => {} };
const svc = (tx: PrismaService) => new CalendarService(tx, noopAudit as never, noopGoogle as never);

async function makeUser(tx: PrismaService, role: string, name?: string): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: name ?? `Cal ${role} ${t}`, email: `cal-${t}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

const evt = (o: Record<string, unknown> = {}) => ({ title: `Ev ${tag()}`, date: '2026-09-15', time: '10:00', type: 'meeting', ...o });

describe('linking an event to a deal', () => {
  it('refuses a deal the agent has no part in, without saying it exists', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const now = new Date();
      const theirs = await tx.transactions.create({
        data: { trade_no: `T-${tag()}`, type: 'Residential Sale Listing', property: '9 Secret Lane', agent: 'Someone Else', created_at: now, updated_at: now },
      });

      await expect(svc(tx).create(evt({ transaction_id: theirs.id }), mine, 'crm'))
        .rejects.toMatchObject({ response: { message: 'That transaction does not exist.' } });
    });
  });

  it('allows the agent named on the deal', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const now = new Date();
      const own = await tx.transactions.create({
        data: { trade_no: `T-${tag()}`, type: 'Residential Sale Listing', property: '1 Own Street', agent: agent.name, created_at: now, updated_at: now },
      });

      const row = await svc(tx).create(evt({ transaction_id: own.id }), agent, 'crm');
      expect(row.transaction_id).toBe(own.id);
    });
  });

  it('still lets an administrator link any deal', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const now = new Date();
      const any = await tx.transactions.create({
        data: { trade_no: `T-${tag()}`, type: 'Residential Sale Listing', property: '5 Anywhere', agent: 'Another Agent', created_at: now, updated_at: now },
      });

      const row = await svc(tx).create(evt({ transaction_id: any.id }), admin, 'crm');
      expect(row.transaction_id).toBe(any.id);
    });
  });

  it('refuses a lead outside the agent\'s book', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const other = await makeUser(tx, 'agent');
      const now = new Date();
      const lead = await tx.leads.create({
        data: { name: `Lead ${tag()}`, email: `l-${tag()}@example.test`, owner_user_id: other.id, assigned_to: other.id, created_at: now, updated_at: now },
      });

      await expect(svc(tx).create(evt({ lead_id: lead.id }), mine, 'crm'))
        .rejects.toMatchObject({ response: { message: 'That lead does not exist.' } });
    });
  });
});

describe('overlapping appointments', () => {
  it('refuses a second appointment in the same slot', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ title: 'First viewing', time: '11:00', end_time: '12:00' }), user, 'crm');

      await expect(svc(tx).create(evt({ time: '11:30', end_time: '12:30' }), user, 'crm'))
        .rejects.toMatchObject({ response: { message: expect.stringContaining('overlaps "First viewing"') } });
    });
  });

  it('allows back-to-back appointments that only touch', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ time: '10:00', end_time: '11:00' }), user, 'crm');
      const second = await svc(tx).create(evt({ time: '11:00', end_time: '12:00' }), user, 'crm');
      expect(second.time).toBe('11:00');
    });
  });

  it('treats an event with no end time as a one-hour block', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ title: 'Open ended', time: '14:00' }), user, 'crm');

      // 14:30 lands inside the assumed 14:00–15:00 block.
      await expect(svc(tx).create(evt({ time: '14:30' }), user, 'crm')).rejects.toBeDefined();
      // 15:00 does not.
      const ok = await svc(tx).create(evt({ time: '15:00' }), user, 'crm');
      expect(ok.time).toBe('15:00');
    });
  });

  it('lets the user book anyway when they mean to', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ time: '09:00', end_time: '10:00' }), user, 'crm');
      const both = await svc(tx).create(evt({ time: '09:30', end_time: '10:30', allow_overlap: true }), user, 'crm');
      expect(both.time).toBe('09:30');
    });
  });

  it('does not clash with a cancelled appointment — the slot is free again', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ time: '13:00', end_time: '14:00', status: 'cancelled' }), user, 'crm');
      const ok = await svc(tx).create(evt({ time: '13:15', end_time: '14:15' }), user, 'crm');
      expect(ok.time).toBe('13:15');
    });
  });

  it('does not clash with another person\'s calendar', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const theirs = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ time: '16:00', end_time: '17:00' }), theirs, 'crm');
      const ok = await svc(tx).create(evt({ time: '16:00', end_time: '17:00' }), mine, 'crm');
      expect(ok.time).toBe('16:00');
    });
  });

  it('does not report an event as clashing with itself when it is edited', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt({ time: '08:00', end_time: '09:00' }), user, 'crm');
      const moved = await svc(tx).update(row.id as number, { time: '08:30', end_time: '09:30' }, user, 'crm');
      expect(moved.time).toBe('08:30');
    });
  });
});

describe('end time validation', () => {
  it('rejects an end before the start', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await expect(svc(tx).create(evt({ time: '15:00', end_time: '14:00' }), user, 'crm'))
        .rejects.toMatchObject({ response: { message: 'The end time must be after the start time.' } });
    });
  });

  it('rejects an end equal to the start', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await expect(svc(tx).create(evt({ time: '15:00', end_time: '15:00' }), user, 'crm')).rejects.toBeDefined();
    });
  });

  it('accepts a blank end time', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt({ end_time: '' }), user, 'crm');
      expect(row.end_time).toBeNull();
    });
  });
});

describe('recurring appointments', () => {
  const seriesOf = (tx: PrismaService, id: number) =>
    tx.calendar_events.findMany({ where: { recurrence_id: id, deleted_at: null }, orderBy: { date: 'asc' } });

  it('creates one appointment per occurrence', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const head = await svc(tx).create(
        evt({ title: 'Team meeting', date: '2026-09-07', time: '09:00', recur_freq: 'weekly', recur_count: 4 }),
        user, 'crm');

      const rows = await seriesOf(tx, head.id as number);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.date.toISOString().slice(0, 10)))
        .toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
      // Every occurrence is a full event — same title, same time — so everything that reads events
      // (reminders, the Google push, the month grid) sees them without knowing about recurrence.
      expect(rows.every((r) => r.title === 'Team meeting' && r.time === '09:00')).toBe(true);
      expect((head.recurrence as { occurrences: number }).occurrences).toBe(4);
    });
  });

  it('leaves a one-off alone', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt({ date: '2026-09-07' }), user, 'crm');
      expect(row.recurrence_id).toBeNull();
      expect(await tx.calendar_events.count({ where: { recurrence_id: row.id as number } })).toBe(0);
    });
  });

  it('refuses a repeat that would land on an existing appointment, before writing any of it', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ title: 'Existing', date: '2026-09-21', time: '09:00', end_time: '10:00' }), user, 'crm');

      const before = await tx.calendar_events.count({ where: { user_id: user.id } });
      await expect(svc(tx).create(
        evt({ title: 'Weekly', date: '2026-09-07', time: '09:00', end_time: '10:00', recur_freq: 'weekly', recur_count: 4 }),
        user, 'crm')).rejects.toMatchObject({ response: { message: expect.stringContaining('2026-09-21') } });

      // Nothing partial left behind.
      expect(await tx.calendar_events.count({ where: { user_id: user.id } })).toBe(before);
    });
  });

  it('books the whole repeat anyway when asked', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await svc(tx).create(evt({ title: 'Existing', date: '2026-09-21', time: '09:00', end_time: '10:00' }), user, 'crm');
      const head = await svc(tx).create(
        evt({ title: 'Weekly', date: '2026-09-07', time: '09:00', end_time: '10:00', recur_freq: 'weekly', recur_count: 4, allow_overlap: true }),
        user, 'crm');
      expect(await seriesOf(tx, head.id as number)).toHaveLength(4);
    });
  });

  it('edits only the occurrence you opened, by default', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const head = await svc(tx).create(
        evt({ title: 'Standing', date: '2026-09-07', time: '09:00', recur_freq: 'weekly', recur_count: 3 }), user, 'crm');
      const rows = await seriesOf(tx, head.id as number);

      await svc(tx).update(rows[1].id, { title: 'Moved just this one' }, user, 'crm');

      const after = await seriesOf(tx, head.id as number);
      expect(after.map((r) => r.title)).toEqual(['Standing', 'Moved just this one', 'Standing']);
    });
  });

  it('edits this occurrence and the later ones when asked — never the earlier ones', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const head = await svc(tx).create(
        evt({ title: 'Standing', date: '2026-09-07', time: '09:00', recur_freq: 'weekly', recur_count: 4 }), user, 'crm');
      const rows = await seriesOf(tx, head.id as number);

      // Change from the second onwards. The first already happened and must read as it did.
      await svc(tx).update(rows[1].id, { title: 'Renamed' }, user, 'crm', 'series');

      const after = await seriesOf(tx, head.id as number);
      expect(after.map((r) => r.title)).toEqual(['Standing', 'Renamed', 'Renamed', 'Renamed']);
      // Each occurrence keeps its own day — a series edit must not collapse them onto one date.
      expect(after.map((r) => r.date.toISOString().slice(0, 10)))
        .toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    });
  });

  it('deletes only the occurrence you opened, by default', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const head = await svc(tx).create(
        evt({ date: '2026-09-07', time: '09:00', recur_freq: 'weekly', recur_count: 3 }), user, 'crm');
      const rows = await seriesOf(tx, head.id as number);

      await svc(tx).remove(rows[1].id, user, 'crm');
      expect(await seriesOf(tx, head.id as number)).toHaveLength(2);
    });
  });

  it('deletes this occurrence and the later ones when asked', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const head = await svc(tx).create(
        evt({ date: '2026-09-07', time: '09:00', recur_freq: 'weekly', recur_count: 4 }), user, 'crm');
      const rows = await seriesOf(tx, head.id as number);

      const out = await svc(tx).remove(rows[1].id, user, 'crm', 'series');
      expect(out.series_deleted).toBe(2);   // the two after the one opened

      const left = await seriesOf(tx, head.id as number);
      expect(left).toHaveLength(1);
      expect(left[0].date.toISOString().slice(0, 10)).toBe('2026-09-07');   // the past one survives
    });
  });

  it('rejects a repeat rule it does not understand', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await expect(svc(tx).create(evt({ recur_freq: 'fortnightly' }), user, 'crm')).rejects.toBeDefined();
      await expect(svc(tx).create(evt({ recur_freq: 'weekly', recur_interval: 0 }), user, 'crm')).rejects.toBeDefined();
      await expect(svc(tx).create(evt({ recur_freq: 'weekly', recur_count: -2 }), user, 'crm')).rejects.toBeDefined();
      await expect(svc(tx).create(evt({ recur_freq: 'weekly', recur_until: '07-09-2026' }), user, 'crm')).rejects.toBeDefined();
    });
  });
});

describe('two people editing the same event', () => {
  it('refuses the save that was composed against an older version', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt({ title: 'Original' }), user, 'crm');
      const id = row.id as number;
      expect(row.version).toBe(1);

      // Both people opened the editor while it was at version 1.
      await svc(tx).update(id, { title: 'Saved by A', version: 1 }, user, 'crm');

      await expect(svc(tx).update(id, { title: 'Saved by B', version: 1 }, user, 'crm'))
        .rejects.toMatchObject({ response: { conflict: { current_version: 2, your_version: 1 } } });

      // A's work is still there — which is the whole point.
      const after = await tx.calendar_events.findUnique({ where: { id } });
      expect(after?.title).toBe('Saved by A');
      expect(after?.version).toBe(2);
    });
  });

  it('lets the second person save once they have re-read it', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt(), user, 'crm');
      const id = row.id as number;

      await svc(tx).update(id, { title: 'A', version: 1 }, user, 'crm');
      const fresh = await svc(tx).get(id, user, 'crm');
      const done = await svc(tx).update(id, { title: 'B', version: fresh.version as number }, user, 'crm');

      expect(done.title).toBe('B');
      expect(done.version).toBe(3);
    });
  });

  it('still saves when no version is sent, so older callers keep working', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt(), user, 'crm');
      const done = await svc(tx).update(row.id as number, { title: 'no version' }, user, 'crm');
      expect(done.title).toBe('no version');
      expect(done.version).toBe(2);
    });
  });

  it('rejects a version that is not a positive whole number', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt(), user, 'crm');
      await expect(svc(tx).update(row.id as number, { title: 'x', version: 0 }, user, 'crm')).rejects.toBeDefined();
      await expect(svc(tx).update(row.id as number, { title: 'x', version: 'abc' }, user, 'crm')).rejects.toBeDefined();
    });
  });
});

describe('hostile input', () => {
  it('does not turn a NUL byte into a 500', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      const row = await svc(tx).create(evt({ title: `ok${String.fromCharCode(0)}bad` }), user, 'crm');
      expect(row.title).toBe('okbad');
    });
  });

  it('still rejects a title that was nothing but control characters', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'agent');
      await expect(svc(tx).create(evt({ title: String.fromCharCode(0, 1, 2) }), user, 'crm'))
        .rejects.toMatchObject({ response: { message: 'A title is required.' } });
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
