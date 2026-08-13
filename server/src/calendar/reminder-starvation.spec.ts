import { PrismaClient } from '@prisma/client';

/**
 * The two-hundredth appointment must not be the last one that ever gets a reminder.
 *
 * `dueEvents` reads at most `MAX_PER_SWEEP` (200) events per lead time, which is a sensible bound.
 * The bug was what it counted. The query had no relation to `calendar_event_reminders`, so an
 * appointment already reminded two days ago was still returned, still sorted ahead of newer ones by
 * `date asc`, and still consumed one of the two hundred slots — the claim further down then skipped
 * it as already owned.
 *
 * That is silent starvation, and the ordering is what makes it permanent: the set does not change
 * between sweeps, so once two hundred handled events sit in the window, event 201 is never reached.
 * Not this sweep, not the next. At 500 agents a two-day band holds far more than two hundred
 * appointments, so most reminders would simply never be sent and nothing would report it.
 *
 * This file asserts the mechanism directly against the real schema: an event that already has a
 * reminder row for a given lead time is not a candidate for that lead time, so the cap only ever
 * limits NEW work.
 *
 * Committed rows rather than a rolled-back transaction, because the point is what a second query
 * sees; cleaned up in `afterAll`.
 */

const prisma = new PrismaClient();
const MARK = `ZZSTARVE-${Date.now()}`;
const LEAD = 60;          // the one-hour band, one of REMINDER_LEAD_MINUTES
const OTHER_LEAD = 24 * 60;

afterAll(async () => {
  const ids = (await prisma.calendar_events.findMany({
    where: { title: { startsWith: MARK } }, select: { id: true },
  })).map((e) => e.id);
  if (ids.length) {
    await prisma.calendar_event_reminders.deleteMany({ where: { calendar_event_id: { in: ids } } });
    await prisma.calendar_events.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

/** The candidate query as `dueEvents` now issues it, minus the JS time-band filter. */
const candidates = (from: Date, to: Date, lead: number) => prisma.calendar_events.findMany({
  where: {
    deleted_at: null,
    enable_reminder: true,
    status: { notIn: ['cancelled', 'completed'] },
    date: { gte: from, lte: to },
    reminders: { none: { lead_minutes: lead } },
    title: { startsWith: MARK },        // scoped to this file's fixtures only
  },
  orderBy: [{ date: 'asc' }, { time: 'asc' }],
  select: { id: true, title: true },
});

const DAY = new Date(Date.UTC(2027, 5, 15));   // far enough out that no real fixture collides
const FROM = new Date(Date.UTC(2027, 5, 14));
const TO = new Date(Date.UTC(2027, 5, 16));

describe('an already-reminded appointment stops occupying a sweep slot', () => {
  let handled: number[] = [];
  let fresh = 0;

  beforeAll(async () => {
    const now = new Date();
    // Five "already handled" appointments and one new one, all in the same band.
    for (let i = 0; i < 6; i++) {
      const ev = await prisma.calendar_events.create({
        data: {
          title: `${MARK}-${String(i).padStart(3, '0')}`,
          date: DAY, time: `0${i}:00`, type: 'meeting', status: 'scheduled',
          enable_reminder: true, user_id: null,
          created_at: now, updated_at: now,
        },
      });
      if (i < 5) handled.push(ev.id); else fresh = ev.id;
    }
    // Remind the first five for LEAD only.
    await prisma.calendar_event_reminders.createMany({
      data: handled.map((id) => ({
        calendar_event_id: id, lead_minutes: LEAD, delivery_status: 'Sent',
        created_at: now, updated_at: now,
      })),
      skipDuplicates: true,
    });
  }, 120_000);

  it('the five already reminded are no longer candidates', async () => {
    const rows = await candidates(FROM, TO, LEAD);
    const ids = rows.map((r) => r.id);
    for (const id of handled) expect(ids).not.toContain(id);
  }, 120_000);

  it('the sixth — the one that would have starved — IS a candidate', async () => {
    /*
     * THE ASSERTION THE FIX EXISTS FOR. Before, the five handled events sorted ahead of this one and
     * consumed slots; scale that to two hundred and this event is never reached again.
     */
    const rows = await candidates(FROM, TO, LEAD);
    expect(rows.map((r) => r.id)).toContain(fresh);
  }, 120_000);

  it('the cap now bounds only unfinished work', async () => {
    // Six fixtures, five settled: exactly one remains to be done, whatever the cap is.
    const rows = await candidates(FROM, TO, LEAD);
    expect(rows).toHaveLength(1);
  }, 120_000);

  it('a reminder for the OTHER lead time does not exclude an event from this one', async () => {
    /*
     * The two bands are independent — a day-before reminder having been sent must not suppress the
     * hour-before one. Filtering on `lead_minutes` rather than on "has any reminder" is what keeps
     * that true, and getting it wrong would silence half of every reminder pair.
     */
    const rows = await candidates(FROM, TO, OTHER_LEAD);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([...handled, fresh]));
    expect(rows).toHaveLength(6);
  }, 120_000);
});
