import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MentionService } from './mention.service';

/**
 * A colleague on the deal must be offered whatever their name is.
 *
 * THE FAULT THIS PINS. `candidates()` read the first 100 active users ordered by name and only then
 * asked which of them could open the deal. So past a hundred staff the autocomplete was decided by
 * the alphabet: somebody sorting after the hundredth name could never be offered, however plainly
 * they were on the deal, and nothing reported it. A permissions-shaped list that fails silently is
 * the worst kind - it looks like "they are not on this deal" rather than "we stopped looking".
 *
 * WHY IT WENT UNNOTICED FOR SO LONG. It is invisible below the threshold and total above it. This
 * brokerage crossed 100 active users mid-morning on 2026-08-29 and `mention.spec.ts` began failing
 * with no code change, because the colleague it creates is named "ZZ Mention ..." and sorts last.
 * That is the whole bug in one fixture.
 *
 * THE TEST NAMES ITS COLLEAGUE TO SORT LAST ON PURPOSE. A name in the middle of the alphabet would
 * pass against the old code most of the time, which is how this survived.
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

/** Everyone can reach the deal, so the only thing under test is how far the search looks. */
const reachAll = { assertTransaction: async () => undefined, canReachTransaction: async () => true } as never;

async function makeUser(tx: PrismaService, name: string) {
  const t = tag();
  const now = new Date();
  return tx.users.create({
    data: {
      name, email: `zz-page-${t}@probe.test`, username: `zzpage${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

describe('the mention autocomplete looks past its first page', () => {
  it('offers the one colleague on the deal, though their name sorts after everybody else', async () => {
    /*
     * ONLY THIS PERSON IS ON THE DEAL, which is what makes the case real. With everybody reachable
     * the first 25 names fill the list legitimately and a late name is correctly absent - an
     * earlier version of this test asserted that and was simply wrong about the bug.
     *
     * The fault appears when the reachable people sort LATE: the old code read 100 rows, found none
     * of them reachable, and returned an empty list while the colleague sat at position 101.
     */
    await inRollback(async (tx) => {
      const active = await tx.users.count({ where: { status: 'Active' } });
      // Below one page the old code was correct, so the assertion would prove nothing.
      if (active < 100) return;

      const late = await makeUser(tx, `zzzz-last-${tag()}`);
      const onlyLate = {
        assertTransaction: async () => undefined,
        canReachTransaction: async (p: { id: number }) => p.id === late.id,
      } as never;

      const svc = new MentionService(tx, onlyLate);
      const offered = await svc.candidates({ id: 1, role: 'admin' } as never, 1);

      expect(offered.map((c) => c.id)).toContain(late.id);
    });
  });

  it('still stops at the number it means to offer', async () => {
    // Paging deeper must not turn a bounded list into an unbounded one: reachability is a query per
    // person, so "look further" without "stop at 25" would scan the staff on every keystroke.
    await inRollback(async (tx) => {
      const svc = new MentionService(tx, reachAll);
      const offered = await svc.candidates({ id: 1, role: 'admin' } as never, 1);
      expect(offered.length).toBeLessThanOrEqual(MentionService.MAX_CANDIDATES);
    });
  });

  it('returns nobody when nobody can reach the deal, rather than scanning for ever', async () => {
    const reachNone = { assertTransaction: async () => undefined, canReachTransaction: async () => false } as never;
    await inRollback(async (tx) => {
      const svc = new MentionService(tx, reachNone);
      expect(await svc.candidates({ id: 1, role: 'admin' } as never, 1)).toEqual([]);
    });
  });
});
