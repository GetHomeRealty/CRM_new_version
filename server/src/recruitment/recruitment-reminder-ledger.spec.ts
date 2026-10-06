import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { PermissionService } from '../auth/permission.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import { RecruitmentInterviewNotifyService } from './recruitment-interview-notify.service';
import { RecruitmentInterviewReminderService } from './recruitment-interview-reminder.service';

/**
 * DUPLICATE PREVENTION, AGAINST THE REAL LEDGER AND THE REAL UNIQUE INDEX.
 *
 * The other reminder spec proves which occurrence a key NAMES, using a stub that behaves the way
 * the ledger is supposed to. That is a test of this module's arithmetic, and it would keep passing
 * if the index were dropped tomorrow — the stub would still refuse the second claim, and nothing
 * would say the guarantee had gone.
 *
 * So this file uses the REAL `NotificationDispatcher`, writing to the REAL
 * `notification_deliveries` table, and asserts the constraint itself at the end by trying to insert
 * a duplicate by hand. If `notification_deliveries_identity_key` is removed, this file fails.
 *
 * THESE TESTS COMMIT. The ledger is claimed before a send, so a rolled-back transaction could not
 * demonstrate a second pass being refused by the first. Everything written is removed afterwards —
 * deliveries and notifications both cascade from the user row.
 *
 * EMAIL AND PUSH CANNOT DELIVER HERE, by construction: the dispatcher resolves those senders
 * lazily through `ModuleRef`, and the stub below has none to give, so it logs and records them as
 * undeliverable. The CLAIM still happens for every channel, which is the part under test — the
 * ledger records the occurrence whatever becomes of the sending.
 */

const prisma = new PrismaClient();

/** A ModuleRef with nothing in it. `resolve()` catches the throw and the channel cannot deliver. */
const emptyModuleRef = {
  get: () => { throw new Error('no provider in this test'); },
} as never;

const dispatcher = new NotificationDispatcher(
  prisma as unknown as PrismaService,
  new NotificationPreferenceService(prisma as unknown as PrismaService),
  emptyModuleRef,
);
const permissions = new PermissionService();
const notify = new RecruitmentInterviewNotifyService(
  prisma as unknown as PrismaService, dispatcher, permissions,
);
const sweep = new RecruitmentInterviewReminderService(prisma as unknown as PrismaService, notify);

const CATEGORY = 'recruitment_interview_reminder';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const made: { candidates: number[]; users: number[] } = { candidates: [], users: [] };

async function recruiter(): Promise<number> {
  const t = tag();
  const row = await prisma.users.create({
    data: {
      name: `ZZ Ledger ${t}`, email: `zz-ledger-${t}@probe.test`, role: 'recruiter',
      status: 'Active', password: 'x', created_at: new Date(), updated_at: new Date(),
    },
  });
  made.users.push(row.id);
  return row.id;
}

