import { PrismaClient } from '@prisma/client';
import { GoogleCalendarSyncService } from '../google/google-calendar-sync.service';

/**
 * CRM and Transaction Desk are separate products that happen to share a database.
 *
 * The same person, using the SAME external mailbox and the SAME Google account, must end up with
 * two independent connections and two independent calendars. Nothing may merge across the boundary:
 * not rows, not sync state, not events.
 *
 * WHY THESE ASSERT ROW IDs AND NOT SCOPE VALUES. `expect(crm.scope).toBe('crm')` proves only that a
 * column holds what was written to it. It would pass against a single shared row read twice. The
 * requirement is that the records are genuinely distinct, so every case below asserts
 * `crm.id !== desk.id` and then that mutating one leaves the other byte-identical.
 *
 * COMMITTED FIXTURES, not the rolled-back transaction the neighbouring specs use. Isolation is
 * about what a SECOND reader sees; inside one transaction there is only ever one reader, so the
 * property under test cannot fail. Each test discards its own rows, and `afterAll` sweeps anything
 * a failure left behind.
 *
 * Fixtures are kept out of states the background sweeps select — no `enable_reminder`, no
 * `inbound_enabled` — so a scheduler in a neighbouring suite cannot pick them up mid-assertion.
 */

const prisma = new PrismaClient();
const MARK = `ZZISO-${Date.now()}`;
const EMAIL = `${MARK.toLowerCase()}@probe.test`;
/** A user id no fixture writes to, so these rows cannot collide with another suite's. */
const USER = 999_000_001;

afterAll(async () => {
  await prisma.calendar_events.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.mail_accounts.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.$disconnect();
});

const mailRow = (scope: 'crm' | 'desk') => ({
  name: `${MARK} ${scope}`,
  from_email: EMAIL,          // THE SAME external mailbox in both scopes — the whole point
  host: 'smtp.example.test',
  port: 587,
  user_id: USER,
  scope,
  is_active: true,
  // Left off deliberately: `inbound_enabled` would make these visible to the IMAP sweep.
  created_at: new Date(),
  updated_at: new Date(),
});

// ============================================================ CRM Mail vs Desk Mail

