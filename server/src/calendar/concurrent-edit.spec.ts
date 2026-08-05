import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from './calendar.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * PRIORITY 3 — CONCURRENCY. Two people editing one calendar event at the same moment.
 *
 * WHY THIS CANNOT USE THE ROLLED-BACK-TRANSACTION FIXTURE every other spec here uses. Two writes
 * inside one transaction are not concurrent — they are sequential, and the second sees the first.
 * The race only exists between two connections, so these tests write real rows and delete them in a
 * `finally`. Everything they create is prefixed `ZZCONC` and dated in a month no other spec uses.
 *
 * WHAT THE MODULE ALREADY HAS. `calendar_events.version`, sent back by the editor and compared on
 * save, with a 409 carrying the current version. That covers the ordinary case — someone saved while
 * your form was open — and `update()`'s own comment is candid about the limit: *"two saves racing
 * past the check above still end on different versions."* The bump is atomic; the CHECK is a
 * separate read, so under read-committed both requests can pass it before either writes.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;
const DAY = '2026-12-09';   // a month no other spec probes

afterAll(async () => { await prisma.$disconnect(); });

const asUser = (id: number, name: string) => ({ id, name, role: 'agent' } as unknown as AuthUserRecord);

/** The service, wired to the real Prisma client with the outbound integrations stubbed out. */
function service(): CalendarService {
  // (prisma, audit, googleSync) — the audit writer and the Google mirror are both fire-and-forget
  // here, so stubs keep the test off the network without changing the path under test.
  const noAudit = { log: async () => undefined, record: async () => undefined } as never;
  const noGoogle = { createEvent: async () => undefined, updateEvent: async () => undefined, deleteEvent: async () => undefined } as never;
  return new CalendarService(prisma as unknown as PrismaService, noAudit, noGoogle);
}

