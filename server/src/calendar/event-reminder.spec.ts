import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EventReminderService } from './event-reminder.service';

/**
 * Appointment reminders.
 *
 * The checkbox existed for months and sent nothing, so the first thing worth pinning is that a
 * reminder goes out at all. The rest is the behaviour that separates a reminder people trust from
 * one they learn to ignore: it arrives once, it does not arrive for an appointment that was called
 * off, and a mail server having a bad evening does not lose it.
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

const stubs = (fail?: () => Error) => {
  const sent: { to: string; vars: Record<string, unknown> }[] = [];
  const pushed: { userId: number; title: string }[] = [];
  return {
    sent,
    pushed,
    mailer: { send: async (_k: string, vars: Record<string, unknown>, to: string) => { if (fail) throw fail(); sent.push({ to, vars }); } },
    settings: { current: async () => ({ name: 'Test Brokerage' }) },
    // Push is the extra, not the record — the tests below are about the email, so this simply
    // notes what it was asked to send. Its own behaviour is covered in web-push.spec.ts.
    push: {
      sendToUser: async (userId: number, payload: { title: string }) => {
        pushed.push({ userId, title: payload.title });
        return { sent: 0, failed: 0, removed: 0 };
      },
    },
  };
};

const svcFor = (tx: PrismaService, s: ReturnType<typeof stubs>) =>
  new EventReminderService(tx, s.mailer as never, s.settings as never, s.push as never);

async function makeUser(tx: PrismaService, email: string | null = null) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `Cal User ${t}`, email: email ?? `cal-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

/** An appointment `minutesAhead` from `now`, as the calendar stores one: a day plus HH:MM. */
async function makeEvent(tx: PrismaService, userId: number, now: Date, minutesAhead: number, over: Record<string, unknown> = {}) {
  const at = new Date(now.getTime() + minutesAhead * 60 * 1000);
  const date = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()));
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const ts = new Date();
  return tx.calendar_events.create({
    data: {
      title: `Showing ${tag()}`, date, time, type: 'showing', status: 'scheduled',
      enable_reminder: true, user_id: userId, domain: 'crm', created_at: ts, updated_at: ts,
      ...over,
    },
  });
}

const remindersFor = (tx: PrismaService, eventId: number) =>
  tx.calendar_event_reminders.findMany({ where: { calendar_event_id: eventId }, orderBy: { lead_minutes: 'desc' } });

const transient = (): Error => Object.assign(new Error('Connection timed out'), { responseCode: 451 });
const permanent = (): Error => Object.assign(new Error('550 no such recipient'), { responseCode: 550 });

describe('sending an appointment reminder', () => {
  it('emails the owner an hour before', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      const s = stubs();
      const result = await svcFor(tx, s).sweep(now);

      expect(result.sent).toBe(1);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].to).toBe(user.email);
      expect(s.sent[0].vars.when_phrase).toBe('in 1 hour');
      expect(s.sent[0].vars.event_title).toBe(ev.title);
    });
  });

  it('sends the day-before notice as well, as its own reminder', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 20 * 60);   // inside 24h, outside 1h

      await svcFor(tx, stubs()).sweep(now);
      const rows = await remindersFor(tx, ev.id);
      expect(rows.map((r) => r.lead_minutes)).toEqual([1440]);
      expect(rows[0].delivery_status).toBe('Sent');
    });
  });

  it('does not send the same reminder twice, however often the sweep runs', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      const s = stubs();
      const svc = svcFor(tx, s);
      await svc.sweep(now);
      await svc.sweep(now);
      await svc.sweep(now);

      expect(s.sent).toHaveLength(1);
      expect(await remindersFor(tx, ev.id)).toHaveLength(1);
    });
  });

  it('marks the event so the old flag stops being a lie', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      await svcFor(tx, stubs()).sweep(now);
      expect((await tx.calendar_events.findUnique({ where: { id: ev.id } }))?.reminder_sent).toBe(true);
    });
  });
});

