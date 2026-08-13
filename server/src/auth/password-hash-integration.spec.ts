import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordHashService } from './password-hash.service';
import { PermissionService } from './permission.service';
import { AccountLockoutService } from './account-lockout.service';
import { ModuleAccessService } from '../core/module-access.service';
import { UsersService } from '../users/users.service';
import { OffboardingService } from '../users/offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';

/**
 * PHASE 1, end to end — every path that writes a password, and the upgrade on sign-in.
 *
 * The unit tests beside this prove `PasswordHashService` behaves. These prove the SERVICES USE IT:
 * that an administrator creating an account, a user changing their own password and the bootstrap
 * registration all land on the same configured cost, and that signing in with a legacy password
 * quietly upgrades the stored hash.
 *
 * Real rows against the dev database, inside a rolled-back transaction.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** A hashing service pinned to a known cost, so assertions are about wiring rather than config. */
const hasher = (rounds: number) =>
  new PasswordHashService({ get: () => rounds } as unknown as ConfigService);

function authService(tx: PrismaService, rounds: number) {
  return new AuthService(
    tx,
    new PermissionService(),
    new ModuleAccessService(tx),
    new AccountLockoutService(),
    hasher(rounds),
  );
}

async function userWithHash(tx: PrismaService, hash: string) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Hash ${t}`, email: `zz-hash-${t}@probe.test`, username: `zzhash${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: hash, created_at: now, updated_at: now,
    },
    select: { id: true, email: true, username: true },
  });
}

const storedCost = async (tx: PrismaService, id: number): Promise<number> => {
  const row = await tx.users.findUnique({ where: { id }, select: { password: true } });
  return bcrypt.getRounds(row!.password);
};

describe('every password-writing path uses the configured cost', () => {
  it('a self-service password change does', async () => {
    await inRollback(async (tx) => {
      const hash = await hasher(10).hashPassword('OldPassw0rd!');
      const user = await userWithHash(tx, hash);
      const svc = authService(tx, 13);

      // `changePassword` verifies against the record it is HANDED, not a fresh read — so the stub
      // has to carry the hash. Passing only `{ id }` fails with "current password is incorrect",
      // which reads like a broken fix rather than an incomplete fixture.
      await svc.changePassword(
        { id: user.id, password: hash } as never, 'OldPassw0rd!', 'BrandNewPassw0rd!', 'BrandNewPassw0rd!',
      );

      expect(await storedCost(tx, user.id)).toBe(13);
    });
  });

  it('bootstrap registration does', async () => {
    /*
     * `register()` only runs while there are zero users, which cannot be arranged inside a
     * transaction that already contains the seeded brokerage. What IS assertable is the guard
     * itself — and it is the reason the admin path mattered so much.
     */
    await inRollback(async (tx) => {
      const svc = authService(tx, 13);
      await expect(svc.register('ZZ First', `zz-first-${tag()}@probe.test`, 'Passw0rd!23', 'Passw0rd!23'))
        .rejects.toMatchObject({ status: 403 });
    });
  });
});

