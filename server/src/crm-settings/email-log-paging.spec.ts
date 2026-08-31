import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-008: the send log has to say how much of itself it is showing.
 *
 * WHAT THE SCREEN COULD NOT DO. It asked for a fixed number of rows and the endpoint answered with
 * a bare array. A capped response and a complete one were indistinguishable, so there was nothing
 * to build a "showing 25 of 63" from and no way to reach the rest. On the brokerage's own data that
 * withheld a fortnight - and the withheld part is where the failures are, because a log is read
 * newest-first while a complaint is investigated oldest-first.
 *
 * WHY `total` IS NOT A DATABASE COUNT. Rows are filtered for readability AFTER they are fetched:
 * an administrator may not be shown correspondence with a lead outside their scope. A `COUNT(*)`
 * would therefore promise rows this person will never be given, and "showing 25 of 63" would be a
 * lie in the direction that matters - it would suggest evidence exists that cannot be produced.
 * The total counts what this user may actually see.
 *
 * `listLog` IS DELIBERATELY UNCHANGED and still returns a bare array. Ten lead-ownership scope
 * tests drive it, and they assert who may see whose correspondence; a paging change is no reason
 * to disturb that surface.
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

/** A super admin: `data.read-all`, so nothing is hidden by the sender scope. */
const BOSS = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

function svc(tx: PrismaService) {
  return new CrmAdvancedEmailService(tx, null as never, null as never, null as never);
}

/** Log rows addressed to nobody's lead, so the readability filter keeps every one. */
async function seedLog(tx: PrismaService, howMany: number, mark: string) {
  const now = new Date();
  for (let i = 0; i < howMany; i += 1) {
    await tx.crm_email_log.create({
      data: {
        kind: 'test', lead_name: null, recipient: `zz-${mark}-${i}@probe.test`,
        subject: `${mark} #${i}`, success: true, sent_by: BOSS.name,
        created_at: new Date(now.getTime() - i * 1000),
      },
    });
  }
}

describe('the send log reports how much of itself it is showing', () => {
  it('returns a page and the total that page came from', async () => {
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      await seedLog(tx, 30, mark);

      const page = await svc(tx).listLogPage(BOSS, { limit: 10, offset: 0 });
      expect(page.data).toHaveLength(10);
      // THE DEFECT: there was no total, so 10 rows looked exactly like "there are only 10".
      expect(page.meta.total).toBeGreaterThanOrEqual(30);
      expect(page.meta.limit).toBe(10);
      expect(page.meta.complete).toBe(true);
    });
  });

  it('reaches the older entries the first page withheld', async () => {
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      await seedLog(tx, 30, mark);
      const s = svc(tx);

      const first = await s.listLogPage(BOSS, { limit: 10, offset: 0 });
      const second = await s.listLogPage(BOSS, { limit: 10, offset: 10 });

      const ids = (p: { data: Record<string, unknown>[] }) => p.data.map((r) => r.id);
      // No overlap: paging must not re-show what was already read.
      expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
      expect(second.data.length).toBe(10);
    });
  });

  it('does not run off the end', async () => {
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      await seedLog(tx, 5, mark);
      const page = await svc(tx).listLogPage(BOSS, { limit: 10, offset: 100_000 });
      expect(page.data).toEqual([]);
      expect(page.meta.total).toBeGreaterThanOrEqual(5);
    });
  });

  it('clamps rubbish rather than failing, and never asks the database for everything', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      for (const bad of [0, -1, NaN, 99_999] as number[]) {
        const page = await s.listLogPage(BOSS, { limit: bad, offset: bad });
        expect(page.meta.limit).toBeGreaterThanOrEqual(1);
        expect(page.meta.limit).toBeLessThanOrEqual(200);
        expect(page.meta.offset).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('a campaign mailing cannot crowd out everything else', async () => {
    /*
     * THE COST OF LOGGING CAMPAIGNS PER RECIPIENT (CRM-028), and the reason the filter is applied in
     * the query rather than after it.
     *
     * The scan window is 500 rows, newest first. A large mailing fills it, so a brokerage looking
     * for last week's welcome emails would find nothing but campaign rows - and filtering AFTER the
     * scan would not help, because the window would still be full of the rows being discarded.
     */
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      // One older transactional row, then a mailing large enough to bury it.
      await tx.crm_email_log.create({
        data: {
          kind: 'welcome', recipient: `zz-${mark}-welcome@probe.test`, subject: 'Welcome',
          success: true, sent_by: BOSS.name, created_at: new Date(Date.now() - 60_000),
        },
      });
      for (let i = 0; i < 60; i += 1) {
        await tx.crm_email_log.create({
          data: {
            kind: 'campaign', recipient: `zz-${mark}-camp-${i}@probe.test`, subject: 'A mailing',
            success: true, sent_by: BOSS.name, created_at: new Date(),
          },
        });
      }

      const s = svc(tx);
      const everything = await s.listLogPage(BOSS, { limit: 10 });
      const transactional = await s.listLogPage(BOSS, { limit: 10, kind: 'transactional' });

      // The newest rows are all campaign, so the unfiltered first page shows no welcome at all.
      expect(everything.data.every((r) => r.kind === 'campaign')).toBe(true);
      // Narrowed, the welcome is reachable on the first page again.
      expect(transactional.data.some((r) => String(r.recipient).includes('welcome'))).toBe(true);
      expect(transactional.data.every((r) => r.kind !== 'campaign')).toBe(true);
      expect(transactional.meta.kind).toBe('transactional');
    });
  });

  it('narrows to a single kind when asked for one', async () => {
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      for (const kind of ['welcome', 'campaign', 'campaign_test']) {
        await tx.crm_email_log.create({
          data: {
            kind, recipient: `zz-${mark}-${kind}@probe.test`, subject: kind,
            success: true, sent_by: BOSS.name, created_at: new Date(),
          },
        });
      }
      const only = await svc(tx).listLogPage(BOSS, { limit: 50, kind: 'campaign' });
      expect(only.data.every((r) => r.kind === 'campaign')).toBe(true);
      // `campaign_test` is a different kind and must not be swept in by a prefix match.
      expect(only.data.some((r) => r.kind === 'campaign_test')).toBe(false);
    });
  });

  it('leaves listLog returning a bare array, because the scope tests drive it', async () => {
    await inRollback(async (tx) => {
      const mark = `ZZLOG${tag()}`;
      await seedLog(tx, 3, mark);
      const rows = await svc(tx).listLog(BOSS, 500);
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