describe('when a reminder should not be sent', () => {
  it('ignores an event nobody asked to be reminded about', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45, { enable_reminder: false });

      const s = stubs();
      await svcFor(tx, s).sweep(now);
      expect(s.sent).toHaveLength(0);
      expect(await remindersFor(tx, ev.id)).toHaveLength(0);
    });
  });

  it('ignores a cancelled appointment', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45, { status: 'cancelled' });

      const s = stubs();
      await svcFor(tx, s).sweep(now);
      expect(s.sent).toHaveLength(0);
      expect(await remindersFor(tx, ev.id)).toHaveLength(0);
    });
  });

  it('ignores a deleted appointment', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45, { deleted_at: new Date() });

      const s = stubs();
      await svcFor(tx, s).sweep(now);
      expect(s.sent).toHaveLength(0);
      expect(await remindersFor(tx, ev.id)).toHaveLength(0);
    });
  });

  it('does not chase an appointment that has already started', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, -30);

      const s = stubs();
      await svcFor(tx, s).sweep(now);
      expect(s.sent).toHaveLength(0);
      expect(await remindersFor(tx, ev.id)).toHaveLength(0);
    });
  });

  it('records why, when the owner has no email to send to', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      await tx.users.update({ where: { id: user.id }, data: { email: '' } });
      const ev = await makeEvent(tx, user.id, now, 45);

      const s = stubs();
      const result = await svcFor(tx, s).sweep(now);
      expect(result.skipped).toBe(1);
      expect(s.sent).toHaveLength(0);
      const [row] = await remindersFor(tx, ev.id);
      expect(row.delivery_status).toBe('Skipped');
      expect(row.detail).toContain('No email on file');
    });
  });
});

describe('when delivery fails', () => {
  it('schedules another attempt after a transient failure', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      await svcFor(tx, stubs(transient)).sweep(now);
      const [row] = await remindersFor(tx, ev.id);
      expect(row.delivery_status).toBe('Failed');
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).toBeTruthy();
      expect(row.detail).toContain('trying again later');
    });
  });

  it('does not chase a rejected address', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      await svcFor(tx, stubs(permanent)).sweep(now);
      const [row] = await remindersFor(tx, ev.id);
      expect(row.delivery_status).toBe('Failed');
      expect(row.next_retry_at).toBeNull();
      expect(row.detail).toContain('not retried');
    });
  });

  it('gets through on the retry, and stops chasing once it has', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      await svcFor(tx, stubs(transient)).sweep(now);
      const [failed] = await remindersFor(tx, ev.id);
      await tx.calendar_event_reminders.update({ where: { id: failed.id }, data: { next_retry_at: new Date(now.getTime() - 1000) } });

      const working = stubs();
      const result = await svcFor(tx, working).sweep(now);
      expect(result.retried).toBe(1);
      expect(working.sent).toHaveLength(1);
      const [after] = await remindersFor(tx, ev.id);
      expect(after.delivery_status).toBe('Sent');
      expect(after.next_retry_at).toBeNull();
    });
  });

  it('stops chasing when the appointment was cancelled while the retry waited', async () => {
    await inRollback(async (tx) => {
      const now = new Date('2026-09-10T09:00:00');
      const user = await makeUser(tx);
      const ev = await makeEvent(tx, user.id, now, 45);

      await svcFor(tx, stubs(transient)).sweep(now);
      const [failed] = await remindersFor(tx, ev.id);
      await tx.calendar_event_reminders.update({ where: { id: failed.id }, data: { next_retry_at: new Date(now.getTime() - 1000) } });
      await tx.calendar_events.update({ where: { id: ev.id }, data: { status: 'cancelled' } });

      const working = stubs();
      await svcFor(tx, working).sweep(now);
      expect(working.sent).toHaveLength(0);
      const [after] = await remindersFor(tx, ev.id);
      expect(after.delivery_status).toBe('Skipped');
      expect(after.detail).toContain('No longer applicable');
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