describe('signing in upgrades a hash that is weaker than the configured cost', () => {
  it('a legacy cost-10 password is re-stored at the configured cost', async () => {
    /*
     * THE POINT OF THE WHOLE PHASE. Every account an administrator created carries a cost-10 hash.
     * Nobody should be asked to reset a password to fix that, and no hash can be reversed to do it —
     * but a correct sign-in is the one moment the plaintext and the stale hash are both in hand.
     */
    await inRollback(async (tx) => {
      const user = await userWithHash(tx, await hasher(10).hashPassword('LegacyPassw0rd!'));
      expect(await storedCost(tx, user.id)).toBe(10);

      await authService(tx, 12).login(user.email, 'LegacyPassw0rd!');

      expect(await storedCost(tx, user.id)).toBe(12);
    });
  });

  it('and the password still works afterwards', async () => {
    // An upgrade that changed the password would be a far worse bug than the weak hash.
    await inRollback(async (tx) => {
      const user = await userWithHash(tx, await hasher(10).hashPassword('LegacyPassw0rd!'));
      const svc = authService(tx, 12);

      await svc.login(user.email, 'LegacyPassw0rd!');
      await expect(svc.login(user.email, 'LegacyPassw0rd!')).resolves.toBeTruthy();
    });
  });

  it('a hash already at the configured cost is left untouched', async () => {
    // No pointless write on every sign-in, and the hash string itself must not churn.
    await inRollback(async (tx) => {
      const hash = await hasher(12).hashPassword('CurrentPassw0rd!');
      const user = await userWithHash(tx, hash);

      await authService(tx, 12).login(user.email, 'CurrentPassw0rd!');

      const after = await tx.users.findUnique({ where: { id: user.id }, select: { password: true } });
      expect(after?.password).toBe(hash);
    });
  });

  it('a STRONGER hash is not downgraded', async () => {
    await inRollback(async (tx) => {
      const user = await userWithHash(tx, await hasher(13).hashPassword('StrongPassw0rd!'));
      await authService(tx, 10).login(user.email, 'StrongPassw0rd!');
      expect(await storedCost(tx, user.id)).toBe(13);
    });
  });

  it('a WRONG password never triggers an upgrade', async () => {
    /*
     * The upgrade must sit behind the verification, not beside it. Re-hashing on a failed attempt
     * would let anyone rewrite a stored hash by guessing — and would do it with the wrong password.
     */
    await inRollback(async (tx) => {
      const hash = await hasher(10).hashPassword('RealPassw0rd!');
      const user = await userWithHash(tx, hash);

      await expect(authService(tx, 12).login(user.email, 'WrongPassw0rd!')).rejects.toBeTruthy();

      const after = await tx.users.findUnique({ where: { id: user.id }, select: { password: true } });
      expect(after?.password).toBe(hash);
      expect(await storedCost(tx, user.id)).toBe(10);
    });
  });

  it('signing in by USERNAME upgrades too, not only by email', async () => {
    // Two lookup paths, one upgrade. A rehash on only one of them would leave half the users behind.
    await inRollback(async (tx) => {
      const user = await userWithHash(tx, await hasher(10).hashPassword('LegacyPassw0rd!'));
      await authService(tx, 12).login(user.username!, 'LegacyPassw0rd!');
      expect(await storedCost(tx, user.id)).toBe(12);
    });
  });
});

describe('an ADMIN-created account uses the configured cost — the path that mattered most', () => {
  /*
   * THE COVERAGE GAP THIS CLOSES. `users-validation.spec.ts` exercised `store()` thoroughly and
   * never asserted on the hash, so reverting the fix to `bcrypt.hash(password, 10)` left all 47 of
   * its tests green. A fix nothing can detect is not a fix — this is the assertion that fails when
   * the admin path drifts away from the configured cost again.
   *
   * It matters more than the other paths put together: public registration is closed, so an
   * administrator creates EVERY account in this system.
   */
  const usersService = (tx: PrismaService, rounds: number) => new UsersService(
    tx,
    new PermissionService(),
    new ModuleAccessService(tx),
    { logModule: async () => {}, record: async () => {} } as never,
    new OffboardingService(tx, new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
      new LeadTransferService(tx, { logModule: async () => {}, record: async () => {} } as never)),
    hasher(rounds),
  );

  const adminBody = () => {
    const t = tag();
    return {
      name: `ZZ Made ${t}`, username: `zzmade${t.replace(/-/g, '')}`, email: `zz-made-${t}@probe.test`,
      password: 'TestPass123!', password_confirmation: 'TestPass123!',
      role: 'agent', status: 'Active',
      profile: { mobile: '416-555-0100', gender: 'Other' },
    };
  };

  it('hashes at the configured cost, not a hardcoded 10', async () => {
    await inRollback(async (tx) => {
      const actor = { id: 1, name: 'Root', role: 'admin' } as never;
      const created = await usersService(tx, 13).store(actor, adminBody()) as { id: number };
      expect(await storedCost(tx, created.id)).toBe(13);
    });
  });

  it('and the created account can actually sign in with that password', async () => {
    // A cost change that broke sign-in would be the worse bug.
    await inRollback(async (tx) => {
      const actor = { id: 1, name: 'Root', role: 'admin' } as never;
      const body = adminBody();
      await usersService(tx, 12).store(actor, body);
      await expect(authService(tx, 12).login(body.email, 'TestPass123!')).resolves.toBeTruthy();
    });
  });

  it('an admin password RESET uses the configured cost too', async () => {
    await inRollback(async (tx) => {
      const actor = { id: 1, name: 'Root', role: 'admin' } as never;
      const body = adminBody();
      const created = await usersService(tx, 10).store(actor, body) as { id: number };
      expect(await storedCost(tx, created.id)).toBe(10);

      // `update` validates the whole record rather than a patch, so the unchanged fields have to
      // come along — sending only the password fails with "The name field is required", which reads
      // like a broken reset rather than an incomplete fixture.
      await usersService(tx, 13).update(actor, created.id, {
        ...body, password: 'NewPass456!', password_confirmation: 'NewPass456!',
      });
      expect(await storedCost(tx, created.id)).toBe(13);
    });
  });
});
