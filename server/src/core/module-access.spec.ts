import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ModuleAccessService } from './module-access.service';

/**
 * Module access: licensed AND assigned.
 *
 * Every case runs inside a rolled-back transaction against the real schema. The live data cannot
 * exercise most of this — the one company is licensed for both modules and every user is assigned
 * both, which is exactly one of the twelve combinations below.
 *
 * The property that matters most is the direction of the defaults: a missing fact means OPEN. A
 * deployment upgraded before anyone filled in a subscription, or a user created by a caller that
 * knows nothing about modules, must keep working. Failing closed would lock people out of a running
 * system on the strength of a table that was empty five minutes earlier.
 */

const prisma = new PrismaClient();

async function inRollback<T>(fn: (tx: PrismaService) => Promise<T>): Promise<T> {
  let out: T;
  const ROLLBACK = '__rollback__';
  try {
    await prisma.$transaction(async (tx) => {
      out = await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
  return out!;
}

/** A user, and a licence for company 1 replacing whatever is there. */
async function seed(tx: PrismaService, licence?: { crm?: boolean; desk?: boolean; status?: string; expiry?: Date | null }) {
  const now = new Date();
  const user = await tx.users.create({
    data: { name: 'access spec', email: `acc-${Date.now()}-${Math.round(performance.now() * 1000)}@example.test`, password: 'x', role: 'agent', created_at: now, updated_at: now },
  });
  if (licence) {
    // Find-then-write rather than a keyed upsert: the licence row is a singleton enforced by a
    // unique index on a constant expression, so there is no unique column to address it by.
    const existingLicence = await tx.subscriptions.findFirst({ select: { id: true } });
    const licenceData = {
      crm_enabled: licence.crm ?? true,
      transaction_enabled: licence.desk ?? true,
      status: licence.status ?? 'active',
      expiry_date: licence.expiry ?? null,
      updated_at: now,
    };
    if (existingLicence) {
      await tx.subscriptions.update({ where: { id: existingLicence.id }, data: licenceData });
    } else {
      await tx.subscriptions.create({ data: { ...licenceData, created_at: now } });
    }
  }
  const assign = (modules: string[]) =>
    tx.user_modules.createMany({
      data: modules.map((module_name) => ({ user_id: user.id, module_name, status: 'active', created_at: now, updated_at: now })),
    });
  return { user, assign };
}

const svc = (tx: PrismaService) => new ModuleAccessService(tx);

describe('module access = licensed AND assigned', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('gives both when both are licensed and both assigned', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true });
      await assign(['crm', 'desk']);
      expect(await svc(tx).forUser(user.id)).toEqual(['crm', 'desk']);
    });
  });

  it('withholds a module that is assigned but not licensed', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: false });
      await assign(['crm', 'desk']);
      expect(await svc(tx).forUser(user.id)).toEqual(['crm']);
      // The assignment is kept, so resubscribing restores it rather than starting blank.
      expect(await svc(tx).assigned(user.id)).toEqual(['crm', 'desk']);
    });
  });

  it('withholds a module that is licensed but not assigned', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true });
      await assign(['desk']);
      expect(await svc(tx).forUser(user.id)).toEqual(['desk']);
    });
  });

  it('gives nothing when the licence is expired, whatever the flags say', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true, expiry: new Date(Date.now() - 86400000) });
      await assign(['crm', 'desk']);
      expect(await svc(tx).forUser(user.id)).toEqual([]);
      const licence = await svc(tx).licence();
      expect(licence.valid).toBe(false);
      expect(licence.status).toBe('expired');
    });
  });

  it('gives nothing when the subscription is suspended', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true, status: 'suspended' });
      await assign(['crm', 'desk']);
      expect(await svc(tx).forUser(user.id)).toEqual([]);
    });
  });

  it('honours a future expiry', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true, expiry: new Date(Date.now() + 86400000) });
      await assign(['crm', 'desk']);
      expect((await svc(tx).licence()).valid).toBe(true);
      expect(await svc(tx).forUser(user.id)).toEqual(['crm', 'desk']);
    });
  });
});

describe('the defaults fail open, so nobody is locked out by an empty table', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('treats a user with no module rows as having both', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx, { crm: true, desk: true });
      // Nothing assigned at all — a user created before this table existed, or by a caller that
      // does not know about it.
      expect(await svc(tx).assigned(user.id)).toEqual(['crm', 'desk']);
      expect(await svc(tx).forUser(user.id)).toEqual(['crm', 'desk']);
    });
  });

  it('treats a missing subscription as fully licensed', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx);
      await tx.subscriptions.deleteMany({ where: {} });
      await assign(['crm', 'desk']);
      const licence = await svc(tx).licence();
      expect({ crm: licence.crm, desk: licence.desk, valid: licence.valid }).toEqual({ crm: true, desk: true, valid: true });
      expect(await svc(tx).forUser(user.id)).toEqual(['crm', 'desk']);
    });
  });
});

