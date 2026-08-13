import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { GoogleConnectionService } from './google-connection.service';
import { CalendarService } from '../calendar/calendar.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { GOOGLE_ORIGIN_CREATED_BY } from './google.constants';

/**
 * Disconnecting Google Calendar has to take its events off the calendar with it.
 *
 * THE DEFECT. `disconnect()` revoked the token and deleted the `google_connections` row, and did
 * nothing about the events pulled from that calendar. They kept `deleted_at IS NULL`, so every
 * calendar query kept returning them: the agent disconnected Google and their Google appointments
 * stayed on the screen for ever, with nothing left that could ever sync them again.
 *
 * WHAT MAKES THIS DELICATE, and why the tests below are shaped the way they are: `google_calendar_id`
 * is NOT a marker of origin. It is written in both directions — an agent's own appointment carries
 * one the moment it is mirrored out to Google. There are events in the development database created
 * by a named agent that have one. Hiding "everything with a Google id" would therefore delete the
 * agent's own work, which is the one outcome a disconnect must never produce. Origin is
 * `created_by`, and the tests assert that distinction directly rather than trusting it.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Revoking talks to Google; nothing in this file should. */
const noGoogle = { revoke: async () => {} } as never;
const connections = (tx: PrismaService) => new GoogleConnectionService(tx, noGoogle);
/**
 * The real connection service is wired in, not stubbed: `pull` asks it for an access token,
 * and whether that lookup finds a connection is precisely what the disconnected case is about.
 */
const sync = (tx: PrismaService) => new GoogleCalendarSyncService(tx, noGoogle, connections(tx));
/**
 * `remove()` logs to the audit trail and fires a best-effort push of the deletion to Google.
 * Both are stubbed inert: this file is about which rows are visible, and neither should reach
 * out of the process during a test.
 */
const noAudit = { logModule: async () => {}, log: async () => {} } as never;
const noPush = { removeEvent: async () => {}, pushEvent: async () => {}, updateEvent: async () => {} } as never;
const calendar = (tx: PrismaService) => new CalendarService(tx, noAudit, noPush);

const googleEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'confirmed',
  summary: 'Property showing — 12 Elm St',
  location: '12 Elm St',
  description: 'Buyer viewing',
  start: { dateTime: '2026-09-10T14:00:00' },
  ...over,
});

async function makeUser(tx: PrismaService): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Disc User ${t}`, email: `disc-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

/** A connection for one area, written directly — `save` encrypts tokens and needs none of that here. */
async function connect(tx: PrismaService, userId: number, scope: 'crm' | 'desk'): Promise<void> {
  const now = new Date();
  await tx.google_connections.create({
    data: { user_id: userId, scope, google_email: `g-${tag()}@example.test`, calendar_id: 'primary', created_at: now, updated_at: now },
  });
}

/** What the agent's calendar actually shows for one area — the API the screen calls. */
async function visible(tx: PrismaService, user: AuthUserRecord, area: 'crm' | 'desk'): Promise<string[]> {
  const rows = await calendar(tx).list(user, area, {});
  return rows.map((r) => String((r as { title: string }).title));
}

/** An appointment the agent created themselves, which has since been mirrored out to Google. */
async function nativeEventMirroredToGoogle(tx: PrismaService, user: AuthUserRecord, area: 'crm' | 'desk', title: string) {
  const now = new Date();
  return tx.calendar_events.create({
    data: {
      title, date: new Date('2026-09-11T00:00:00Z'), time: '10:00',
      type: 'meeting', status: 'scheduled', domain: area,
      user_id: user.id, created_by: user.name,          // the agent's own name — NOT Google's
      google_calendar_id: `pushed-${tag()}`,            // it has a Google id all the same
      created_at: now, updated_at: now,
    },
  });
}

// ---------------------------------------------------------------------------------------------

describe('1–3. connect, sync, disconnect', () => {
  it('shows Google events once they are pulled', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');

      expect(await visible(tx, user, 'crm')).toEqual(['Property showing — 12 Elm St']);
    });
  });

  it('hides them the moment the connection is disconnected', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');
      expect(await visible(tx, user, 'crm')).toHaveLength(1);

      const { hidden } = await connections(tx).disconnect(user.id, 'crm');

      expect(hidden).toBe(1);
      expect(await visible(tx, user, 'crm')).toEqual([]);
    });
  });

  it('leaves the agent’s OWN appointments alone — including one already mirrored to Google', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');
      await nativeEventMirroredToGoogle(tx, user, 'crm', 'My own listing appointment');

      await connections(tx).disconnect(user.id, 'crm');

      // The Google one is gone; the agent's own survives even though it carries a Google id.
      expect(await visible(tx, user, 'crm')).toEqual(['My own listing appointment']);
    });
  });
});

