import { PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { RolesService } from './roles.service';
import { RolePermissionStore } from './role-permission.store';

/**
 * Editing roles at runtime.
 *
 * A roles screen is the easiest place in an application to lock everybody out of it, and failing
 * closed made that sharper: a role that grants nothing now really does grant nothing, and a user
 * whose role was deleted holds a key pointing at no row. So most of this is about what the service
 * REFUSES to do.
 *
 * Everything runs in a rolled-back transaction against the real schema. The store is reloaded from
 * the same transaction, so a grant written here is visible to the assertions that follow — which is
 * also the property the feature depends on: a permission change must take effect without a restart.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

const audit = { logModule: async () => undefined } as never;

async function inRollback(fn: (svc: RolesService, tx: PrismaService, store: RolePermissionStore) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      const t = tx as unknown as PrismaService;
      const store = new RolePermissionStore(t);
      await store.reload();
      await fn(new RolesService(t, store, audit), t, store);
      throw new Error(ROLLBACK);
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

describe('creating a role', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('adds one that grants nothing until it is given something', async () => {
    await inRollback(async (svc) => {
      const role = await svc.create(null, { key: 'auditor', label: 'Auditor' });
      expect(role.key).toBe('auditor');
      expect(role.is_system).toBe(false);
      expect(Object.values(role.permissions as Record<string, string>).every((l) => l === 'none')).toBe(true);
    });
  });

  it('can start from what another role grants', async () => {
    await inRollback(async (svc, _tx, store) => {
      const role = await svc.create(null, { key: 'agent2', label: 'Agent (copy)', copy_from: 'agent' });
      expect(role.permissions).toEqual(store.defaultsFor('agent'));
    });
  });

  it('refuses a key that is taken, malformed, or a name that is blank', async () => {
    await inRollback(async (svc) => {
      await expect(svc.create(null, { key: 'agent', label: 'Another' })).rejects.toThrow(/already exists/);
      await expect(svc.create(null, { key: 'Bad Key', label: 'x' })).rejects.toThrow(UnprocessableEntityException);
      await expect(svc.create(null, { key: '1abc', label: 'x' })).rejects.toThrow(UnprocessableEntityException);
      await expect(svc.create(null, { key: 'fine', label: '  ' })).rejects.toThrow(/needs a name/);
    });
  });
});

describe('changing what a role grants takes effect immediately', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('is visible to the next permission check without a restart', async () => {
    await inRollback(async (svc, _tx, store) => {
      const before = store.defaultsFor('agent');
      // Whatever it is today, it is not 'edit' — the assertion is that a change lands, not that the
      // seed happens to hold a particular value.
      expect(before?.reports).not.toBe('edit');

      const role = (await svc.list()).find((r) => r.key === 'agent')!;
      await svc.setGrants(null, role.id as number, { ...before, reports: 'edit' });

      // The store, not the database — this is the bit that used to need a deploy.
      expect(store.defaultsFor('agent')?.reports).toBe('edit');
    });
  });

  it('writes the implied lower level too, so "may view" cannot miss someone who may edit', async () => {
    await inRollback(async (svc, tx, store) => {
      const role = (await svc.list()).find((r) => r.key === 'agent')!;
      await svc.setGrants(null, role.id as number, { ...store.defaultsFor('agent'), reports: 'edit' });

      const rows = await tx.role_permissions.findMany({
        where: { role_id: role.id as number },
        select: { permissions: { select: { screen: true, level: true } } },
      });
      const reports = rows.filter((r) => r.permissions.screen === 'reports').map((r) => r.permissions.level).sort();
      expect(reports).toEqual(['edit', 'view']);
    });
  });

  it('revokes a screen that is left out', async () => {
    await inRollback(async (svc, _tx, store) => {
      const role = (await svc.list()).find((r) => r.key === 'agent')!;
      const withoutTransactions = { ...store.defaultsFor('agent'), transactions: 'none' };
      await svc.setGrants(null, role.id as number, withoutTransactions);
      expect(store.defaultsFor('agent')?.transactions).toBe('none');
    });
  });

  it('ignores a screen or level the application does not have', async () => {
    await inRollback(async (svc, _tx, store) => {
      const role = (await svc.list()).find((r) => r.key === 'agent')!;
      await svc.setGrants(null, role.id as number, { ...store.defaultsFor('agent'), not_a_screen: 'edit', lead: 'god' });
      const map = store.defaultsFor('agent')!;
      expect('not_a_screen' in map).toBe(false);
      expect(map.lead).not.toBe('god');
    });
  });
});

describe('the screen cannot be used to lock everyone out of it', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('will not delete a built-in role', async () => {
    await inRollback(async (svc) => {
      const admin = (await svc.list()).find((r) => r.key === 'admin')!;
      await expect(svc.remove(null, admin.id as number)).rejects.toThrow(/built-in/);
    });
  });

  it('will not delete a role somebody holds', async () => {
    await inRollback(async (svc, tx) => {
      const role = await svc.create(null, { key: 'temp', label: 'Temp' });
      await tx.users.create({
        data: { name: 'holder', email: `h-${Date.now()}@x.test`, password: 'x', role: 'temp', created_at: new Date(), updated_at: new Date() },
      });
      // Deleting would leave that account pointing at a role that does not exist, which under
      // fail-closed authorization means it can open nothing.
      await expect(svc.remove(null, role.id as number)).rejects.toThrow(/Move them to another role/);
    });
  });

  it('deletes a role nobody holds', async () => {
    await inRollback(async (svc) => {
      const role = await svc.create(null, { key: 'unused', label: 'Unused' });
      await expect(svc.remove(null, role.id as number)).resolves.toEqual({ message: 'Role deleted' });
      expect((await svc.list()).find((r) => r.key === 'unused')).toBeUndefined();
    });
  });

  it('will not retire a role somebody holds', async () => {
    await inRollback(async (svc) => {
      const agent = (await svc.list()).find((r) => r.key === 'agent')!;
      await expect(svc.update(null, agent.id as number, { is_active: false })).rejects.toThrow(/people hold this role|person holds this role/);
    });
  });

  it('will not take user administration away from the last role that has it', async () => {
    await inRollback(async (svc, tx, store) => {
      // Strip it from everyone except admin, which is the role the live users' administrator holds.
      for (const r of await svc.list()) {
        if (r.key === 'admin') continue;
        const map = store.defaultsFor(r.key as string)!;
        if (map.users === 'edit') await svc.setGrants(null, r.id as number, { ...map, users: 'view' });
      }
      const admin = (await svc.list()).find((r) => r.key === 'admin')!;
      const adminMap = store.defaultsFor('admin')!;
      await expect(svc.setGrants(null, admin.id as number, { ...adminMap, users: 'view' }))
        .rejects.toThrow(/only role that can manage users/);
      void tx;
    });
  });

  it('allows it when another role can still manage users', async () => {
    await inRollback(async (svc, _tx, store) => {
      // Give a second role the right first, then the original may give it up.
      const agent = (await svc.list()).find((r) => r.key === 'agent')!;
      await svc.setGrants(null, agent.id as number, { ...store.defaultsFor('agent'), users: 'edit' });

      const admin = (await svc.list()).find((r) => r.key === 'admin')!;
      await expect(svc.setGrants(null, admin.id as number, { ...store.defaultsFor('admin'), users: 'view' }))
        .resolves.toBeDefined();
    });
  });
});

describe('renaming', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('changes the label of a built-in role but never its key', async () => {
    await inRollback(async (svc) => {
      const agent = (await svc.list()).find((r) => r.key === 'agent')!;
      const renamed = await svc.update(null, agent.id as number, { label: 'Sales Associate', key: 'something_else' });
      expect(renamed.label).toBe('Sales Associate');
      // The key is what every grant and every user row points at; it is not editable.
      expect(renamed.key).toBe('agent');
    });
  });

  it('refuses a blank name', async () => {
    await inRollback(async (svc) => {
      const agent = (await svc.list()).find((r) => r.key === 'agent')!;
      await expect(svc.update(null, agent.id as number, { label: '   ' })).rejects.toThrow(/needs a name/);
    });
  });
});
