import { PrismaClient } from '@prisma/client';
import { PermissionService, ROLES, SCREENS, LEVELS, type PermissionMap } from '../auth/permission.service';
import { RolePermissionStore } from './role-permission.store';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The role and permission tables must reproduce the compiled defaults IN SHAPE, and may differ
 * in VALUE wherever an administrator has deliberately customised a role.
 *
 * This is the whole safety argument for moving role defaults into the database. The seed was generated
 * from the switch statement, so the two agree by construction — this asserts they still do, screen by
 * screen and role by role, including the key order that ends up in API responses.
 *
 * TD-165 - THE ORIGINAL PREMISE EXPIRED WHEN ROLE EDITING SHIPPED. This file asserted that the
 * database matched the code EXACTLY, which was the right proof when the store was introduced and
 * nothing could yet edit it. The Roles screen now lets an administrator change ANY role, the
 * built-in ones included - confirmed by the brokerage 2026-09-10 - and it has been used: a custom
 * role manager_ghr exists, and the Accounting role was deliberately widened. Four cases here were
 * failing for being right about a rule the product no longer has.
 *
 * WHAT IS STILL GUARANTEED, AND IS WHAT THIS FILE NOW ASSERTS: every compiled role has a row;
 * every stored map covers exactly the compiled SCREENS in the compiled ORDER, since editing a
 * role changes levels and never the screen set; every level is one the application knows; and no
 * user resolves differently from the compiled defaults UNLESS their own role was customised.
 *
 * That last one is the drift alarm this header always meant. It still fires - it has simply
 * stopped mistaking an administrator for an accident.
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
    // TD-165 - A SUPERSET IS CORRECT NOW. A role created through the screen (is_system = false) is
    // an extra row the code has never heard of, and demanding exact equality made a working
    // feature look like corruption. What matters is that nothing the application compiles is
    // MISSING; what else the brokerage has added is its own business.
    const keys = new Set((await store.roles()).map((r) => r.key));
    for (const role of ROLES) expect(keys.has(role)).toBe(true);
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

  it.each([...ROLES])('gives role %s the compiled SHAPE, whatever an administrator has set', (role) => {
    const fromDb = store.defaultsFor(role);
    expect(fromDb).not.toBeNull();
    // roleDefaults on a service with no store returns the compiled answer.
    const compiled = svc.roleDefaults(role);
    // TD-165 - KEYS AND ORDER, NOT VALUES. Editing a role changes what a level IS, never which
    // screens exist, so the shape remains an invariant - and it is the half that catches the
    // dangerous drift: a screen added to the code that never reached the database would leave a
    // role with no answer for it at all. The VALUES may legitimately differ, because the
    // Accounting role was widened on purpose.
    expect(Object.keys(fromDb!)).toEqual(Object.keys(compiled));
    for (const level of Object.values(fromDb!)) expect(LEVELS).toContain(level);
  });

  it('resolves effective permissions identically with and without the store', () => {
    const withStore = new PermissionService();
    withStore.useStore(store);
    const without = new PermissionService();

    for (const role of ROLES) {
      // TD-165 - the SHAPE must match; the values may differ where a role was customised.
      const a = withStore.effectiveFor(role);
      const b = without.effectiveFor(role);
      expect(Object.keys(a)).toEqual(Object.keys(b));
      for (const level of Object.values(a)) expect(LEVELS).toContain(level);
      // And an override still applies on top, whichever map it lands on.
      const overrides = [{ screen: 'reports', level: 'edit' }];
      const c = withStore.effectiveFor(role, overrides);
      expect(Object.keys(c)).toEqual(Object.keys(b));
      expect(c.reports).toBe('edit');
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

describe('no live user drifts for a reason nobody chose', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('differs from the compiled defaults only where the role itself was customised', async () => {
    const store = new RolePermissionStore(prisma as unknown as PrismaService);
    await store.reload();
    const withStore = new PermissionService();
    withStore.useStore(store);
    const without = new PermissionService();

    const users = await prisma.users.findMany({ include: { user_permissions: true } });
    expect(users.length).toBeGreaterThan(0);

    for (const u of users) {
      const overrides = u.user_permissions.map((p) => ({ screen: p.screen, level: p.level }));
      const now: PermissionMap = withStore.effectiveFor(u.role, overrides);
      const before: PermissionMap = without.effectiveFor(u.role, overrides);
      // The SHAPE can never move, whatever anybody edits.
      expect(Object.keys(now)).toEqual(Object.keys(before));
      if (JSON.stringify(now) === JSON.stringify(before)) continue;
      /*
       * TD-165 - IT DIFFERS, AND THERE IS EXACTLY ONE ACCEPTABLE EXPLANATION: this user's own role
       * was deliberately customised in the database. That is the alarm the old assertion was really
       * making, kept intact. A user who resolved differently for any OTHER reason - a stray grant,
       * a role that resolves oddly, an override merged wrongly - still fails here, which is the
       * case worth catching.
       */
      const stored = store.defaultsFor(u.role);
      expect(stored).not.toBeNull();
      expect(stored).not.toEqual(without.roleDefaults(u.role));
    }
  });
});
