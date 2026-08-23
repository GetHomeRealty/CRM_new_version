import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { isUnmanageableEvent } from './google.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The Google → CRM direction had no scheduler at all.
 *
 * WHAT WAS WRONG. `onModuleInit` started one worker, and it called `retryFailedPushes` — an
 * OUTBOUND retry sweep that only ever re-sends events this application already owes Google.
 * `pull()`, the whole inbound half, was reachable from exactly two places: the "Sync now" button and
 * the OAuth callback. So an event created in Google Calendar never appeared in the CRM on its own,
 * while the five-minute log line said "0 of 0 recovered" — doing precisely what it claimed, which is
 * why it read as proof that sync was working.
 *
 * These tests pin the new worker's contract: it delegates to `pull`, it asks only connections that
 * are actually connected, one bad connection cannot end the pass, and two overlapping ticks cannot
 * both run.
 */

type Conn = { user_id: number | null; scope: string };

function service(conns: Conn[], pull: (userId: number, scope: string) => Promise<{ pulled: number; error: string | null }>) {
  const asked: { userId: number; scope: string }[] = [];
  const prisma = {
    google_connections: { findMany: async () => conns },
  } as unknown as PrismaService;

  const svc = new GoogleCalendarSyncService(prisma, null as never, null as never);
  // Replace only the collaborator under test's boundary: the worker's job is to CALL `pull`, and
  // what `pull` itself does is covered by the sync suite next door.
  (svc as unknown as { pull: unknown }).pull = async (userId: number, scope: string) => {
    asked.push({ userId, scope });
    return pull(userId, scope);
  };
  return { svc, asked };
}

const ok = async () => ({ pulled: 1, error: null });

describe('the inbound pull worker', () => {
  it('pulls every active connection, through the existing pull() path', async () => {
    const { svc, asked } = service(
      [{ user_id: 1, scope: 'crm' }, { user_id: 2, scope: 'desk' }],
      ok,
    );
    const r = await svc.pullAll();
    expect(asked).toEqual([{ userId: 1, scope: 'crm' }, { userId: 2, scope: 'desk' }]);
    expect(r).toEqual({ connections: 2, pulled: 2, failed: 0 });
  });

  it('carries each connection\'s own area, so a Desk calendar is not pulled as a CRM one', async () => {
    const { svc, asked } = service([{ user_id: 9, scope: 'desk' }], ok);
    await svc.pullAll();
    expect(asked[0].scope).toBe('desk');
  });

  it('defaults a connection with no area to crm rather than skipping it', async () => {
    const { svc, asked } = service([{ user_id: 9, scope: null as unknown as string }], ok);
    await svc.pullAll();
    expect(asked[0].scope).toBe('crm');
  });

  it('asks only for connections the query returned — inactive ones are filtered in SQL', async () => {
    // `is_active: true` is in the where clause; this documents that the worker adds no second,
    // divergent notion of "connected" on top of it.
    const { svc, asked } = service([], ok);
    const r = await svc.pullAll();
    expect(asked).toEqual([]);
    expect(r.connections).toBe(0);
  });

  it('skips a row with no user id instead of pulling for nobody', async () => {
    const { svc, asked } = service([{ user_id: null, scope: 'crm' }, { user_id: 5, scope: 'crm' }], ok);
    await svc.pullAll();
    expect(asked).toEqual([{ userId: 5, scope: 'crm' }]);
  });

  describe('one failure must not end the pass', () => {
    it('continues after a connection that reports an error', async () => {
      const { svc, asked } = service(
        [{ user_id: 1, scope: 'crm' }, { user_id: 2, scope: 'crm' }, { user_id: 3, scope: 'crm' }],
        async (userId) => (userId === 2 ? { pulled: 0, error: 'token expired' } : { pulled: 1, error: null }),
      );
      const r = await svc.pullAll();
      expect(asked.map((a) => a.userId)).toEqual([1, 2, 3]);
      expect(r).toEqual({ connections: 3, pulled: 2, failed: 1 });
    });

    it('continues after a connection that throws outright', async () => {
      const { svc, asked } = service(
        [{ user_id: 1, scope: 'crm' }, { user_id: 2, scope: 'crm' }, { user_id: 3, scope: 'crm' }],
        async (userId) => { if (userId === 2) throw new Error('socket hang up'); return { pulled: 1, error: null }; },
      );
      const r = await svc.pullAll();
      expect(asked.map((a) => a.userId)).toEqual([1, 2, 3]);
      expect(r.pulled).toBe(2);
      expect(r.failed).toBe(1);
    });
  });

  it('will not run two passes at once', async () => {
    /*
     * The in-process guard. `clusterTick` is what stops two SERVERS pulling the same calendar; this
     * stops one server whose pass is slower than the interval from stacking passes on itself and
     * asking Google for the same window twice.
     */
    let inFlight = 0;
    let maxConcurrent = 0;
    const { svc } = service([{ user_id: 1, scope: 'crm' }], async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { pulled: 1, error: null };
    });

    const [a, b] = await Promise.all([svc.pullAll(), svc.pullAll()]);
    expect(maxConcurrent).toBe(1);
    // The second call returns immediately having done nothing, rather than queueing behind the first.
    expect([a.connections, b.connections].sort()).toEqual([0, 1]);
  });

  it('survives the connection lookup failing, without taking the process down', async () => {
    const prisma = {
      google_connections: { findMany: async () => { throw new Error('database is away'); } },
    } as unknown as PrismaService;
    const svc = new GoogleCalendarSyncService(prisma, null as never, null as never);
    await expect(svc.pullAll()).resolves.toEqual({ connections: 0, pulled: 0, failed: 0 });
  });
});

describe('the inbound worker does not weaken the birthday protection', () => {
  it('still refuses to adopt Google-generated entries', () => {
    /*
     * The worker delegates to `pull`, which calls `applyGoogleEvent`, which is where the exclusion
     * lives — so scheduling the pull cannot reintroduce the event that could never be deleted.
     * Asserted here as well because this is the change that made those imports automatic: before
     * it, a birthday only entered the CRM if somebody pressed Sync.
     */
    expect(isUnmanageableEvent({ eventType: 'birthday' })).toBe(true);
    expect(isUnmanageableEvent({ eventType: 'fromGmail' })).toBe(true);
    expect(isUnmanageableEvent({ eventType: 'default' })).toBe(false);
    expect(isUnmanageableEvent({ eventType: 'outOfOffice' })).toBe(false);
    expect(isUnmanageableEvent({})).toBe(false);
  });
});
