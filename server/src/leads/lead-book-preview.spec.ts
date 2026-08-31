import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadTransferService } from './lead-transfer.service';

/**
 * CRM-043: the hand-over confirmation names the leads it is about to move.
 *
 * WHAT THE DIALOG SAID. "<N> unassigned brokerage lead(s) become <agent>'s to work. Oldest first,
 * so the longest-waiting enquiry goes over first. Only leads nobody holds are eligible - no agent
 * loses anything." A number, a recipient and an ordering rule, and never which lead.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. "Oldest first" is doing real work: on the brokerage that
 * reported this the pool held four leads, of which the oldest was a real client from 25 August and
 * the other three were test records from the 26th. Handing over "just one" moved the real client's
 * file - permanently, because nothing in the application moves an assigned lead back to the pool -
 * and the window a broker reads before confirming gave them no way to know it. The system already
 * knew, since that is how it chooses.
 *
 * IT IS ALSO WHY NINE ACCEPTANCE CRITERIA WENT UNTESTED. The tester could not run the hand-over
 * safely without knowing which record would move.
 *
 * ONE SELECTION, NOT TWO. `preview` and `transfer` both go through the service's `pick`, because a
 * dialog that names its leads is worth nothing if it is a second implementation of the choice: the
 * two would agree until the day they did not, and that is the day somebody relies on it.
 *
 * THE SECOND DEFECT FOUND HERE. The selection ordered by `id: 'asc'` while the dialog promised
 * oldest first, and this table's ids do not run in creation order - 220 pairs of live leads on the
 * development database have the lower id and the later date. So the promise was false before the
 * identity was ever withheld. `eligibleOrder` now sorts on `created_at`.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

/** See the sibling suite: the pool is global, so it has to be emptied to be measurable. */
async function emptyPool(tx: PrismaService): Promise<void> {
  await tx.leads.updateMany({
    where: { deleted_at: null, owner_user_id: null, assigned_to: null },
    data: { deleted_at: new Date() },
  });
}

const auditStub = { record: async () => undefined } as never;
const as = (u: { id: number; name: string; role: string | null }) => ({ id: u.id, name: u.name, role: u.role ?? 'agent' }) as never;

