import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaConnectionService } from './meta-connection.service';

/**
 * THE PAGE A PERSON'S META SCREEN OPENS ON, remembered for them rather than for their browser.
 *
 * WHY IT IS A COLUMN ON `meta_connections` AND NOT A TABLE OF ITS OWN. The Pages belong to the
 * connection — `meta_pages.connection_id` — so a default Page has no meaning without one, and
 * disconnecting drops the connection row, which is exactly the cleanup a separate preferences table
 * would have to remember to do and would get wrong by leaving a row pointing at a Page nobody can
 * reach. `ad_account_id` on the same table is the same shape of thing.
 *
 * WHY THE ID IS NOT A FOREIGN KEY. `meta_pages` is rebuilt from Graph whenever Pages are refreshed,
 * so a reference into it would break on a refresh that changed nothing the person cares about. A
 * stale id is expected, and every reader checks it against the Pages Graph actually returns.
 *
 * WHAT REPLACED WHAT. This first lived in `localStorage`, which is per BROWSER: three people hold
 * separate Meta connections here, so signing out and in on a shared machine inherited somebody
 * else's Page.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const service = (tx: PrismaService) => new MetaConnectionService(tx, { fetchPages: async () => [] } as never);

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `ZZ Meta ${t}`, email: `zz-metapref-${t}@probe.test`, username: `zzmp${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  return u.id;
}

async function connect(tx: PrismaService, userId: number): Promise<void> {
  const now = new Date();
  await tx.meta_connections.create({
    data: {
      user_id: userId, access_token: 'plain:tok', facebook_user_id: `fb-${tag()}`,
      is_active: true, connected_at: now, created_at: now, updated_at: now,
    },
  });
}

const stored = (tx: PrismaService, userId: number) =>
  tx.meta_connections.findUnique({ where: { user_id: userId }, select: { default_meta_page_id: true } });

describe('remembering which Meta Page a person works on', () => {
  it('stores the choice against that person', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await connect(tx, userId);

      await service(tx).setDefaultPage(userId, '1234567890');

      expect((await stored(tx, userId))?.default_meta_page_id).toBe('1234567890');
    });
  });

  it('replaces a previous choice rather than accumulating them', async () => {
    // The column holds one answer; this is what a row-per-preference table would have to enforce.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await connect(tx, userId);

      await service(tx).setDefaultPage(userId, 'first');
      await service(tx).setDefaultPage(userId, 'second');

      expect((await stored(tx, userId))?.default_meta_page_id).toBe('second');
      expect(await tx.meta_connections.count({ where: { user_id: userId } })).toBe(1);
    });
  });

  it('clears the choice when given null', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await connect(tx, userId);
      await service(tx).setDefaultPage(userId, 'something');

      await service(tx).setDefaultPage(userId, null);

      expect((await stored(tx, userId))?.default_meta_page_id).toBeNull();
    });
  });

  it('is one person’s preference and reaches nobody else', async () => {
    /*
     * The property `localStorage` could not hold: it is per browser, so a shared machine handed one
     * agent's Page to the next person who signed in.
     */
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await connect(tx, mine);
      await connect(tx, theirs);

      await service(tx).setDefaultPage(mine, 'my-page');

      expect((await stored(tx, mine))?.default_meta_page_id).toBe('my-page');
      expect((await stored(tx, theirs))?.default_meta_page_id).toBeNull();
    });
  });

  it('does nothing, and does not throw, for somebody with no connection', async () => {
    /*
     * `updateMany` rather than `update`, like `setAdAccount`. A person can reach the screen before
     * connecting, and a thrown RecordNotFound there would be a 500 for a preference nobody needs.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await expect(service(tx).setDefaultPage(userId, 'page')).resolves.toBeUndefined();
      expect(await stored(tx, userId)).toBeNull();
    });
  });

  it('starts empty, so nobody’s dropdown moves the day this ships', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await connect(tx, userId);
      expect((await stored(tx, userId))?.default_meta_page_id).toBeNull();
    });
  });

  it('survives a Page refresh, because it is not a foreign key into meta_pages', async () => {
    /*
     * `refreshPages` deletes and rewrites `meta_pages` from Graph. A relation would have cascaded or
     * blocked; holding Meta's own id means the preference simply outlives the rebuild.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await connect(tx, userId);
      const conn = await tx.meta_connections.findUniqueOrThrow({ where: { user_id: userId }, select: { id: true } });
      const now = new Date();
      await tx.meta_pages.create({
        data: { connection_id: conn.id, page_id: 'page-a', name: 'A', access_token: 'plain:p', created_at: now, updated_at: now },
      });
      await service(tx).setDefaultPage(userId, 'page-a');

      await tx.meta_pages.deleteMany({ where: { connection_id: conn.id } });

      expect((await stored(tx, userId))?.default_meta_page_id).toBe('page-a');
    });
  });
});
