import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ModuleAccessService } from './module-access.service';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../auth/permission.service';
import { AccountLockoutService } from '../auth/account-lockout.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * The two holes this closes.
 *
 * Both were found by reading the code rather than by anything failing, which is the point: neither
 * announced itself. A deactivated user kept working, and module access was enforced on four
 * controllers out of forty-six while the navigation implied it was enforced everywhere.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

async function inRollback<T>(fn: (tx: PrismaService) => Promise<T>): Promise<T> {
  let out: T;
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

let seq = 0;
async function makeUser(tx: PrismaService, status?: string, role = 'agent') {
  const now = new Date();
  return tx.users.create({
    // Omitting status takes the column default rather than writing null — `status` is NOT NULL
    // DEFAULT 'Active', so an account created without an opinion is an active one.
    data: { name: `enforce ${++seq}`, email: `enf-${Date.now()}-${seq}@example.test`, password: 'x', role, ...(status ? { status } : {}), created_at: now, updated_at: now },
  });
}

describe('a deactivated account cannot keep using the session it already had', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** The real AuthService, with only the config it reads stubbed. */
  const authWith = (tx: PrismaService) =>
    new AuthService(tx, new PermissionService(), new ModuleAccessService(tx), new AccountLockoutService(), { get: () => 12 } as never);

  it('refuses to load an inactive user', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Inactive');
      // Null is what AuthGuard turns into 401 — the same answer as no session at all. Before this,
      // `login` was the only place status was checked, so closing an account did nothing to the
      // session it already had.
      expect(await authWith(tx).loadUser(user.id)).toBeNull();
    });
  });

  it('still loads an active user, and one whose status was never set', async () => {
    await inRollback(async (tx) => {
      const active = await makeUser(tx, 'Active');
      const defaulted = await makeUser(tx);
      expect(await authWith(tx).loadUser(active.id)).not.toBeNull();
      // An account that never had an opinion recorded is active — spelled the same way `login`
      // spells it, so the two cannot disagree about who is shut out.
      expect(await authWith(tx).loadUser(defaulted.id)).not.toBeNull();
    });
  });

  it('brings the account back when it is reactivated', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'Inactive');
      expect(await authWith(tx).loadUser(user.id)).toBeNull();
      await tx.users.update({ where: { id: user.id }, data: { status: 'Active' } });
      expect(await authWith(tx).loadUser(user.id)).not.toBeNull();
    });
  });
});