describe('4. the events stay hidden — this is persisted state, not a request-time filter', () => {
  it('is still hidden when read fresh, as it would be after a reload or a restart', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      const gid = `g-${tag()}`;
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(gid), 'crm');
      await connections(tx).disconnect(user.id, 'crm');

      // A brand-new service instance, exactly as a restarted process would build. The row itself
      // carries the decision, so nothing has to remember it.
      expect(await visible(tx, user, 'crm')).toEqual([]);
      const row = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.google_disconnected_at).not.toBeNull();
    });
  });
});

describe('5. a background sync cannot bring them back while disconnected', () => {
  it('refuses to pull without a connection', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');
      await connections(tx).disconnect(user.id, 'crm');

      // `pull` asks for an access token first and stops when there is none. No token store, no
      // connection row, nothing for the sweep to act on.
      const result = await sync(tx).pull(user.id, 'crm');
      expect(result.pulled).toBe(0);
      expect(result.error).toMatch(/not connected/i);
      expect(await visible(tx, user, 'crm')).toEqual([]);
    });
  });

  it('leaves nothing for the push-retry sweep to pick up', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');
      await connections(tx).disconnect(user.id, 'crm');

      // The sweep works from the set of users that still have a connection row.
      const stillConnected = await tx.google_connections.count({ where: { user_id: user.id } });
      expect(stillConnected).toBe(0);
    });
  });
});

describe('6–8. CRM and Transaction Desk stay independent', () => {
  it('a CRM disconnect leaves Transaction Desk events untouched', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await connect(tx, user.id, 'desk');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`crm-${tag()}`, { summary: 'CRM meeting' }), 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`desk-${tag()}`, { summary: 'Desk closing' }), 'desk');

      await connections(tx).disconnect(user.id, 'crm');

      expect(await visible(tx, user, 'crm')).toEqual([]);
      expect(await visible(tx, user, 'desk')).toEqual(['Desk closing']);
    });
  });

  it('a Transaction Desk disconnect leaves CRM events untouched', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await connect(tx, user.id, 'desk');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`crm-${tag()}`, { summary: 'CRM meeting' }), 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`desk-${tag()}`, { summary: 'Desk closing' }), 'desk');

      await connections(tx).disconnect(user.id, 'desk');

      expect(await visible(tx, user, 'desk')).toEqual([]);
      expect(await visible(tx, user, 'crm')).toEqual(['CRM meeting']);
    });
  });

  it('the SAME Google event id connected to both areas is separated by area', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await connect(tx, user.id, 'desk');
      // One Google account connected on both sides: the identical event arrives twice, once per
      // area, and each area holds its own row. 22 events in the development database look like this.
      const shared = `shared-${tag()}`;
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(shared, { summary: 'Same meeting' }), 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(shared, { summary: 'Same meeting' }), 'desk');
      expect(await tx.calendar_events.count({ where: { google_calendar_id: shared, deleted_at: null } })).toBe(2);

      await connections(tx).disconnect(user.id, 'crm');

      expect(await visible(tx, user, 'crm')).toEqual([]);
      expect(await visible(tx, user, 'desk')).toEqual(['Same meeting']);
    });
  });

  it('another agent’s calendar is never touched', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await connect(tx, mine.id, 'crm');
      await connect(tx, theirs.id, 'crm');
      await sync(tx)['applyGoogleEvent'](mine.id, googleEvent(`m-${tag()}`, { summary: 'Mine' }), 'crm');
      await sync(tx)['applyGoogleEvent'](theirs.id, googleEvent(`t-${tag()}`, { summary: 'Theirs' }), 'crm');

      await connections(tx).disconnect(mine.id, 'crm');

      expect(await visible(tx, mine, 'crm')).toEqual([]);
      expect(await visible(tx, theirs, 'crm')).toEqual(['Theirs']);
    });
  });
});