async function people(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const mk = (role: string, tag: string) => tx.users.create({
    data: { name: `${tag} ${n}`, email: `${tag}-${Date.now()}-${n}@x.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
  });
  return { admin: await mk('admin', 'admin'), agent: await mk('agent', 'agent'), successor: await mk('agent', 'successor') };
}

/**
 * A pool whose id order is the REVERSE of its age order, which is the shape real data has and the
 * only shape in which "oldest first" is a testable claim.
 */
async function poolNewestFirst(tx: PrismaService, days: number[]) {
  const made: { id: number; day: number; name: string }[] = [];
  for (const d of days) {
    const when = new Date(Date.UTC(2026, 0, d));
    const name = `ZZ Pool day ${d}`;
    const lead = await tx.leads.create({
      data: { name, email: `pool-preview-${Date.now()}-${++seq}-${d}@x.test`, created_at: when, updated_at: when },
    });
    made.push({ id: lead.id, day: d, name });
  }
  return made;
}

describe('the confirmation can say which leads would move', () => {
  it('names them, oldest first', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await people(tx);
      const made = await poolNewestFirst(tx, [40, 30, 20, 10]);

      const preview = await new LeadTransferService(tx, auditStub).preview(as(admin), 2);

      // THE DEFECT: there was no way to learn this before pressing the button.
      expect(preview.moving.map((m) => m.name)).toEqual(['ZZ Pool day 10', 'ZZ Pool day 20']);
      expect(preview.available).toBe(4);
      const byDay = [...made].sort((a, b) => a.day - b.day);
      expect(preview.moving.map((m) => m.id)).toEqual([byDay[0].id, byDay[1].id]);
    });
  });

  it('names exactly what the hand-over then moves', async () => {
    /*
     * The property the whole fix rests on. A preview that names a different set from the one that
     * moves is worse than no preview, because it is believed.
     */
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin, successor } = await people(tx);
      await poolNewestFirst(tx, [40, 30, 20, 10]);
      const svc = new LeadTransferService(tx, auditStub);

      const promised = (await svc.preview(as(admin), 3)).moving.map((m) => m.id);
      await svc.transfer(as(admin), successor.id, 3);

      const actual = (await tx.leads.findMany({ where: { assigned_to: successor.id }, select: { id: true } })).map((l) => l.id);
      expect(actual.sort((a, b) => a - b)).toEqual([...promised].sort((a, b) => a - b));
    });
  });

  it('defaults to the whole pool when no count is given', async () => {
    // Blank means all of them on the screen, so the preview has to mean the same thing.
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await people(tx);
      await poolNewestFirst(tx, [40, 30, 20, 10]);

      const preview = await new LeadTransferService(tx, auditStub).preview(as(admin));
      expect(preview.moving).toHaveLength(4);
      expect(preview.available).toBe(4);
    });
  });

  it('never names a lead somebody owns or is working', async () => {
    /*
     * The rule the screen is built around, restated against the new call: naming leads must not
     * become a way to read an agent's book. Every lead it can reach belongs to nobody.
     */
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin, agent } = await people(tx);
      const now = new Date();
      await tx.leads.create({ data: { name: 'ZZ Owned', email: `owned-${Date.now()}@x.test`, owner_user_id: agent.id, assigned_to: agent.id, created_at: now, updated_at: now } });
      await tx.leads.create({ data: { name: 'ZZ Assigned', email: `assigned-${Date.now()}@x.test`, assigned_to: agent.id, created_at: now, updated_at: now } });
      const pool = await poolNewestFirst(tx, [10]);

      const preview = await new LeadTransferService(tx, auditStub).preview(as(admin));

      expect(preview.moving.map((m) => m.id)).toEqual([pool[0].id]);
      expect(preview.moving.map((m) => m.name)).not.toContain('ZZ Owned');
      expect(preview.moving.map((m) => m.name)).not.toContain('ZZ Assigned');
    });
  });

  it('is closed to everybody but a Super Admin', async () => {
    // Same door as the hand-over. Naming the leads must not be reachable where moving them is not.
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { agent } = await people(tx);
      await poolNewestFirst(tx, [10]);

      await expect(new LeadTransferService(tx, auditStub).preview(as(agent)))
        .rejects.toThrow(ForbiddenException);
    });
  });

  it('moves nothing', async () => {
    // It is read on opening a dialog that may then be cancelled.
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await people(tx);
      await poolNewestFirst(tx, [40, 30, 20, 10]);

      await new LeadTransferService(tx, auditStub).preview(as(admin), 2);

      const stillFree = await tx.leads.count({ where: { deleted_at: null, owner_user_id: null, assigned_to: null } });
      expect(stillFree).toBe(4);
    });
  });

  it('answers an empty pool without pretending there is something to move', async () => {
    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin } = await people(tx);

      const preview = await new LeadTransferService(tx, auditStub).preview(as(admin), 5);
      expect(preview.moving).toEqual([]);
      expect(preview.available).toBe(0);
    });
  });
});

describe('the audit entry records which leads moved', () => {
  it('lists them, not just how many', async () => {
    /*
     * There is no control anywhere that moves an assigned lead back to the pool, so this entry is
     * the only surviving record of what a hand-over did.
     */
    const written: string[] = [];
    const audit = { record: async (_u: unknown, _a: string, _s: string, details = '') => { written.push(details); } } as never;

    await inRollback(async (tx) => {
      await emptyPool(tx);
      const { admin, successor } = await people(tx);
      const made = await poolNewestFirst(tx, [20, 10]);

      await new LeadTransferService(tx, audit).transfer(as(admin), successor.id, 1);

      const oldest = [...made].sort((a, b) => a.day - b.day)[0];
      expect(written[0]).toContain(`#${oldest.id}`);
      expect(written[0]).toContain('ZZ Pool day 10');
    });
  });
});
