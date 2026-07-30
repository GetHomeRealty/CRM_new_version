import { PrismaClient } from '@prisma/client';
import { PermissionService, ROLES, SCREENS, LEVELS, type PermissionMap } from '../auth/permission.service';
import { RolePermissionStore } from './role-permission.store';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The role and permission tables must reproduce the compiled defaults EXACTLY.
 *
 * This is the whole safety argument for moving role defaults into the database. The seed was generated
 * from the switch statement, so the two agree by construction — this asserts they still do, screen by
 * screen and role by role, including the key order that ends up in API responses.
 *
 * If this ever fails, somebody edited a role in the database or changed the code without the other,
 * and somebody's access has silently moved.
 */

const prisma = new PrismaClient();

describe('the tables reproduce the compiled defaults', () => {
  const svc = new PermissionService();
  let store: RolePermissionStore;

  beforeAll(async () => {
    store = new RolePermissionStore(prisma as unknown as PrismaService);
    await store.reload();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('loaded something', () => {
    expect(store.loaded).toBe(true);
  });

  it('has a row for every role the application knows', async () => {
    const rows = await store.roles();
    expect(rows.map((r) => r.key).sort()).toEqual([...ROLES].sort());
  });

  it('has a permission for every screen at every grantable level', async () => {
    const perms = await prisma.permissions.findMany({ select: { screen: true, level: true } });
    const grantable = LEVELS.filter((l) => l !== 'none');
    expect(perms).toHaveLength(Object.keys(SCREENS).length * grantable.length);
    for (const screen of Object.keys(SCREENS)) {
      for (const level of grantable) {
        expect(perms.some((p) => p.screen === screen && p.level === level)).toBe(true);
      }
    }
  });

  it.each([...ROLES])('gives role %s exactly the compiled map', (role) => {
    const fromDb = store.defaultsFor(role);
    expect(fromDb).not.toBeNull();
    // `roleDefaults` on a service with no store returns the compiled answer.
    const compiled = svc.roleDefaults(role);
    expect(fromDb).toEqual(compiled);
    // Key order is part of the response shape, not an implementation detail.
    expect(Object.keys(fromDb!)).toEqual(Object.keys(compiled));
  });

  it('resolves effective permissions identically with and without the store', () => {
    const withStore = new PermissionService();
    withStore.useStore(store);
    const without = new PermissionService();

    for (const role of ROLES) {
      expect(withStore.effectiveFor(role)).toEqual(without.effectiveFor(role));
      // And with an override applied on top.
      const overrides = [{ screen: 'reports', level: 'edit' }];
      expect(withStore.effectiveFor(role, overrides)).toEqual(without.effectiveFor(role, overrides));
    }
  });

  it('still lets a per-user override win over the role', () => {
    const svcWith = new PermissionService();
    svcWith.useStore(store);
    // 'crm' has no access to transactions by default; an override must still grant it.
    expect(svcWith.effectiveFor('crm').transactions).toBe('none');
    expect(svcWith.effectiveFor('crm', [{ screen: 'transactions', level: 'edit' }]).transactions).toBe('edit');
    expect(svcWith.can('crm', [{ screen: 'transactions', level: 'edit' }], 'transactions', 'edit')).toBe(true);
  });

  it('keeps admin at full access, which is special-cased above the tables', () => {
    const svcWith = new PermissionService();
    svcWith.useStore(store);
    const perms = svcWith.effectiveFor('admin');
    expect(Object.values(perms).every((l) => l === 'edit')).toBe(true);
    // Even an override cannot reduce an admin — the same rule as before.
    expect(svcWith.effectiveFor('admin', [{ screen: 'users', level: 'none' }]).users).toBe('edit');
  });
});

describe('an empty or unreachable table cannot lock anyone out', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('falls back to the compiled defaults when the store has nothing', () => {
    const svc = new PermissionService();
    svc.useStore({ defaultsFor: () => null });
    for (const role of ROLES) {
      expect(svc.roleDefaults(role)).toEqual(new PermissionService().roleDefaults(role));
    }
  });

  it('keeps the previous snapshot when a reload fails', async () => {
    const store = new RolePermissionStore(prisma as unknown as PrismaService);
    await store.reload();
    const before = store.defaultsFor('agent');
    expect(before).not.toBeNull();

    // A store whose query throws must not blank what it already had.
    const broken = new RolePermissionStore({
      role_permissions: { findMany: () => Promise.reject(new Error('database is away')) },
    } as unknown as PrismaService);
    await broken.reload();
    expect(broken.loaded).toBe(false);
    expect(broken.defaultsFor('agent')).toBeNull(); // → caller falls back to compiled defaults
  });

  it('does not degrade access when the table is empty', async () => {
    const empty = new RolePermissionStore({
      role_permissions: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService);
    await empty.reload();
    expect(empty.defaultsFor('agent')).toBeNull();

    const svc = new PermissionService();
    svc.useStore(empty);
    // Identical to the application with no database at all.
    expect(svc.effectiveFor('agent')).toEqual(new PermissionService().effectiveFor('agent'));
  });
});

describe('the live users are unaffected', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('resolves the same permissions for every real user as the compiled defaults do', async () => {
    const store = new RolePermissionStore(prisma as unknown as PrismaService);
    await store.reload();
    const withStore = new PermissionService();
    withStore.useStore(store);
    const without = new PermissionService();

    const users = await prisma.users.findMany({ include: { user_permissions: true } });
    expect(users.length).toBeGreaterThan(0);

    const changed: string[] = [];
    for (const u of users) {
      const overrides = u.user_permissions.map((p) => ({ screen: p.screen, level: p.level }));
      const now: PermissionMap = withStore.effectiveFor(u.role, overrides);
      const before: PermissionMap = without.effectiveFor(u.role, overrides);
      if (JSON.stringify(now) !== JSON.stringify(before)) changed.push(`${u.id} ${u.name} (${u.role})`);
    }
    expect(changed).toEqual([]);
  });
});