async function makeUser(name: string) {
  const now = new Date();
  const t = tag();
  return prisma.users.create({
    data: {
      name: `ZZCONC ${name} ${t}`, email: `zzconc-${name}-${t}@probe.test`, role: 'agent',
      status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

async function makeEvent(userId: number) {
  const now = new Date();
  return prisma.calendar_events.create({
    data: {
      user_id: userId, title: `ZZCONC event ${tag()}`, date: new Date(`${DAY}T00:00:00.000Z`),
      time: '10:00', type: 'showing', status: 'scheduled', domain: 'crm', version: 1,
      company_id: 1, created_at: now, updated_at: now,
    },
    select: { id: true, version: true },
  });
}

async function cleanUp(ids: { events: number[]; users: number[] }) {
  if (ids.events.length) await prisma.calendar_events.deleteMany({ where: { id: { in: ids.events } } }).catch(() => undefined);
  if (ids.users.length) await prisma.users.deleteMany({ where: { id: { in: ids.users } } }).catch(() => undefined);
}

describe('two people editing the same event', () => {
  it('the SEQUENTIAL case is refused with a 409 — the protection that already existed', async () => {
    const ids = { events: [] as number[], users: [] as number[] };
    try {
      const owner = await makeUser('owner');
      ids.users.push(owner.id);
      const ev = await makeEvent(owner.id);
      ids.events.push(ev.id);
      const me = asUser(owner.id, owner.name);

      // Both editors opened the form on version 1. The first saves.
      await service().update(ev.id, { title: 'First writer', version: 1, allow_overlap: true }, me, 'crm');

      // The second still holds version 1.
      const err = await service()
        .update(ev.id, { title: 'Second writer', version: 1, allow_overlap: true }, me, 'crm')
        .then(() => null, (e: { getStatus?: () => number; response?: unknown }) => e);

      expect(err?.getStatus?.()).toBe(409);
      const after = await prisma.calendar_events.findUnique({ where: { id: ev.id }, select: { title: true } });
      expect(after?.title).toBe('First writer');
    } finally { await cleanUp(ids); }
  });

  it('SIMULTANEOUS saves do not both apply', async () => {
    /*
     * THE ONE THE VERSION CHECK DOES NOT COVER BY ITSELF.
     *
     * `update()` reads the row, compares `version`, and only then issues the UPDATE. Under
     * read-committed both requests can complete the read before either writes, so both see version 1,
     * both pass, and both write — the second silently erasing the first. The version column still
     * ends at 3, so the damage is *detectable afterwards*; nobody is *told* at the time, which is
     * exactly what the 409 exists to prevent.
     *
     * Driven from two connections and started together, because sequencing them tests the case above
     * instead of this one.
     */
    const ids = { events: [] as number[], users: [] as number[] };
    try {
      const owner = await makeUser('owner');
      ids.users.push(owner.id);
      const ev = await makeEvent(owner.id);
      ids.events.push(ev.id);
      const me = asUser(owner.id, owner.name);

      const results = await Promise.allSettled([
        service().update(ev.id, { title: 'Writer A', version: 1, allow_overlap: true }, me, 'crm'),
        service().update(ev.id, { title: 'Writer B', version: 1, allow_overlap: true }, me, 'crm'),
      ]);

      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const conflicts = results.filter(
        (r) => r.status === 'rejected' && (r.reason as { getStatus?: () => number })?.getStatus?.() === 409,
      ).length;

      // Exactly one may win, and the loser must be TOLD — a 409, not a silent success.
      expect(ok).toBe(1);
      expect(conflicts).toBe(1);
    } finally { await cleanUp(ids); }
  });

  it('the winner\'s value is the one that is stored', async () => {
    // A conflict that refuses both, or leaves a half-applied row, would be a worse answer than the
    // silent overwrite it replaces.
    const ids = { events: [] as number[], users: [] as number[] };
    try {
      const owner = await makeUser('owner');
      ids.users.push(owner.id);
      const ev = await makeEvent(owner.id);
      ids.events.push(ev.id);
      const me = asUser(owner.id, owner.name);

      const results = await Promise.allSettled([
        service().update(ev.id, { title: 'Writer A', version: 1, allow_overlap: true }, me, 'crm'),
        service().update(ev.id, { title: 'Writer B', version: 1, allow_overlap: true }, me, 'crm'),
      ]);
      const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Record<string, unknown>>;
      expect(winner).toBeTruthy();

      const after = await prisma.calendar_events.findUnique({ where: { id: ev.id }, select: { title: true, version: true } });
      expect(after?.title).toBe(winner.value.title);
      // ONE save applied, so exactly one bump. Version 3 here means both writes landed, which is how
      // the race was caught: this assertion failed before the write-side check existed.
      expect(after?.version).toBe(2);
    } finally { await cleanUp(ids); }
  });

  it('a caller that sends no version still saves — older clients are not broken', async () => {
    /*
     * Deliberate, and documented on `update()`: a link, a script or an older client must not start
     * failing. It is the cost of making the guard opt-in, and it is worth pinning so that tightening
     * the race above cannot quietly close this door too.
     */
    const ids = { events: [] as number[], users: [] as number[] };
    try {
      const owner = await makeUser('owner');
      ids.users.push(owner.id);
      const ev = await makeEvent(owner.id);
      ids.events.push(ev.id);
      const me = asUser(owner.id, owner.name);

      await service().update(ev.id, { title: 'Bumped by someone else', version: 1, allow_overlap: true }, me, 'crm');
      // No `version` at all, against a row that has moved on.
      await expect(
        service().update(ev.id, { title: 'Versionless', allow_overlap: true }, me, 'crm'),
      ).resolves.toMatchObject({ title: 'Versionless' });
    } finally { await cleanUp(ids); }
  });

  it('a malformed version is refused before anything is written', async () => {
    const ids = { events: [] as number[], users: [] as number[] };
    try {
      const owner = await makeUser('owner');
      ids.users.push(owner.id);
      const ev = await makeEvent(owner.id);
      ids.events.push(ev.id);
      const me = asUser(owner.id, owner.name);

      for (const bad of ['abc', 0, -1, 1.5]) {
        const err = await service()
          .update(ev.id, { title: 'nope', version: bad, allow_overlap: true }, me, 'crm')
          .then(() => null, (e: { getStatus?: () => number }) => e);
        expect(err?.getStatus?.()).toBe(400);
      }
      const after = await prisma.calendar_events.findUnique({ where: { id: ev.id }, select: { version: true } });
      expect(after?.version).toBe(1);
    } finally { await cleanUp(ids); }
  });
});