async function booked(minutesAhead: number, recruiterId: number) {
  const t = tag();
  const c = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Ledger Cand ${t}`, email: `zz-ledger-cand-${t}@probe.test`, status: 'contacted',
      assigned_recruiter_id: recruiterId, created_at: new Date(), updated_at: new Date(),
    },
  });
  made.candidates.push(c.id);
  const iv = await prisma.recruitment_interviews.create({
    data: {
      candidate_id: c.id, status: 'scheduled',
      scheduled_at: new Date(Date.now() + minutesAhead * 60_000),
      created_at: new Date(), updated_at: new Date(),
    },
  });
  return { candidate: c, interview: iv };
}

const ledgerFor = (userId: number) =>
  prisma.notification_deliveries.findMany({
    where: { user_id: userId, category: CATEGORY },
    select: { channel: true, dedupe_key: true, status: true },
    orderBy: { id: 'asc' },
  });

afterEach(async () => {
  // Deliveries and in-app notifications cascade from the user; candidates cascade their children.
  if (made.candidates.length) {
    await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.candidates } } });
  }
  if (made.users.length) await prisma.users.deleteMany({ where: { id: { in: made.users } } });
  made.candidates = [];
  made.users = [];
});

afterAll(async () => { await prisma.$disconnect(); });

describe('the ledger, not a stand-in for it', () => {
  it('writes ONE claim per channel for one occurrence, however many passes run', async () => {
    const who = await recruiter();
    const { interview } = await booked(24 * 60, who);

    await sweep.run();
    await sweep.run();
    await sweep.run();

    const rows = await ledgerFor(who);
    const keys = [...new Set(rows.map((r) => r.dedupe_key))];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`:${interview.id}:`);
    expect(keys[0]).toContain('1440');

    // One row per channel, and no channel claimed twice.
    const perChannel = new Map<string, number>();
    for (const r of rows) perChannel.set(r.channel, (perChannel.get(r.channel) ?? 0) + 1);
    for (const [channel, n] of perChannel) {
      expect({ channel, n }).toEqual({ channel, n: 1 });
    }
  });

  it('the person is shown the reminder once, not three times', async () => {
    // The ledger is the mechanism; this is the thing the recruiter actually experiences.
    const who = await recruiter();
    await booked(24 * 60, who);

    await sweep.run();
    await sweep.run();

    const inApp = await prisma.notifications.findMany({ where: { user_id: who } });
    expect(inApp).toHaveLength(1);
    expect(String(inApp[0].title)).toContain('Interview in 24 hours');
  });

  it('CONCURRENT PASSES claim once, settled by the database rather than by timing', async () => {
    /*
     * Two sweeps genuinely in flight together — a slow pass overlapped by the next tick, or two
     * worker processes if `RUN_SCHEDULERS` were ever true on both. Nothing in the application
     * serialises them; the unique index is what decides, and it decides once.
     */
    const who = await recruiter();
    await booked(24 * 60, who);

    await Promise.all([sweep.run(), sweep.run(), sweep.run()]);

    /*
     * JUDGED ON THIS PERSON'S LEDGER, NOT ON WHAT `run()` RETURNED.
     *
     * That return value is a GLOBAL count of everything the pass delivered. Under the real gate
     * these suites run in parallel against one database, so another file's fixture is due in the
     * same window and a second pass legitimately returns a non-zero count — for a DIFFERENT
     * interview, for a DIFFERENT person. Counting passes therefore proved nothing about this
     * occurrence, and failed as soon as the suites ran together.
     *
     * The guarantee under test is narrower and stronger: this identity was delivered exactly once.
     * The rows below are scoped to a user created by this test, so nothing else can reach them.
     */
    expect(await prisma.notifications.count({ where: { user_id: who } })).toBe(1);

    const perChannel = new Map<string, number>();
    for (const r of await ledgerFor(who)) perChannel.set(r.channel, (perChannel.get(r.channel) ?? 0) + 1);
    for (const [channel, n] of perChannel) expect({ channel, n }).toEqual({ channel, n: 1 });

    const rows = await ledgerFor(who);
    expect([...new Set(rows.map((r) => r.dedupe_key))]).toHaveLength(1);
  });

  it('a rescheduled interview is a NEW occurrence, and is delivered again', async () => {
    /*
     * The other half of the guarantee. Dedupe must not be so eager that moving an interview leaves
     * everybody un-warned — which is exactly what a key naming only the interview would do.
     */
    const who = await recruiter();
    const { interview } = await booked(24 * 60, who);

    await sweep.run();
    expect(await prisma.notifications.count({ where: { user_id: who } })).toBe(1);

    await prisma.recruitment_interviews.update({
      where: { id: interview.id },
      data: { scheduled_at: new Date(Date.now() + 24 * 60 * 60_000 - 10 * 60_000) },
    });
    await sweep.run();

    expect(await prisma.notifications.count({ where: { user_id: who } })).toBe(2);
    expect([...new Set((await ledgerFor(who)).map((r) => r.dedupe_key))]).toHaveLength(2);
  });

  it('THE UNIQUE INDEX IS REALLY THERE — a hand-written duplicate is refused', async () => {
    /*
     * The assertion that makes every test above mean something. Without it they would all still
     * pass on a database where the constraint had been dropped, because the application would
     * simply never be asked to write the second row twice in the same instant.
     */
    const who = await recruiter();
    await booked(24 * 60, who);
    await sweep.run();

    const existing = (await ledgerFor(who))[0];
    expect(existing).toBeTruthy();

    await expect(prisma.notification_deliveries.create({
      data: {
        user_id: who,
        category: CATEGORY,
        dedupe_key: existing.dedupe_key,
        channel: existing.channel,
        status: 'sent',
        created_at: new Date(),
        updated_at: new Date(),
      },
    })).rejects.toThrow(/Unique constraint|notification_deliveries_identity_key/i);
  });

  it('two different people each get their own claim for the same interview', async () => {
    // The key identifies the occurrence; the row identifies the occurrence FOR A PERSON. Deduping
    // across people would silence the interviewer because the recruiter had already been told.
    const first = await recruiter();
    const second = await recruiter();
    const { candidate, interview } = await booked(24 * 60, first);
    await prisma.recruitment_interviews.update({
      where: { id: interview.id }, data: { interviewer_id: second },
    });
    expect(candidate.id).toBeGreaterThan(0);

    await sweep.run();
    await sweep.run();

    expect(await prisma.notifications.count({ where: { user_id: first } })).toBe(1);
    expect(await prisma.notifications.count({ where: { user_id: second } })).toBe(1);
  });
});
