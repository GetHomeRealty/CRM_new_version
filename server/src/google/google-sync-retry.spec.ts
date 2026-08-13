import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { GoogleAuthError, isPermanentAuthFailure } from './google.service';
import { encryptToken } from '../meta/meta-crypto';

/**
 * CRM-GCAL-M01 and CRM-GCAL-M02 — bounded automatic retries with a visible state and a manual
 * retry, and deactivation reserved for failures that cannot recover.
 *
 * Both were measured and recorded as gaps in the Priority 5 pass; `google-failure.spec.ts` asserted
 * the OLD behaviour on purpose, so that changing it would be deliberate. Those assertions are
 * updated there; these are the new rules.
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

interface FakeGoogle {
  refresh?: (t: string) => Promise<{ access_token: string; expires_in: number }>;
  insertEvent?: (...a: unknown[]) => Promise<string | null>;
  patchEvent?: (...a: unknown[]) => Promise<boolean>;
  deleteEvent?: (...a: unknown[]) => Promise<void>;
}

const ALIVE: FakeGoogle = { refresh: async () => ({ access_token: 'ok', expires_in: 3600 }) };

const connections = (tx: PrismaService, g: FakeGoogle) =>
  new GoogleConnectionService(tx, { revoke: async () => undefined, ...g } as never);
const syncService = (tx: PrismaService, g: FakeGoogle) =>
  new GoogleCalendarSyncService(tx, { revoke: async () => undefined, ...g } as never, connections(tx, g));

async function connectedUser(tx: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `ZZ Retry ${t}`, email: `zz-retry-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  await tx.google_connections.create({
    data: {
      user_id: user.id, scope: 'crm', calendar_id: 'primary', is_active: true,
      access_token: encryptToken('stale'), refresh_token: encryptToken('refresh'),
      token_expires_at: new Date(Date.now() - 60_000), created_at: now, updated_at: now, ...over,
    },
  });
  return user;
}

async function eventFor(tx: PrismaService, userId: number, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.calendar_events.create({
    data: {
      user_id: userId, title: `ZZ retry ev ${tag()}`, date: new Date('2026-12-21T00:00:00.000Z'),
      time: '10:00', type: 'showing', status: 'scheduled', domain: 'crm', version: 1,
      created_at: now, updated_at: now, ...over,
    },
    select: { id: true },
  });
}

const syncState = (tx: PrismaService, id: number) => tx.calendar_events.findUnique({
  where: { id },
  select: { google_sync_error: true, google_sync_attempts: true, google_sync_next_retry_at: true, google_calendar_id: true, last_synced_to_google: true },
});

// ============================================ CRM-GCAL-M02 — permanent vs temporary
describe('only a permanent authentication failure deactivates the connection', () => {
  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])('%s deactivates it', async (code) => {
    /*
     * `invalid_grant` is the one that matters: Google returns it when the user has revoked access,
     * when the refresh token has expired through disuse, or when the password behind it changed.
     * None of those recover on their own, so continuing to try is certain waste — and leaving the
     * connection "active" is what made the screen unable to say "reconnect" and mean it.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await connections(tx, {
        refresh: async () => { throw new GoogleAuthError(code, 'Token has been expired or revoked.'); },
      }).accessToken(user.id, 'crm');

      const conn = await tx.google_connections.findFirst({ where: { user_id: user.id }, select: { is_active: true, connect_error: true } });
      expect(conn?.is_active).toBe(false);
      expect(conn?.connect_error).toMatch(/reconnect/i);
    });
  });

  it.each(['http_503', 'http_429', 'internal_failure'])('%s leaves it ACTIVE and retryable', async (code) => {
    /*
     * The other half, and the one that would be a worse bug if it were wrong: making somebody
     * re-consent because Google had a bad minute. A 503, a rate limit and a socket timeout all fix
     * themselves.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await connections(tx, {
        refresh: async () => { throw new GoogleAuthError(code, 'Service unavailable.'); },
      }).accessToken(user.id, 'crm');

      const conn = await tx.google_connections.findFirst({ where: { user_id: user.id }, select: { is_active: true, connect_error: true } });
      expect(conn?.is_active).toBe(true);
      expect(conn?.connect_error).toMatch(/temporary/i);
    });
  });

  it('a plain network error is temporary — never a reason to make somebody reconnect', async () => {
    // Not a `GoogleAuthError` at all: DNS, a socket, or a bug of ours. `isPermanentAuthFailure`
    // answers false for anything it does not recognise, which is the safe direction.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await connections(tx, { refresh: async () => { throw new Error('ETIMEDOUT'); } }).accessToken(user.id, 'crm');
      expect((await tx.google_connections.findFirst({ where: { user_id: user.id }, select: { is_active: true } }))?.is_active).toBe(true);
    });
  });

  it('the classifier reads the code, not Google\'s prose', () => {
    // `refresh()` threw `error_description || error`, so the code was discarded whenever Google sent
    // a sentence — and deciding permanence by matching English breaks silently when they reword it.
    expect(isPermanentAuthFailure(new GoogleAuthError('invalid_grant', 'Token has been expired or revoked.'))).toBe(true);
    expect(isPermanentAuthFailure(new GoogleAuthError('http_500', 'invalid_grant appears in this sentence'))).toBe(false);
    expect(isPermanentAuthFailure(new Error('invalid_grant'))).toBe(false);
  });

  it('a deactivated connection stops every further attempt', async () => {
    // This is what makes deactivation worth doing: no token, so the sweep spends nothing on it.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await connections(tx, {
        refresh: async () => { throw new GoogleAuthError('invalid_grant', 'revoked'); },
      }).accessToken(user.id, 'crm');

      let refreshes = 0;
      const after = connections(tx, { refresh: async () => { refreshes += 1; return { access_token: 'x', expires_in: 3600 }; } });
      expect(await after.accessToken(user.id, 'crm')).toBeNull();
      expect(refreshes).toBe(0);
    });
  });
});

// ============================================ CRM-GCAL-M01 — retries and visibility
describe('a failed push is recorded, retried, and visible', () => {
  it('the failure is written to the event instead of only being logged', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      await syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('503 Service Unavailable'); } })
        .pushEvent(user.id, ev.id);

      const st = await syncState(tx, ev.id);
      expect(st?.google_sync_error).toMatch(/503/);
      expect(st?.google_sync_attempts).toBe(1);
      expect(st?.google_sync_next_retry_at).toBeTruthy();
      expect(st?.last_synced_to_google).toBeNull();
    });
  });

  it('the wait grows with each attempt rather than hammering Google', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      const svc = syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('503'); } });

      await svc.pushEvent(user.id, ev.id);
      const first = (await syncState(tx, ev.id))!.google_sync_next_retry_at!.getTime();
      await svc.pushEvent(user.id, ev.id);
      const second = (await syncState(tx, ev.id))!.google_sync_next_retry_at!.getTime();

      expect((await syncState(tx, ev.id))?.google_sync_attempts).toBe(2);
      expect(second).toBeGreaterThan(first);
    });
  });

  it('a later success clears the outstanding state completely', async () => {
    // A stale error is its own bug: the screen would keep reporting an appointment as missing from
    // Google after it had arrived.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      await syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('503'); } }).pushEvent(user.id, ev.id);
      expect((await syncState(tx, ev.id))?.google_sync_error).toBeTruthy();

      await syncService(tx, { ...ALIVE, insertEvent: async () => 'google-1' }).pushEvent(user.id, ev.id);

      const st = await syncState(tx, ev.id);
      expect(st?.google_sync_error).toBeNull();
      expect(st?.google_sync_attempts).toBe(0);
      expect(st?.google_sync_next_retry_at).toBeNull();
      expect(st?.google_calendar_id).toBe('google-1');
      expect(st?.last_synced_to_google).toBeTruthy();
    });
  });

  it('the sweep recovers an event once Google is back', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      await syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('503'); } }).pushEvent(user.id, ev.id);
      // Due now, as it would be after the backoff elapsed.
      await tx.calendar_events.update({ where: { id: ev.id }, data: { google_sync_next_retry_at: new Date(Date.now() - 1000) } });

      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => 'google-9' }).retryFailedPushes();

      expect(r).toEqual({ attempted: 1, recovered: 1 });
      expect((await syncState(tx, ev.id))?.google_calendar_id).toBe('google-9');
    });
  });

  it('the sweep leaves an event alone while its backoff is running', async () => {
    // Otherwise the wait means nothing and every pass is a fresh attempt.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      await syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('503'); } }).pushEvent(user.id, ev.id);

      let tries = 0;
      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => { tries += 1; return 'x'; } }).retryFailedPushes();
      expect(r.attempted).toBe(0);
      expect(tries).toBe(0);
    });
  });

  it('the automatic retries STOP after the cap', async () => {
    /*
     * The bound that makes this safe. Five attempts over roughly four hours; past that the failure
     * needs a person, and continuing would spend Google quota on a certainty. The event keeps its
     * error — it is still reported as outstanding — it simply stops being retried on its own.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, {
        google_sync_error: 'previous failure', google_sync_attempts: 5,
        google_sync_next_retry_at: new Date(Date.now() - 1000),
      });

      let tries = 0;
      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => { tries += 1; return 'x'; } }).retryFailedPushes();
      expect(r.attempted).toBe(0);
      expect(tries).toBe(0);
      // Still visible, still counted, still retryable by hand.
      expect((await syncState(tx, ev.id))?.google_sync_error).toBeTruthy();
    });
  });

  it('the manual retry ignores the cap, because that is what it is for', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, {
        google_sync_error: 'gave up', google_sync_attempts: 5,
        google_sync_next_retry_at: new Date(Date.now() + 3_600_000),
      });

      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => 'google-manual' }).retryNow(user.id, 'crm');

      expect(r).toEqual({ attempted: 1, recovered: 1 });
      expect((await syncState(tx, ev.id))?.google_calendar_id).toBe('google-manual');
    });
  });

  it('the retry picks the operation from the row as it is NOW', async () => {
    /*
     * An event created, then deleted, before the retry ran needs a DELETE — not the insert that
     * originally failed. Deriving the operation from the row rather than storing it beside the
     * failure is what makes that automatic.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await eventFor(tx, user.id, {
        google_calendar_id: 'google-existing', deleted_at: new Date(),
        google_sync_error: 'delete failed', google_sync_attempts: 1,
        google_sync_next_retry_at: new Date(Date.now() - 1000),
      });

      let deleted = 0, inserted = 0, patched = 0;
      await syncService(tx, {
        ...ALIVE,
        deleteEvent: async () => { deleted += 1; },
        insertEvent: async () => { inserted += 1; return 'x'; },
        patchEvent: async () => { patched += 1; return true; },
      }).retryFailedPushes();

      expect({ deleted, inserted, patched }).toEqual({ deleted: 1, inserted: 0, patched: 0 });
    });
  });

  it('the count is per user and per area', async () => {
    // It is shown beside one person's connection, so it must not include a colleague's backlog.
    await inRollback(async (tx) => {
      const mine = await connectedUser(tx);
      const theirs = await connectedUser(tx);
      await eventFor(tx, mine.id, { google_sync_error: 'x' });
      await eventFor(tx, mine.id, { google_sync_error: 'x' });
      await eventFor(tx, theirs.id, { google_sync_error: 'x' });
      await eventFor(tx, mine.id, { google_sync_error: 'x', domain: 'desk' });

      const svc = syncService(tx, ALIVE);
      expect(await svc.pendingSyncCount(mine.id, 'crm')).toBe(2);
      expect(await svc.pendingSyncCount(theirs.id, 'crm')).toBe(1);
      expect(await svc.pendingSyncCount(mine.id, 'desk')).toBe(1);
    });
  });

  it('an event with nothing outstanding is never counted or retried', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      await eventFor(tx, user.id, { google_calendar_id: 'g', last_synced_to_google: new Date() });
      const svc = syncService(tx, ALIVE);
      expect(await svc.pendingSyncCount(user.id, 'crm')).toBe(0);
      expect((await svc.retryFailedPushes()).attempted).toBe(0);
    });
  });

  it('a still-failing retry is recorded again rather than silently giving up', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, {
        google_sync_error: 'first', google_sync_attempts: 1,
        google_sync_next_retry_at: new Date(Date.now() - 1000),
      });

      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => { throw new Error('still down'); } }).retryFailedPushes();

      expect(r).toEqual({ attempted: 1, recovered: 0 });
      const st = await syncState(tx, ev.id);
      expect(st?.google_sync_attempts).toBe(2);
      expect(st?.google_sync_error).toMatch(/still down/);
    });
  });

  it('a Google id that comes back null is treated as a failure, not a success', async () => {
    // `insertEvent` resolving to null is not an exception, and it used to leave the event with no
    // google id, no error and no retry — outstanding for ever with nothing recording it.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id);
      await syncService(tx, { ...ALIVE, insertEvent: async () => null }).pushEvent(user.id, ev.id);
      expect((await syncState(tx, ev.id))?.google_sync_error).toBeTruthy();
    });
  });
});

describe('the sweep does not spend passes on work that cannot succeed', () => {
  /*
   * FOUND BY THE FIRST RUNTIME CHECK OF THIS SWEEP, not by a test.
   *
   * A seeded event owed to Google was picked up, found no token, and returned without recording
   * anything — which is right: a disconnected agent must not burn the five attempts on a certainty,
   * and the event stays counted and visible until they reconnect. But it was picked up again on
   * every pass, so the log read "0 of 1 recovered" every five minutes for ever and one slot in each
   * batch of fifty went to work that could not succeed.
   */
  it('skips events belonging to a disconnected user', async () => {
    await inRollback(async (tx) => {
      const user = await connectedUser(tx, { is_active: false });
      await eventFor(tx, user.id, {
        google_sync_error: 'owed', google_sync_attempts: 1,
        google_sync_next_retry_at: new Date(Date.now() - 1000),
      });

      let tries = 0;
      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => { tries += 1; return 'x'; } }).retryFailedPushes();
      expect(r).toEqual({ attempted: 0, recovered: 0 });
      expect(tries).toBe(0);
    });
  });

  it('…but the event is still counted, so it is not forgotten', async () => {
    // Skipping it in the sweep must not make it invisible: the whole point of CRM-GCAL-M01 is that
    // an appointment Google never received is something a person can see and act on.
    await inRollback(async (tx) => {
      const user = await connectedUser(tx, { is_active: false });
      await eventFor(tx, user.id, { google_sync_error: 'owed', google_sync_attempts: 1 });
      expect(await syncService(tx, ALIVE).pendingSyncCount(user.id, 'crm')).toBe(1);
    });
  });

  it('and the manual retry still tries, because reconnecting is exactly when somebody presses it', async () => {
    /*
     * `retryNow` deliberately does NOT apply this filter. Somebody who has just reconnected will
     * press Retry immediately, and a connection row that is active by then must not be excluded by a
     * snapshot the sweep took earlier.
     */
    await inRollback(async (tx) => {
      const user = await connectedUser(tx);
      const ev = await eventFor(tx, user.id, { google_sync_error: 'owed', google_sync_attempts: 5 });
      const r = await syncService(tx, { ...ALIVE, insertEvent: async () => 'google-back' }).retryNow(user.id, 'crm');
      expect(r).toEqual({ attempted: 1, recovered: 1 });
      expect((await syncState(tx, ev.id))?.google_calendar_id).toBe('google-back');
    });
  });
});