describe('CRM Mail and Transaction Desk Mail stay separate', () => {
  it('the same mailbox connects to both scopes as two distinct rows', async () => {
    const crm = await prisma.mail_accounts.create({ data: mailRow('crm') });
    const desk = await prisma.mail_accounts.create({ data: mailRow('desk') });
    try {
      // Same external identity…
      expect(crm.from_email).toBe(desk.from_email);
      // …two genuinely different records. This is the assertion that matters.
      expect(crm.id).not.toBe(desk.id);
      expect(crm.scope).toBe('crm');
      expect(desk.scope).toBe('desk');
    } finally {
      await prisma.mail_accounts.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('sync state, errors and timestamps move independently', async () => {
    const crm = await prisma.mail_accounts.create({ data: mailRow('crm') });
    const desk = await prisma.mail_accounts.create({ data: mailRow('desk') });
    try {
      // A failed CRM poll, of the kind the IMAP sweep records.
      await prisma.mail_accounts.update({
        where: { id: crm.id },
        data: { sync_error: 'CRM mailbox refused the connection', last_uid: 4321, last_synced_at: new Date() },
      });

      const deskAfter = await prisma.mail_accounts.findUnique({ where: { id: desk.id } });
      expect(deskAfter?.sync_error).toBeNull();
      expect(deskAfter?.last_uid).toBeNull();
      expect(deskAfter?.last_synced_at).toBeNull();

      // And the reverse, so this proves isolation rather than one-directional luck.
      await prisma.mail_accounts.update({ where: { id: desk.id }, data: { sync_error: 'Desk mailbox failed' } });
      const crmAfter = await prisma.mail_accounts.findUnique({ where: { id: crm.id } });
      expect(crmAfter?.sync_error).toBe('CRM mailbox refused the connection');
    } finally {
      await prisma.mail_accounts.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('disconnecting CRM leaves the Desk connection intact', async () => {
    const crm = await prisma.mail_accounts.create({ data: mailRow('crm') });
    const desk = await prisma.mail_accounts.create({ data: mailRow('desk') });
    try {
      await prisma.mail_accounts.delete({ where: { id: crm.id } });

      const survivor = await prisma.mail_accounts.findUnique({ where: { id: desk.id } });
      expect(survivor).not.toBeNull();
      expect(survivor?.scope).toBe('desk');
      expect(survivor?.is_active).toBe(true);
    } finally {
      await prisma.mail_accounts.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('a scope-filtered read returns only that area’s mailbox', async () => {
    // What the Inbox actually does: CRM must never list the Desk's accounts.
    const crm = await prisma.mail_accounts.create({ data: mailRow('crm') });
    const desk = await prisma.mail_accounts.create({ data: mailRow('desk') });
    try {
      const crmOnly = await prisma.mail_accounts.findMany({ where: { user_id: USER, scope: 'crm' }, select: { id: true } });
      expect(crmOnly.map((r) => r.id)).toEqual([crm.id]);

      const deskOnly = await prisma.mail_accounts.findMany({ where: { user_id: USER, scope: 'desk' }, select: { id: true } });
      expect(deskOnly.map((r) => r.id)).toEqual([desk.id]);
    } finally {
      await prisma.mail_accounts.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);
});

// ============================================================ CRM Calendar vs Desk Calendar

/** The lookup `applyGoogleEvent` performs, reproduced exactly. */
const findSynced = (googleId: string, area: 'crm' | 'desk') => prisma.calendar_events.findFirst({
  where: { google_calendar_id: googleId, user_id: USER, OR: [{ domain: area }, { domain: null }] },
  select: { id: true, domain: true, deleted_at: true },
});

const eventRow = (googleId: string, domain: 'crm' | 'desk', title: string) => ({
  title, date: new Date(Date.UTC(2027, 8, 21)), time: '09:00',
  type: 'meeting', status: 'scheduled',
  // Off deliberately: an event with reminders enabled is visible to the reminder sweep.
  enable_reminder: false,
  google_calendar_id: googleId, user_id: USER, domain,
  created_at: new Date(), updated_at: new Date(),
});

describe('CRM Calendar and Transaction Desk Calendar stay separate', () => {
  it('ONE Google event becomes TWO local rows, one per area', async () => {
    const gid = `gcal-${MARK}-1`;
    const crm = await prisma.calendar_events.create({ data: eventRow(gid, 'crm', `${MARK} crm copy`) });
    const desk = await prisma.calendar_events.create({ data: eventRow(gid, 'desk', `${MARK} desk copy`) });
    try {
      expect(crm.id).not.toBe(desk.id);
      expect(crm.google_calendar_id).toBe(desk.google_calendar_id);
      expect(crm.domain).toBe('crm');
      expect(desk.domain).toBe('desk');
    } finally {
      await prisma.calendar_events.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('each area’s sync finds ONLY its own copy — the domain cannot flip', async () => {
    /*
     * THE ASSERTION THE WHOLE ISOLATION MODEL RESTS ON. If this lookup ignored `domain`, the Desk
     * sync would find the CRM row, update it, and stamp `domain: 'desk'` — silently moving an event
     * across the product boundary. That is the failure this reproduces and rules out.
     */
    const gid = `gcal-${MARK}-2`;
    const crm = await prisma.calendar_events.create({ data: eventRow(gid, 'crm', `${MARK} crm copy`) });
    const desk = await prisma.calendar_events.create({ data: eventRow(gid, 'desk', `${MARK} desk copy`) });
    try {
      expect((await findSynced(gid, 'crm'))?.id).toBe(crm.id);
      expect((await findSynced(gid, 'desk'))?.id).toBe(desk.id);

      // A second pull, as the 300s retry sweep performs: still each to its own.
      expect((await findSynced(gid, 'crm'))?.domain).toBe('crm');
      expect((await findSynced(gid, 'desk'))?.domain).toBe('desk');
    } finally {
      await prisma.calendar_events.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('cancelling in CRM does not remove the Desk copy', async () => {
    const gid = `gcal-${MARK}-3`;
    const crm = await prisma.calendar_events.create({ data: eventRow(gid, 'crm', `${MARK} crm copy`) });
    const desk = await prisma.calendar_events.create({ data: eventRow(gid, 'desk', `${MARK} desk copy`) });
    try {
      // The soft delete the sync applies when Google reports the event cancelled.
      await prisma.calendar_events.update({ where: { id: crm.id }, data: { deleted_at: new Date() } });

      const deskAfter = await prisma.calendar_events.findUnique({ where: { id: desk.id } });
      expect(deskAfter?.deleted_at).toBeNull();
      // And the Desk sync still finds its own live copy.
      expect((await findSynced(gid, 'desk'))?.id).toBe(desk.id);
    } finally {
      await prisma.calendar_events.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('editing one area’s copy leaves the other untouched', async () => {
    const gid = `gcal-${MARK}-4`;
    const crm = await prisma.calendar_events.create({ data: eventRow(gid, 'crm', `${MARK} crm copy`) });
    const desk = await prisma.calendar_events.create({ data: eventRow(gid, 'desk', `${MARK} desk copy`) });
    try {
      // `status` is CRM-owned and deliberately never written by a Google pull.
      await prisma.calendar_events.update({ where: { id: crm.id }, data: { status: 'completed', title: `${MARK} crm edited` } });

      const deskAfter = await prisma.calendar_events.findUnique({ where: { id: desk.id } });
      expect(deskAfter?.status).toBe('scheduled');
      expect(deskAfter?.title).toBe(`${MARK} desk copy`);
    } finally {
      await prisma.calendar_events.deleteMany({ where: { id: { in: [crm.id, desk.id] } } });
    }
  }, 120_000);

  it('a recurring series and its occurrences stay within their own area', async () => {
    const gid = `gcal-${MARK}-5`;
    const crmSeries = await prisma.calendar_events.create({ data: eventRow(`${gid}-series`, 'crm', `${MARK} crm series`) });
    const deskSeries = await prisma.calendar_events.create({ data: eventRow(`${gid}-series`, 'desk', `${MARK} desk series`) });
    const crmOcc = await prisma.calendar_events.create({
      data: { ...eventRow(gid, 'crm', `${MARK} crm occurrence`), recurrence_id: crmSeries.id },
    });
    const deskOcc = await prisma.calendar_events.create({
      data: { ...eventRow(gid, 'desk', `${MARK} desk occurrence`), recurrence_id: deskSeries.id },
    });
    const ids = [crmSeries.id, deskSeries.id, crmOcc.id, deskOcc.id];
    try {
      // Each occurrence hangs off its OWN area's series — no cross-area parenting.
      expect(crmOcc.recurrence_id).toBe(crmSeries.id);
      expect(deskOcc.recurrence_id).toBe(deskSeries.id);
      expect(crmOcc.recurrence_id).not.toBe(deskOcc.recurrence_id);

      // Cancelling one occurrence leaves the other area's occurrence and both series alone.
      await prisma.calendar_events.update({ where: { id: crmOcc.id }, data: { deleted_at: new Date() } });
      expect((await prisma.calendar_events.findUnique({ where: { id: deskOcc.id } }))?.deleted_at).toBeNull();
      expect((await prisma.calendar_events.findUnique({ where: { id: deskSeries.id } }))?.deleted_at).toBeNull();
    } finally {
      await prisma.calendar_events.deleteMany({ where: { id: { in: ids } } });
    }
  }, 120_000);
});

// ============================================================ Google connection isolation

/**
 * The same Google account, connected in both areas, as two independent connections.
 *
 * `google_connections` carries `@@unique([user_id, scope])`, so the schema already guarantees one
 * row per area and makes two rows for one account possible. What the constraint cannot say is
 * whether the LIFECYCLE stays separate: revoking one area's access, or reconnecting it, must leave
 * the other area's tokens, sync token and error state exactly as they were.
 *
 * That is the part a user notices. A revoked CRM connection that also stops the Desk calendar
 * syncing looks like a Google outage, not like a bug in this application.
 */

const googleRow = (scope: 'crm' | 'desk') => ({
  user_id: USER,
  scope,
  google_email: EMAIL,            // the SAME Google account in both areas
  access_token: `access-${scope}-original`,
  refresh_token: `refresh-${scope}-original`,
  token_expires_at: new Date(Date.now() + 3_600_000),
  scopes: 'https://www.googleapis.com/auth/calendar',
  calendar_id: 'primary',
  sync_token: `synctoken-${scope}-original`,
  last_sync: new Date('2027-01-01T00:00:00Z'),
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
});

/** Everything that must not leak across the boundary, in one comparable shape. */
const stateOf = async (id: number) => {
  const r = await prisma.google_connections.findUnique({ where: { id } });
  return {
    access_token: r?.access_token, refresh_token: r?.refresh_token,
    sync_token: r?.sync_token, last_sync: r?.last_sync?.toISOString() ?? null,
    connect_error: r?.connect_error, is_active: r?.is_active,
    google_email: r?.google_email, scope: r?.scope,
  };
};

describe('Google connections: the same account in both areas', () => {
  let crmId = 0, deskId = 0;

  beforeEach(async () => {
    await prisma.google_connections.deleteMany({ where: { user_id: USER } });
    crmId = (await prisma.google_connections.create({ data: googleRow('crm') })).id;
    deskId = (await prisma.google_connections.create({ data: googleRow('desk') })).id;
  });
  afterEach(async () => { await prisma.google_connections.deleteMany({ where: { user_id: USER } }); });

  it('are two distinct rows sharing one Google account', async () => {
    expect(crmId).not.toBe(deskId);
    const [crm, desk] = await Promise.all([stateOf(crmId), stateOf(deskId)]);
    expect(crm.google_email).toBe(desk.google_email);      // same account…
    expect(crm.access_token).not.toBe(desk.access_token);  // …separate credentials
    expect(crm.sync_token).not.toBe(desk.sync_token);
  }, 120_000);

  it('sync token, last sync and error state are independent', async () => {
    // A CRM pull advances its sync token; the Desk's must not move.
    await prisma.google_connections.update({
      where: { id: crmId },
      data: { sync_token: 'synctoken-crm-advanced', last_sync: new Date('2027-06-30T12:00:00Z') },
    });
    const desk = await stateOf(deskId);
    expect(desk.sync_token).toBe('synctoken-desk-original');
    expect(desk.last_sync).toBe(new Date('2027-01-01T00:00:00Z').toISOString());
  }, 120_000);

  it('REVOKING CRM leaves the Desk connection byte-identical', async () => {
    const before = await stateOf(deskId);

    // What `google-connection.service.ts` records when Google reports the grant withdrawn.
    await prisma.google_connections.update({
      where: { id: crmId },
      data: {
        access_token: null, refresh_token: null, sync_token: null, is_active: false,
        connect_error: 'Google access was revoked or has expired.',
      },
    });

    expect(await stateOf(deskId)).toEqual(before);
    // …and CRM really is revoked, or the comparison above proves nothing.
    const crm = await stateOf(crmId);
    expect(crm.is_active).toBe(false);
    expect(crm.access_token).toBeNull();
  }, 120_000);

  it('REVOKING Desk leaves the CRM connection byte-identical', async () => {
    // The reverse, so this proves isolation rather than one-directional luck.
    const before = await stateOf(crmId);
    await prisma.google_connections.update({
      where: { id: deskId },
      data: { access_token: null, refresh_token: null, sync_token: null, is_active: false, connect_error: 'revoked' },
    });
    expect(await stateOf(crmId)).toEqual(before);
  }, 120_000);

  it('RECONNECTING CRM replaces only CRM tokens', async () => {
    const before = await stateOf(deskId);

    // A reconnect is an upsert on (user_id, scope) — new tokens, error cleared, sync token reset
    // so the next pull starts a fresh incremental sync.
    await prisma.google_connections.update({
      where: { id: crmId },
      data: {
        access_token: 'access-crm-RECONNECTED', refresh_token: 'refresh-crm-RECONNECTED',
        sync_token: null, connect_error: null, is_active: true, updated_at: new Date(),
      },
    });

    expect(await stateOf(deskId)).toEqual(before);
    expect((await stateOf(crmId)).access_token).toBe('access-crm-RECONNECTED');
  }, 120_000);

  it('RECONNECTING Desk replaces only Desk tokens', async () => {
    const before = await stateOf(crmId);
    await prisma.google_connections.update({
      where: { id: deskId },
      data: { access_token: 'access-desk-RECONNECTED', sync_token: null, connect_error: null, is_active: true },
    });
    expect(await stateOf(crmId)).toEqual(before);
    expect((await stateOf(deskId)).access_token).toBe('access-desk-RECONNECTED');
  }, 120_000);

  it('the unique rule permits one row per area and refuses a second in the same area', async () => {
    // `@@unique([user_id, scope])` — the schema-level guarantee, asserted rather than assumed.
    await expect(prisma.google_connections.create({ data: googleRow('crm') })).rejects.toThrow();
    // Both originals survive the rejected insert.
    expect(await prisma.google_connections.count({ where: { user_id: USER } })).toBe(2);
  }, 120_000);
});

// ============================================================ scheduler isolation, at runtime

/**
 * The sync SWEEP itself, driven end to end — not just the query it happens to use.
 *
 * Everything above proves the data model isolates: the right rows exist and the right queries find
 * them. What it does not prove is that `pull()` — the method the scheduler actually calls — carries
 * its scope all the way through. A service that took `scope` and then dropped it somewhere in the
 * middle would satisfy every assertion so far and still merge the two calendars in production.
 *
 * So this runs the real `GoogleCalendarSyncService.pull(user, scope)` against the real database,
 * with only Google itself stubbed: one fake event, returned identically to both areas, exactly as a
 * shared Google account would.
 */
describe('the sync sweep keeps its scope end to end', () => {
  const GOOGLE_ID = `gcal-${MARK}-runtime`;

  /** One Google event, the same for whoever asks — a shared account seen from both areas. */
  const googleStub = {
    listEvents: async () => ({
      events: [{
        id: GOOGLE_ID, status: 'confirmed', summary: `${MARK} from google`,
        start: { dateTime: '2027-09-21T09:00:00Z' }, end: { dateTime: '2027-09-21T10:00:00Z' },
      }],
      nextSyncToken: 'next-token', expiredSyncToken: false,
    }),
  } as never;

  /** A connected account in whichever area is asking. Tokens differ so a mix-up would show. */
  const connectionsStub = () => ({
    accessToken: async (_u: number, scope: string) => `token-${scope}`,
    find: async (_u: number, scope: string) => ({ calendar_id: 'primary', sync_token: null, scope }),
    touchSync: async () => undefined,
    recordTokenState: async () => undefined,
    // Present so a real failure surfaces as a thrown assertion rather than as a stub gap.
    recordError: async (_u: number, msg: string) => { throw new Error('pull failed: ' + msg); },
    clearError: async () => undefined,
  }) as never;

  afterEach(async () => {
    await prisma.calendar_events.deleteMany({ where: { google_calendar_id: { startsWith: `gcal-${MARK}` } } });
  });

  it('pulling as CRM then as Desk produces TWO rows, one per area', async () => {
    const svc = new GoogleCalendarSyncService(
      prisma as never, googleStub, connectionsStub(),
    );

    await svc.pull(USER, 'crm');
    await svc.pull(USER, 'desk');

    const rows = await prisma.calendar_events.findMany({
      where: { google_calendar_id: GOOGLE_ID, user_id: USER },
      select: { id: true, domain: true },
      orderBy: { id: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.domain).sort()).toEqual(['crm', 'desk']);
    expect(rows[0].id).not.toBe(rows[1].id);
  }, 300_000);

  it('pulling repeatedly does not merge them or flip a domain', async () => {
    /*
     * THE REGRESSION THIS EXISTS TO CATCH. The retry sweep runs every 300 seconds against both
     * areas. If `pull` lost its scope, the second area's pass would find the first area's row and
     * restamp it — one calendar quietly absorbing the other, a few minutes after anybody looked.
     */
    const svc = new GoogleCalendarSyncService(prisma as never, googleStub, connectionsStub());

    for (let pass = 0; pass < 3; pass++) {
      await svc.pull(USER, 'crm');
      await svc.pull(USER, 'desk');
    }

    const rows = await prisma.calendar_events.findMany({
      where: { google_calendar_id: GOOGLE_ID, user_id: USER },
      select: { domain: true },
    });
    // Still exactly two after six passes — not four, not one.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.domain === 'crm')).toHaveLength(1);
    expect(rows.filter((r) => r.domain === 'desk')).toHaveLength(1);
  }, 300_000);

  it('a CRM-only pull never creates or touches a Desk row', async () => {
    const svc = new GoogleCalendarSyncService(prisma as never, googleStub, connectionsStub());

    await svc.pull(USER, 'crm');

    const desk = await prisma.calendar_events.findMany({
      where: { google_calendar_id: GOOGLE_ID, user_id: USER, domain: 'desk' },
    });
    expect(desk).toHaveLength(0);
  }, 300_000);
});
