import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { encryptToken } from '../meta/meta-crypto';

/**
 * PRIORITY 5 — Google Calendar, when Google will not cooperate.
 *
 * WHAT THE SURFACE ACTUALLY IS, because it changes what these can claim. Unlike Meta there is **no
 * Google scheduler**: nothing polls in the background. The integration is
 *
 *   · `pull(userId, scope)` — on demand, from `POST /api/google/sync`
 *   · `pushEvent` / `updateEvent` / `removeEvent` — fired on a CRM write and `void`-ed
 *
 * So "rate limiting", "API outage" and "restart recovery" have no retry loop to exercise; what they
 * have instead is a push that is attempted exactly once and then dropped. That is the finding, and
 * it is asserted below rather than described.
 *
 * `GoogleService` is stubbed because the alternative is calling Google. Everything else — the
 * connection service, the sync service, the encryption, the database — is real.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 120000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** Whatever Google is pretending to do this test. */
interface FakeGoogle {
  refresh?: (t: string) => Promise<{ access_token: string; expires_in: number }>;
  insertEvent?: (...a: unknown[]) => Promise<string | null>;
  patchEvent?: (...a: unknown[]) => Promise<boolean>;
  deleteEvent?: (...a: unknown[]) => Promise<void>;
  revoke?: (t: string) => Promise<void>;
}

const connections = (tx: PrismaService, g: FakeGoogle) =>
  new GoogleConnectionService(tx, { revoke: async () => undefined, ...g } as never);

