import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmSettingsService } from './crm-settings.service';
import { GoogleConnectionService } from '../google/google-connection.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-017: the Integrations panel must report Calendar as it actually is.
 *
 * THE FAULT WAS A SENTENCE. `integrations()` returned a hard-coded "Not available - Google Calendar
 * OAuth was not part of the migrated code and needs Google API credentials." That was true when it
 * was written; then Calendar was built, connected to info@gethomerealty.ca and left syncing, and
 * nothing updated the string. A brokerage reading its own settings was told a working integration
 * did not exist - and the cost of that is not a broken feature but somebody paying to build a
 * second one.
 *
 * THE THIRD OF THREE. CRM-007 (Meta status healthy while webhooks stalled), CRM-016 (mail healthy
 * while sends were refused) and this are one habit: a summary answering for a component without
 * asking it. So the property under test is not "the string is right" but "the summary CHANGES when
 * the connection does" - a corrected constant would pass the first and fail the second.
 *
 * SCOPE IS ASSERTED SEPARATELY. CRM and the Transaction Desk hold independent Google connections,
 * and this panel is the CRM's. A Desk connection must not light up a CRM heading, which the tester
 * suspected was happening and which would have made the message wrong rather than merely stale.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const USER = { id: 991337, name: 'ZZ Calendar User', role: 'admin' } as unknown as AuthUserRecord;

function svc(tx: PrismaService) {
  return new CrmSettingsService(tx, null as never, null as never, new GoogleConnectionService(tx, null as never, null as never));
}

type Health = { google_calendar: { connected: boolean; detail: string } };

async function connect(tx: PrismaService, scope: 'crm' | 'desk', over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.google_connections.create({
    data: {
      user_id: USER.id, scope, is_active: true,
      google_email: `zz-cal-${scope}@probe.test`,
      access_token: 'x', refresh_token: 'y',
      last_sync: now, created_at: now, updated_at: now, ...over,
    },
  });
}

/** These tests are about what the panel REPORTS, so the server must look set up. */
const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
beforeAll(() => { process.env.GOOGLE_CLIENT_ID = 'test-id'; process.env.GOOGLE_CLIENT_SECRET = 'test-secret'; });
afterAll(() => {
  process.env.GOOGLE_CLIENT_ID = saved.id ?? '';
  process.env.GOOGLE_CLIENT_SECRET = saved.secret ?? '';
});

describe('the Integrations panel reports the real Calendar state', () => {
  it('says connected, and names the account, when it is', async () => {
    await inRollback(async (tx) => {
      await connect(tx, 'crm');
      const health = await svc(tx).integrations(USER) as unknown as Health;

      // THE DEFECT: this said "Not available ... was not part of the migrated code".
      expect(health.google_calendar.connected).toBe(true);
      expect(health.google_calendar.detail).toContain('zz-cal-crm@probe.test');
      expect(health.google_calendar.detail).not.toMatch(/not part of the migrated code/i);
    });
  });

  it('says not connected when nobody has connected it', async () => {
    await inRollback(async (tx) => {
      const health = await svc(tx).integrations(USER) as unknown as Health;
      expect(health.google_calendar.connected).toBe(false);
      expect(health.google_calendar.detail).toMatch(/not connected/i);
    });
  });

  it('does not report the Desk connection under the CRM heading', async () => {
    await inRollback(async (tx) => {
      await connect(tx, 'desk');
      const health = await svc(tx).integrations(USER) as unknown as Health;
      expect(health.google_calendar.connected).toBe(false);
    });
  });

  it('reports a disconnected connection as disconnected', async () => {
    // `is_active: false` is what a local disconnect leaves behind. The row still exists.
    await inRollback(async (tx) => {
      await connect(tx, 'crm', { is_active: false });
      const health = await svc(tx).integrations(USER) as unknown as Health;
      expect(health.google_calendar.connected).toBe(false);
    });
  });

  it('distinguishes "not set up on the server" from "not connected"', async () => {
    const id = process.env.GOOGLE_CLIENT_ID;
    try {
      process.env.GOOGLE_CLIENT_ID = '';
      await inRollback(async (tx) => {
        await connect(tx, 'crm');
        const health = await svc(tx).integrations(USER) as unknown as Health;
        // A connected row is irrelevant if the server holds no credentials to use it with.
        expect(health.google_calendar.connected).toBe(false);
        expect(health.google_calendar.detail).toMatch(/GOOGLE_CLIENT_ID/);
      });
    } finally { process.env.GOOGLE_CLIENT_ID = id ?? ''; }
  });
});