describe('module access is enforced on every screen, not only the four that name an area', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** A ScreenGuard wired to the real permission and module services. */
  function guardFor(tx: PrismaService, screen: string, level = 'view') {
    const reflector = { getAllAndOverride: (key: unknown) => (key === SCREEN_META ? { screen, level } : undefined) };
    return new ScreenGuard(reflector as never, new PermissionService(), new ModuleAccessService(tx));
  }

  const contextFor = (authUser: unknown) => ({
    switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  });

  /** An admin, so screen permission never masks what the module check is doing. */
  async function adminAssigned(tx: PrismaService, modules: string[]) {
    const user = await makeUser(tx, 'Active', 'admin');
    await new ModuleAccessService(tx).setAssigned(user.id, modules as never);
    const rows = await tx.user_modules.findMany({ where: { user_id: user.id } });
    return { ...user, user_permissions: [], user_modules: rows };
  }

  it('refuses a CRM screen to someone with only Transaction Desk', async () => {
    await inRollback(async (tx) => {
      const user = await adminAssigned(tx, ['desk']);
      // `lead` is a CRM screen and has no ?area= parameter, so AreaGuard never saw this request.
      await expect(guardFor(tx, 'lead').canActivate(contextFor(user) as never)).rejects.toThrow(ForbiddenException);
      await expect(guardFor(tx, 'lead').canActivate(contextFor(user) as never)).rejects.toThrow(/do not have access to/);
    });
  });

  it('refuses a Transaction Desk screen to someone with only the CRM', async () => {
    await inRollback(async (tx) => {
      const user = await adminAssigned(tx, ['crm']);
      await expect(guardFor(tx, 'transactions').canActivate(contextFor(user) as never)).rejects.toThrow(ForbiddenException);
      await expect(guardFor(tx, 'invoice').canActivate(contextFor(user) as never)).rejects.toThrow(ForbiddenException);
    });
  });

  it('allows the screens that do belong to the module someone has', async () => {
    await inRollback(async (tx) => {
      const crmOnly = await adminAssigned(tx, ['crm']);
      expect(await guardFor(tx, 'lead').canActivate(contextFor(crmOnly) as never)).toBe(true);
      expect(await guardFor(tx, 'campaigns').canActivate(contextFor(crmOnly) as never)).toBe(true);

      const deskOnly = await adminAssigned(tx, ['desk']);
      expect(await guardFor(tx, 'transactions').canActivate(contextFor(deskOnly) as never)).toBe(true);
      expect(await guardFor(tx, 'reports').canActivate(contextFor(deskOnly) as never)).toBe(true);
    });
  });

  it('never gates a shared screen', async () => {
    await inRollback(async (tx) => {
      const crmOnly = await adminAssigned(tx, ['crm']);
      const deskOnly = await adminAssigned(tx, ['desk']);
      // Users is genuinely shared, so neither module decides it. Gating a 'common' screen would lock
      // people out of settings for owning the wrong half of the application.
      expect(await guardFor(tx, 'users').canActivate(contextFor(crmOnly) as never)).toBe(true);
      expect(await guardFor(tx, 'users').canActivate(contextFor(deskOnly) as never)).toBe(true);
    });
  });

  it('does not gate a screen nobody classified', async () => {
    await inRollback(async (tx) => {
      const user = await adminAssigned(tx, ['crm']);
      // Fail open on a missing entry: inventing a module for an unclassified screen would lock
      // people out on the strength of an omission. The permission layer still rejects a screen it
      // does not know — which is the point. The rejection must come from THERE, not from the module
      // check, so an unclassified screen is never mistaken for an unlicensed one.
      await expect(guardFor(tx, 'not-a-real-screen').canActivate(contextFor(user) as never))
        .rejects.toThrow(/permission to perform/);
    });
  });

  it('leaves screen permissions doing their own job', async () => {
    await inRollback(async (tx) => {
      // A CRM user with the crm role, which has no access to transactions. The module check passes
      // for a CRM screen and the permission check still decides the rest.
      const user = await makeUser(tx, 'Active', 'crm');
      await new ModuleAccessService(tx).setAssigned(user.id, ['crm', 'desk'] as never);
      const rows = await tx.user_modules.findMany({ where: { user_id: user.id } });
      const record = { ...user, user_permissions: [], user_modules: rows };

      expect(await guardFor(tx, 'lead').canActivate(contextFor(record) as never)).toBe(true);
      // Module says yes, permission says no — and the message is the permission one.
      await expect(guardFor(tx, 'transactions').canActivate(contextFor(record) as never)).rejects.toThrow(/permission to perform/);
    });
  });

  it('says when the module was never bought, rather than blaming permissions', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      await tx.subscriptions.upsert({
        where: { company_id: 1 },
        create: { company_id: 1, crm_enabled: false, transaction_enabled: true, status: 'active', created_at: now, updated_at: now },
        update: { crm_enabled: false, transaction_enabled: true, status: 'active', updated_at: now },
      });
      const user = await adminAssigned(tx, ['crm', 'desk']);
      // Assigned but not licensed. "No access" would send an administrator hunting through
      // permissions for something no permission can fix.
      await expect(guardFor(tx, 'lead').canActivate(contextFor(user) as never)).rejects.toThrow(/not part of this subscription/);
    });
  });

  it('costs no extra query when the user arrived with their module rows', async () => {
    await inRollback(async (tx) => {
      const user = await adminAssigned(tx, ['crm']);
      let queries = 0;
      const counting = new ModuleAccessService({
        ...(tx as object),
        user_modules: { findMany: () => { queries++; return Promise.resolve([]); } },
      } as never);
      const reflector = { getAllAndOverride: () => ({ screen: 'lead', level: 'view' }) };
      const guard = new ScreenGuard(reflector as never, new PermissionService(), counting);

      await guard.canActivate(contextFor(user) as never);
      // The rows came with the user from AuthGuard, so the guard must not go and fetch them again.
      expect(queries).toBe(0);
    });
  });
});