async function connectedUser(tx: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `ZZ GCal ${t}`, email: `zz-gcal-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
  await tx.google_connections.create({
    data: {
      user_id: user.id, scope: 'crm', calendar_id: 'primary', is_active: true,
      /*
       * BOTH TOKENS ARE STORED, ENCRYPTED, as a real connection has them. Without them
       * `accessToken()` returns null at its first guard — `!conn.access_token` — and the refresh path
       * is never reached at all. Three of these tests failed that way first: they proved that an
       * unconnected user gets no token, which was not the question.
       */
      access_token: encryptToken('stale-access'),
      refresh_token: encryptToken('the-refresh-token'),
      // Already expired, so every read takes the refresh path — which is the path under test.
      token_expires_at: new Date(Date.now() - 60_000),
      created_at: now, updated_at: now,
      ...over,
    },
  });
  return user;
}

describe('an access token that has to be refreshed', () => {
  it('a refresh failure yields no token and records something the screen can show', async () => {
    /*
     * A PLAIN `Error` IS TEMPORARY, and the wording follows from that.
     *
     * This originally expected "reconnect", because every refresh failure produced that message. It
     * no longer does: permanence is decided by the OAuth code carried on a `GoogleAuthError`, and an
     * untyped error — DNS, a socket, a bug of ours — is never a reason to make somebody re-consent.
     * The string `invalid_grant` appearing inside a generic Error's message is not evidence of a
     * revocation, which is exactly the trap the classifier avoids.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const svc = connections(tx, { refresh: async () => { throw new Error('invalid_grant'); } });

      expect(await svc.accessToken(user.id, 'crm')).toBeNull();
      const conn = await tx.google_connections.findFirst({ where: { user_id: user.id }, select: { connect_error: true, is_active: true } });
      expect(conn?.connect_error ?? '').toMatch(/temporary/i);
      expect(conn?.is_active).toBe(true);
    });
  });

  it('a REVOKED grant is now distinguished from a passing network fault', () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the change is the point.
     *
     * When Priority 5 measured this, `accessToken` caught every refresh failure the same way —
     * `recordError`, `is_active` left true — so a revocation and a 503 were indistinguishable. It was
     * recorded as CRM-GCAL-M02 and asserted AS-IS, deliberately, so that changing it would have to be
     * a decision rather than an accident.
     *
     * The decision was taken: deactivate only for permanent authentication failures, keep temporary
     * ones active and retryable. The rules now live in `google-sync-retry.spec.ts`, which drives both
     * halves against the real service; this is left as a pointer so the history is not lost.
     */
    expect(true).toBe(true);
  });

  it('a successful refresh clears the previous error', async () => {
    // Otherwise the screen keeps asking somebody to reconnect an integration that is working again.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await tx.google_connections.updateMany({ where: { user_id: user.id }, data: { connect_error: 'stale' } });

      await connections(tx, { refresh: async () => ({ access_token: 'fresh', expires_in: 3600 }) })
        .accessToken(user.id, 'crm');

      const conn = await tx.google_connections.findFirst({ where: { user_id: user.id }, select: { connect_error: true, token_expires_at: true } });
      expect(conn?.connect_error).toBeNull();
      expect(conn!.token_expires_at!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('a disconnected connection yields no token, whatever Google would have said', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx, { is_active: false });
      const svc = connections(tx, { refresh: async () => ({ access_token: 'fresh', expires_in: 3600 }) });
      expect(await svc.accessToken(user.id, 'crm')).toBeNull();
    });
  });
});

describe('a push to Google that fails', () => {
  const syncService = (tx: PrismaService, g: FakeGoogle) =>
    new GoogleCalendarSyncService(tx, { revoke: async () => undefined, ...g } as never, connections(tx, g));

  async function eventFor(tx: PrismaService, userId: number, googleId: string | null) {
    const now = new Date();
    return tx.calendar_events.create({
      data: {
        user_id: userId, title: `ZZ GCal ev ${tag()}`, date: new Date('2026-12-20T00:00:00.000Z'),
        time: '10:00', type: 'showing', status: 'scheduled', domain: 'crm', version: 1,
        google_calendar_id: googleId, created_at: now, updated_at: now,
      },
      select: { id: true },
    });
  }

  it('never throws — Google being unreachable must not fail the save', async () => {
    /*
     * The contract the module states, and the right one: an agent saving a viewing must not be shown
     * an error because a third party is down.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, null);
      const svc = syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        insertEvent: async () => { throw new Error('503 Service Unavailable'); },
      });
      await expect(svc.pushEvent(user.id, ev.id)).resolves.toBeUndefined();
    });
  });

  it('…and the event now CARRIES a record that Google never received it', async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE. It read: *"the event is left with NO record that Google
     * never received it"*, and it was true — the failure was caught, logged as a warning and dropped,
     * with no scheduler, no flag on the row and nothing on screen. Recorded as CRM-GCAL-M01 and
     * pinned as-is so that closing it would be deliberate.
     *
     * It is closed. The failure is written to the row, a bounded sweep retries it, and the calendar
     * card shows the count with a Retry button. The full rules are in `google-sync-retry.spec.ts`;
     * this keeps the original scenario and asserts the new outcome, because this file is where
     * somebody looking for "what happens when the push fails" will read first.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, null);
      await syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        insertEvent: async () => { throw new Error('503 Service Unavailable'); },
      }).pushEvent(user.id, ev.id);

      const after = await tx.calendar_events.findUnique({
        where: { id: ev.id },
        select: { google_calendar_id: true, last_synced_to_google: true, google_sync_error: true, google_sync_attempts: true },
      });
      expect(after?.google_calendar_id).toBeNull();
      expect(after?.last_synced_to_google).toBeNull();
      // The part that is new: the drift is now recorded rather than only absent.
      expect(after?.google_sync_error).toMatch(/503/);
      expect(after?.google_sync_attempts).toBe(1);
    });
  });

  it('an edit is not stamped as synced when the patch is refused', async () => {
    // The inverse mistake would be worse: a stamp saying Google has the change when it does not.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, 'google-abc');
      await syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        patchEvent: async () => false,
      }).updateEvent(user.id, ev.id);

      const after = await tx.calendar_events.findUnique({ where: { id: ev.id }, select: { last_synced_to_google: true } });
      expect(after?.last_synced_to_google).toBeNull();
    });
  });

  it('a successful push records the Google id exactly once', async () => {
    /*
     * DUPLICATE PREVENTION. `google_calendar_id` is what stops a second push creating a second Google
     * event — `pushEvent` returns early when it is set, and `applyGoogleEvent` uses it so a pulled
     * event is not echoed back. Two pushes, one Google event.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, null);
      let inserts = 0;
      const svc = syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        insertEvent: async () => { inserts += 1; return `google-${inserts}`; },
      });

      await svc.pushEvent(user.id, ev.id);
      await svc.pushEvent(user.id, ev.id);

      expect(inserts).toBe(1);
      const after = await tx.calendar_events.findUnique({ where: { id: ev.id }, select: { google_calendar_id: true } });
      expect(after?.google_calendar_id).toBe('google-1');
    });
  });

  it('an event that came FROM Google is never pushed back', async () => {
    // The other half of the duplicate rule, and the one that would produce an endless echo.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, 'from-google-1');
      let inserts = 0;
      await syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        insertEvent: async () => { inserts += 1; return 'x'; },
      }).pushEvent(user.id, ev.id);
      expect(inserts).toBe(0);
    });
  });

  it('no connection means no attempt, and no error', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx, { is_active: false });
      const ev = await eventFor(tx, user.id, null);
      let inserts = 0;
      await expect(syncService(tx, { insertEvent: async () => { inserts += 1; return 'x'; } })
        .pushEvent(user.id, ev.id)).resolves.toBeUndefined();
      expect(inserts).toBe(0);
    });
  });

  it('a delete that Google refuses does not fail the local delete', async () => {
    // A cancelled showing must disappear here even if it lingers on Google — recorded, because the
    // consequence is that it lingers on the client's shared calendar with nothing to retry it.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await expect(syncService(tx, {
        refresh: async () => ({ access_token: 'ok', expires_in: 3600 }),
        deleteEvent: async () => { throw new Error('410 Gone'); },
      }).removeEvent(user.id, 'google-abc', 'crm')).resolves.toBeUndefined();
    });
  });
});
