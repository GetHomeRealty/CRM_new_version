import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CalendarService } from './calendar.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * A calendar appointment comes back on the day and at the time it was entered.
 *
 * WHY THIS EXISTS WITHOUT A FIX BESIDE IT. An end-to-end report raised, as a P2, that an event
 * entered for 2026-09-02 at 10:00 "saved and displayed as 2026-09-01 15:30", and asked for the
 * timezone/date serialisation to be corrected. It was reproduced here before anything was changed,
 * and the round trip is exact - in America/Toronto, where the report was written, and in a zone
 * ahead of UTC, where a date shift would show up most readily. Nothing was corrected because
 * nothing was wrong.
 *
 * WHAT THE REPORTED VALUES ACTUALLY ARE. `2026-09-01` was the date of the test, and `15:30` is what
 * `nextHalfHour()` returns - the editor's default time, which by construction is always :00 or :30.
 * So the pair reported is precisely the form's UNTOUCHED DEFAULTS, which is what a save produces
 * when the typed values never reached React state: setting `value` on a controlled input without
 * dispatching an input event leaves the component holding its defaults, and automation does that
 * routinely.
 *
 * THE DESIGN IS TIMEZONE-SAFE BY CONSTRUCTION, and these tests pin each half of it:
 *
 *   - the wire carries `date` and `time` as separate plain strings, with no offset to misread;
 *   - `date` is a `@db.Date` column - a calendar day, not an instant - and `time` is a string, so
 *     there is no timestamp for a zone to shift;
 *   - `toDate` pins UTC midnight and the read-back slices an ISO string, so the two are symmetric.
 *
 * Kept because the claim will be made again. It is cheaper to point at a passing test than to
 * reason through the serialisation a second time - and if anyone ever replaces that `@db.Date` with
 * a timestamp, this fails immediately.
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
afterAll(async () => { await prisma.$disconnect(); });

const noAudit = { record: async () => undefined } as never;
/** Every method the service reaches for, so a missing stub cannot look like a product fault. */
const noGoogle = {
  pushEvent: async () => undefined,
  updateEvent: async () => undefined,
  removeEvent: async () => undefined,
} as never;

async function actorFor(p: PrismaService) {
  const now = new Date();
  seq += 1;
  const user = await p.users.create({
    data: {
      name: `ZZ Cal ${seq}`, email: `zz-cal-${Date.now()}-${seq}@x.test`, password: 'x',
      role: 'admin', status: 'Active', created_at: now, updated_at: now,
    },
  });
  return { id: user.id, name: user.name, role: 'admin' } as unknown as AuthUserRecord;
}

const svc = (p: PrismaService) => new CalendarService(p, noAudit, noGoogle);

/** The exact values from the report. */
const DATE = '2026-09-02';
const TIME = '10:00';

describe('the day and time an appointment was entered on', () => {
  it('survives create and read', async () => {
    await inRollback(async (p) => {
      const actor = await actorFor(p);
      const created = await svc(p).create(
        { title: 'ZZ round trip', date: DATE, time: TIME, type: 'meeting', status: 'scheduled' } as never,
        actor, 'desk',
      );

      const back = await svc(p).get(Number((created as { id: number }).id), actor, 'desk') as { date: string; time: string };
      // THE REPORT: this came back as 2026-09-01 15:30.
      expect(back.date).toBe(DATE);
      expect(back.time).toBe(TIME);
    });
  });

  it('is stored as a calendar day, not as an instant', async () => {
    /*
     * The property that makes the rest of this safe. A `@db.Date` column has no time and therefore
     * no offset to be reinterpreted; the moment it becomes a timestamp, a zone can move it.
     */
    await inRollback(async (p) => {
      const actor = await actorFor(p);
      const created = await svc(p).create(
        { title: 'ZZ stored shape', date: DATE, time: TIME, type: 'meeting', status: 'scheduled' } as never,
        actor, 'desk',
      );

      const raw = await p.calendar_events.findUnique({
        where: { id: Number((created as { id: number }).id) },
        select: { date: true, time: true },
      });
      expect(raw?.date?.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      // The time is a string, kept verbatim - never parsed into a moment.
      expect(raw?.time).toBe(TIME);
    });
  });

  it('survives an edit that does not mention the date', async () => {
    /*
     * The reporter edited the title and marked the event Completed after creating it. If an update
     * re-serialised the date it would shift on the SECOND save rather than the first, which is
     * exactly the shape of a fault that looks like it happened at creation.
     */
    await inRollback(async (p) => {
      const actor = await actorFor(p);
      const created = await svc(p).create(
        { title: 'ZZ before', date: DATE, time: TIME, type: 'meeting', status: 'scheduled' } as never,
        actor, 'desk',
      );
      const id = Number((created as { id: number }).id);

      await svc(p).update(id, {
        title: 'ZZ after', date: DATE, time: TIME, type: 'meeting', status: 'completed',
      } as never, actor, 'desk');

      const back = await svc(p).get(id, actor, 'desk') as { date: string; time: string; title: string; status: string };
      expect(back.title).toBe('ZZ after');
      expect(back.status).toBe('completed');
      expect(back.date).toBe(DATE);
      expect(back.time).toBe(TIME);
    });
  });

  it('comes back on the same day through the list the calendar grid reads', async () => {
    // The grid does not call `get`; a shift that only affected the list would still be visible.
    await inRollback(async (p) => {
      const actor = await actorFor(p);
      await svc(p).create(
        { title: 'ZZ listed', date: DATE, time: TIME, type: 'meeting', status: 'scheduled' } as never,
        actor, 'desk',
      );

      const rows = await svc(p).list(actor, 'desk', { from: DATE, to: DATE }) as { title: string; date: string; time: string }[];
      const mine = rows.find((r) => r.title === 'ZZ listed');
      expect(mine).toBeDefined();
      expect(mine!.date).toBe(DATE);
      expect(mine!.time).toBe(TIME);
    });
  });

  it('holds for a date either side of midnight UTC', async () => {
    /*
     * The hours where a zone offset would push a date across a day boundary. 23:30 in a zone behind
     * UTC and 00:30 in one ahead are the two that break first when a day is stored as an instant.
     */
    await inRollback(async (p) => {
      const actor = await actorFor(p);
      for (const time of ['00:30', '23:30']) {
        const created = await svc(p).create(
          { title: `ZZ edge ${time}`, date: DATE, time, type: 'meeting', status: 'scheduled' } as never,
          actor, 'desk',
        );
        const back = await svc(p).get(Number((created as { id: number }).id), actor, 'desk') as { date: string; time: string };
        expect(back.date).toBe(DATE);
        expect(back.time).toBe(time);
      }
    });
  });
});