describe('changing an assignment', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('adds, removes and is idempotent', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx, { crm: true, desk: true });
      const s = svc(tx);

      expect(await s.setAssigned(user.id, ['crm'])).toEqual(['crm']);
      expect(await s.assigned(user.id)).toEqual(['crm']);

      expect(await s.setAssigned(user.id, ['crm', 'desk'])).toEqual(['crm', 'desk']);
      expect(await s.assigned(user.id)).toEqual(['crm', 'desk']);

      // Saying the same thing twice must not create a second row.
      await s.setAssigned(user.id, ['crm', 'desk']);
      expect(await tx.user_modules.count({ where: { user_id: user.id } })).toBe(2);
    });
  });

  it('ignores anything that is not a module', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx, { crm: true, desk: true });
      expect(await svc(tx).setAssigned(user.id, ['crm', 'hrms', ''] as never)).toEqual(['crm']);
    });
  });

  it('can leave someone with nothing, which is a real answer', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: true, desk: true });
      await assign(['crm', 'desk']);
      expect(await svc(tx).setAssigned(user.id, [])).toEqual([]);
      // "None" has to be sayable. It is written down as disabled rows rather than by deleting them,
      // because no rows at all is the open default — so an administrator who unticked every module
      // used to grant both, which is the exact opposite of what they did.
      expect(await svc(tx).assigned(user.id)).toEqual([]);
      expect(await svc(tx).forUser(user.id)).toEqual([]);
      expect(await tx.user_modules.count({ where: { user_id: user.id } })).toBe(2);
    });
  });

  it('still treats a user nobody has decided about as having both', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx, { crm: true, desk: true });
      // The distinction the disabled rows exist to preserve: no rows is "not yet decided" and stays
      // open; two disabled rows is "decided: none" and is honoured.
      expect(await tx.user_modules.count({ where: { user_id: user.id } })).toBe(0);
      expect(await svc(tx).assigned(user.id)).toEqual(['crm', 'desk']);
    });
  });

  it('brings a module back after it was turned off', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx, { crm: true, desk: true });
      const s = svc(tx);
      await s.setAssigned(user.id, []);
      expect(await s.assigned(user.id)).toEqual([]);
      // Re-enabling flips the disabled row rather than tripping over the unique constraint.
      expect(await s.setAssigned(user.id, ['desk'])).toEqual(['desk']);
      expect(await s.assigned(user.id)).toEqual(['desk']);
    });
  });

  it('answers canOpen consistently with forUser', async () => {
    await inRollback(async (tx) => {
      const { user, assign } = await seed(tx, { crm: false, desk: true });
      await assign(['crm', 'desk']);
      const s = svc(tx);
      expect(await s.canOpen(user.id, 'crm')).toBe(false);
      expect(await s.canOpen(user.id, 'desk')).toBe(true);
      expect(await s.forUser(user.id)).toEqual(['desk']);
    });
  });
});

describe('the live data is untouched by any of this', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('has not leaked any assignment rows from the tests above', async () => {
    /*
     * WHAT THIS GUARDS, AND WHAT IT DELIBERATELY DOES NOT.
     *
     * It guards the thing this describe block is named for: the rolled-back tests above must not
     * leave rows behind in the live database.
     *
     * It used to assert `assigned === users * 2` — that every real user holds both modules. That is
     * NOT an invariant: an administrator may assign and remove modules, so one legitimate click in
     * the UI made this fail, and the failure said "the tests corrupted your data" when nothing of
     * the sort had happened. An assertion any authorised action can break is a false alarm
     * generator, not a guard.
     *
     * What IS invariant: nobody holds more than one active row per module, and every assignment
     * belongs to a user who exists. Both of those stay true however an administrator configures the
     * brokerage, and both would break if a test leaked.
     */
    const users = await prisma.users.count();
    const rows = await prisma.user_modules.findMany({
      where: { status: 'active' },
      select: { user_id: true, module_name: true },
    });

    // No duplicates: one active row per (user, module) at most.
    const seen = new Set(rows.map((r) => `${r.user_id}:${r.module_name}`));
    expect(seen.size).toBe(rows.length);

    // No orphans: every assignment points at a real user.
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const existing = await prisma.users.count({ where: { id: { in: ids } } });
    expect(existing).toBe(ids.length);

    // And nothing absurd: assignments cannot outnumber two per user.
    expect(rows.length).toBeLessThanOrEqual(users * 2);
  });

  it('still licenses both modules for the company', async () => {
    const sub = await prisma.subscriptions.findFirst();
    expect(sub).not.toBeNull();
    expect({ crm: sub!.crm_enabled, desk: sub!.transaction_enabled, status: sub!.status }).toEqual({ crm: true, desk: true, status: 'active' });
  });
});
