import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmSettingsService } from './crm-settings.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-016: a mailbox that cannot send must not report itself healthy.
 *
 * THE FAULT. `integrations()` reported email as connected on one question - are there active
 * accounts - while three brokerage-wide broadcasts had failed outright with `535 Username and
 * Password not accepted` and `invalid_grant: Token has been expired or revoked`. Every account
 * still read `sync_error: null`, because that column records a failed IMAP POLL and says nothing
 * about whether a message could be sent. Around forty-four automated welcome emails to real new
 * leads were refused in a single day and every health surface in the application said fine.
 *
 * WHY THIS IS TESTED AT THE SUMMARY rather than at the mailer. The sending code was not wrong -
 * it failed, correctly, and wrote down why. What was wrong is that nothing read those records. So
 * the assertion is that the summary CHANGES ITS ANSWER when a failure exists, which is the
 * property that was missing.
 *
 * THE FAILURE IS SEEDED IN THE RECORDS THE APPLICATION ALREADY WRITES - a refused row in the CRM
 * email log, a failed broadcast - because those are what existed all along. Nothing new is stored
 * to make this work, which is also why the fix needed no migration.
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
const BOSS = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function svc(tx: PrismaService) {
  // Only `prisma` is reached by `integrations()`; the mailer and account service are never touched.
  return new CrmSettingsService(tx, null as never, null as never);
}

type Health = { email: { connected: boolean; failing?: boolean; detail: string } };

/** Clear the window this check looks at, so each case starts from a known state. */
async function quietWindow(tx: PrismaService) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  await tx.crm_email_log.deleteMany({ where: { success: false, created_at: { gte: since } } });
  await tx.crm_broadcasts.deleteMany({ where: { status: 'failed', created_at: { gte: since } } });
}

describe('the email health summary reflects whether mail can be SENT', () => {
  it('reports healthy when nothing has been refused', async () => {
    await inRollback(async (tx) => {
      await quietWindow(tx);
      const health = await svc(tx).integrations(BOSS) as unknown as Health;
      expect(health.email.failing).toBe(false);
      expect(health.email.detail).not.toMatch(/failing/i);
    });
  });

  it('reports failing when a send was refused, and quotes the transport', async () => {
    await inRollback(async (tx) => {
      await quietWindow(tx);
      await tx.crm_email_log.create({
        data: {
          kind: 'welcome', recipient: `zz-${tag()}@probe.test`, subject: 'Welcome',
          success: false, error: 'info@gethomerealty.ca: Invalid login: 535-5.7.8 Username and Password not accepted.',
          sent_by: 'System', created_at: new Date(),
        },
      });

      const health = await svc(tx).integrations(BOSS) as unknown as Health;

      // THE DEFECT: this stayed true throughout the outage.
      expect(health.email.connected).toBe(false);
      expect(health.email.failing).toBe(true);
      // The transport's own words: "535 ..." tells somebody what to do; "email is not working" does not.
      expect(health.email.detail).toContain('535');
    });
  });

  it('reports failing on a broadcast that reached nobody', async () => {
    // The other record the outage was written into. Either alone must be enough.
    await inRollback(async (tx) => {
      await quietWindow(tx);
      await tx.crm_broadcasts.create({
        data: {
          message: 'ZZ probe', type: 'info', recipients: 0, status: 'failed',
          attempted: 4, failed: 4,
          error: 'commissionpayouts@gethomerealty.ca: invalid_grant: Token has been expired or revoked.',
          // No `updated_at` on this table.
          created_at: new Date(),
        },
      });

      const health = await svc(tx).integrations(BOSS) as unknown as Health;
      expect(health.email.failing).toBe(true);
      expect(health.email.detail).toContain('invalid_grant');
    });
  });

  it('does not report an old, resolved outage as current', async () => {
    /*
     * The accounts that failed were replaced on 22-23 August and the current ones are healthy. A
     * summary that stayed red for ever would be as useless as one that never went red at all -
     * people stop reading a warning that is always on.
     */
    await inRollback(async (tx) => {
      await quietWindow(tx);
      const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await tx.crm_email_log.create({
        data: {
          kind: 'welcome', recipient: `zz-${tag()}@probe.test`, subject: 'Welcome',
          success: false, error: 'Invalid login: 535-5.7.8', sent_by: 'System', created_at: longAgo,
        },
      });

      const health = await svc(tx).integrations(BOSS) as unknown as Health;
      expect(health.email.failing).toBe(false);
    });
  });
});