describe('9–10. reconnecting', () => {
  it('brings the events back, in place, with no duplicate', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      const gid = `g-${tag()}`;
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(gid), 'crm');
      const idBefore = (await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } }))!.id;

      await connections(tx).disconnect(user.id, 'crm');
      expect(await visible(tx, user, 'crm')).toEqual([]);

      // Reconnect, and Google sends the same event again.
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(gid), 'crm');

      expect(await visible(tx, user, 'crm')).toEqual(['Property showing — 12 Elm St']);
      // The SAME row, restored — not a second copy beside the hidden one.
      const rows = await tx.calendar_events.findMany({ where: { google_calendar_id: gid } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(idBefore);
      expect(rows[0].google_disconnected_at).toBeNull();
    });
  });

  it('does NOT resurrect an appointment the agent deleted themselves', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      const gid = `g-${tag()}`;
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(gid), 'crm');
      const row = (await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } }))!;

      // The agent deletes it. `remove()` pushes that deletion to Google best-effort — and when that
      // push fails, Google still lists the event and the next pull sees it again. It must stay gone.
      await calendar(tx).remove(row.id, user, 'crm');
      expect(await visible(tx, user, 'crm')).toEqual([]);

      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(gid), 'crm');

      expect(await visible(tx, user, 'crm')).toEqual([]);
    });
  });

  it('reconnecting one area does not disturb the other', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'desk');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`d-${tag()}`, { summary: 'Desk closing' }), 'desk');

      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`c-${tag()}`, { summary: 'CRM meeting' }), 'crm');

      expect(await visible(tx, user, 'desk')).toEqual(['Desk closing']);
      expect(await visible(tx, user, 'crm')).toEqual(['CRM meeting']);
    });
  });
});

describe('11. disconnecting with nothing synced', () => {
  it('succeeds and reports nothing hidden', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');

      const { hidden } = await connections(tx).disconnect(user.id, 'crm');

      expect(hidden).toBe(0);
      expect(await tx.google_connections.count({ where: { user_id: user.id, scope: 'crm' } })).toBe(0);
    });
  });

  it('disconnecting when never connected is a no-op rather than an error', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await expect(connections(tx).disconnect(user.id, 'crm')).resolves.toEqual({ hidden: 0 });
    });
  });
});

describe('12. cached calendar data is invalidated by the disconnect', () => {
  /*
   * The Calendar screen itself is not cached — `CalendarService.list` goes to the database every
   * time — so there is nothing there to go stale. The CRM DASHBOARD is: it counts calendar events
   * and holds the answer per user for twenty seconds. Those tiles are the only cached surface a
   * disconnect can leave wrong, so they are the ones dropped.
   */
  it('drops both of the caller’s dashboard entries, and nobody else’s', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      await connect(tx, user.id, 'crm');

      const forgotten: string[] = [];
      const spyCache = { forget: async (ns: string, key: string) => { forgotten.push(`${ns}:${key}`); } } as never;
      const svc = new GoogleConnectionService(tx, noGoogle, spyCache);

      await svc.disconnect(user.id, 'crm');

      expect(forgotten.sort()).toEqual([
        `dashboard:crm:${user.id}:own`,
        `dashboard:crm:${user.id}:sa`,
      ].sort());
      expect(forgotten.some((k) => k.includes(`:${other.id}:`))).toBe(false);
    });
  });

  it('disconnects cleanly when no cache is configured at all', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await sync(tx)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`), 'crm');

      // No CacheService injected — the deployment this ran on for months had no Redis at all.
      await expect(connections(tx).disconnect(user.id, 'crm')).resolves.toEqual({ hidden: 1 });
      expect(await visible(tx, user, 'crm')).toEqual([]);
    });
  });
});

describe('the events that pre-date the CRM/Desk split', () => {
  /*
   * `domain IS NULL` events show on BOTH calendars (`areaWhere`), and nothing records which
   * connection they came from. 99 of them exist in development and 266 in QA, so the rule below is
   * about real rows rather than a hypothetical.
   */
  const legacyGoogleEvent = async (tx: PrismaService, user: AuthUserRecord) => {
    const now = new Date();
    return tx.calendar_events.create({
      data: {
        title: 'Legacy Google event', date: new Date('2026-09-12T00:00:00Z'), time: '09:00',
        type: 'meeting', status: 'scheduled', domain: null,
        user_id: user.id, created_by: GOOGLE_ORIGIN_CREATED_BY,
        google_calendar_id: `legacy-${tag()}`, created_at: now, updated_at: now,
      },
    });
  };

  it('keeps them while the OTHER area is still connected, because they might be its', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await connect(tx, user.id, 'desk');
      await legacyGoogleEvent(tx, user);

      await connections(tx).disconnect(user.id, 'crm');

      // Ambiguous, and the Desk still has a Google calendar — so it is left alone rather than
      // stripped from a connected area.
      expect(await visible(tx, user, 'desk')).toEqual(['Legacy Google event']);
    });
  });

  it('hides them once no Google connection remains at all', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 'crm');
      await legacyGoogleEvent(tx, user);
      expect(await visible(tx, user, 'crm')).toEqual(['Legacy Google event']);

      await connections(tx).disconnect(user.id, 'crm');

      // No Google connection left, so no Google event should be on any calendar.
      expect(await visible(tx, user, 'crm')).toEqual([]);
      expect(await visible(tx, user, 'desk')).toEqual([]);
    });
  });
});
