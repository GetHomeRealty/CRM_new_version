import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { AccountLockoutService } from './account-lockout.service';
import { PasswordHashService } from './password-hash.service';
import { PasswordResetService } from './password-reset.service';
import { PermissionService } from './permission.service';
import { passwordPolicyProblem } from './password-policy';
import { ModuleAccessService } from '../core/module-access.service';
import { UsersService } from '../users/users.service';
import { OffboardingService } from '../users/offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import type { AuthUserRecord } from './auth.types';

/**
 * ONE RULE, ASKED BY EVERY ROUTE THAT SETS A PASSWORD.
 *
 * `password-policy.spec.ts` tests the rule itself. This tests the wiring, which is where the
 * original defect actually lived: there was never a shortage of password rules in this application
 * — there were three, in three files, all saying eight characters, and `Admin@123` satisfied every
 * one of them. A fourth route had no minimum at all for a while and nobody noticed, because
 * nothing asserted that the four agreed.
 *
 * So each test below drives a REAL route to the point where it accepts or refuses a password, and
 * the last one asserts they all refuse the same password for the same stated reason. Adding a
 * fifth way to set a password without asking the shared rule fails that test.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** The password the production audit found accepted on a Super Admin account. */
const THE_BAD_PASSWORD = 'Admin@123';
/** Long, unrelated words: what the rule is meant to steer people towards. */
const A_GOOD_PASSPHRASE = 'quarry lantern ninety';

const auditRows: Record<string, unknown>[] = [];
const recordingAudit = {
  logModule: async (_actor: unknown, _module: string, row: Record<string, unknown>) => { auditRows.push(row); },
  record: async (row: Record<string, unknown>) => { auditRows.push(row); },
} as never;
const noGraph = { fetchPages: async () => [] } as never;
const actor = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;

const usersService = (tx: PrismaService) => new UsersService(
  tx,
  new PermissionService(),
  new ModuleAccessService(tx),
  recordingAudit,
  new OffboardingService(tx, new MetaConnectionService(tx, noGraph), new LeadTransferService(tx, noAuditService())),
  new PasswordHashService(new ConfigService()),
);
function noAuditService() { return { logModule: async () => {}, record: async () => {} } as never; }

const authService = (tx: PrismaService) => new AuthService(
  tx,
  new PermissionService(),
  new ModuleAccessService(tx),
  new AccountLockoutService(),
  new PasswordHashService(new ConfigService()),
);

const userBody = (over: Record<string, unknown> = {}) => {
  const t = tag();
  return {
    name: `Probe ${t}`, username: `probe-${t}`, email: `probe-${t}@example.test`,
    password: A_GOOD_PASSPHRASE, password_confirmation: A_GOOD_PASSPHRASE,
    role: 'agent', status: 'Active',
    profile: { mobile: '416-555-0100', gender: 'Other' },
    ...over,
  };
};

/**
 * The field errors a validation failure carried, whichever shape the route threw.
 *
 * ANYTHING THAT IS NOT A VALIDATION FAILURE IS RE-THROWN. The first version of this returned `{}`
 * for every exception, and a stub missing one Prisma method therefore produced a TypeError that
 * arrived here as "no errors" — indistinguishable from a route that accepted the password. The
 * test failed for the right reason by luck; it could as easily have passed while proving nothing.
 */
async function errorsFrom(fn: () => Promise<unknown>): Promise<Record<string, string[]>> {
  try { await fn(); return {}; } catch (e) {
    const res = (e as { getResponse?: () => unknown }).getResponse?.() as { errors?: Record<string, string[]> } | undefined;
    if (!res?.errors) throw e;
    return res.errors;
  }
}

/** The reset route's prisma surface, stubbed — this spec is about the rule, not about mail. */
function resetHarness() {
  const updates: Record<string, unknown>[] = [];
  const user = { id: 77, name: 'Reset Probe', email: 'reset@example.test', status: 'Active' };
  // The row stores the SHA-256 of the token, which is what the service compares against.
  const token = 'a'.repeat(64);
  const storedHash = createHash('sha256').update(token).digest('hex');
  const prismaStub = {
    users: {
      findFirst: async () => user,
      findUnique: async () => user,
      update: async (args: { data: Record<string, unknown> }) => { updates.push(args.data); return user; },
    },
    password_reset_tokens: {
      // `findFirst` is the one the service calls; the others are here so a refusal that happens to
      // take a different branch fails on the assertion rather than on a missing stub.
      findFirst: async () => ({ email: user.email, token: storedHash, created_at: new Date() }),
      findUnique: async () => ({ email: user.email, token: storedHash, created_at: new Date() }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
    },
    user_sessions: { deleteMany: async () => ({ count: 0 }) },
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
  } as unknown as PrismaService;

  const moduleRef = { get: () => ({ sendDirect: async () => {} }) } as never;
  const svc = new PasswordResetService(prismaStub, new PasswordHashService(new ConfigService()), moduleRef);
  return { svc, token, email: user.email, updates };
}

describe('every route that sets a password asks the one rule', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  describe('1. an administrator creating a colleague (users.service)', () => {
    it(`refuses ${THE_BAD_PASSWORD}`, async () => {
      await inRollback(async (tx) => {
        const errors = await errorsFrom(() => usersService(tx).store(actor, userBody({
          password: THE_BAD_PASSWORD, password_confirmation: THE_BAD_PASSWORD,
        })));
        expect(Object.keys(errors)).toContain('password');
        expect(errors.password[0]).toBe(passwordPolicyProblem(THE_BAD_PASSWORD));
      });
    });

    it('accepts a passphrase', async () => {
      await inRollback(async (tx) => {
        const created = await usersService(tx).store(actor, userBody()) as { id: number };
        expect(created.id).toEqual(expect.any(Number));
      });
    });

    it('refuses it on EDIT as well as on create', async () => {
      await inRollback(async (tx) => {
        const s = usersService(tx);
        const created = await s.store(actor, userBody()) as { id: number };
        const errors = await errorsFrom(() => s.update(actor, created.id, userBody({
          password: THE_BAD_PASSWORD, password_confirmation: THE_BAD_PASSWORD,
        })));
        expect(Object.keys(errors)).toContain('password');
      });
    });
  });

  describe('2. somebody changing their own (auth.service)', () => {
    it(`refuses ${THE_BAD_PASSWORD}`, async () => {
      await inRollback(async (tx) => {
        const passwords = new PasswordHashService(new ConfigService());
        const current = 'harbour thimble rowan';
        const user = { id: 1, password: await passwords.hashPassword(current) } as unknown as AuthUserRecord;
        const errors = await errorsFrom(() => authService(tx).changePassword(user, current, THE_BAD_PASSWORD, THE_BAD_PASSWORD));
        expect(Object.keys(errors)).toContain('password');
        expect(errors.password[0]).toBe(passwordPolicyProblem(THE_BAD_PASSWORD));
      });
    });
  });

  describe('3. a forgotten password (password-reset.service)', () => {
    it(`refuses ${THE_BAD_PASSWORD}, and stores nothing`, async () => {
      const { svc, token, email, updates } = resetHarness();
      const errors = await errorsFrom(() => svc.reset(email, token, THE_BAD_PASSWORD, THE_BAD_PASSWORD, async () => {}));
      expect(Object.keys(errors)).toContain('password');
      expect(errors.password[0]).toBe(passwordPolicyProblem(THE_BAD_PASSWORD));
      // The refusal has to come BEFORE the write, or a weak password is stored and then complained about.
      expect(updates).toHaveLength(0);
    });
  });

  describe('4. registration (auth.service)', () => {
    /*
     * Registration refuses outright once any user exists, and the shared database always has some
     * — so an empty one is stubbed. Without that the route would refuse for the OTHER reason and
     * the test would pass while proving nothing about the password.
     */
    const emptyInstall = () => ({
      users: {
        count: async () => 0,
        findFirst: async () => null,
        create: async (args: { data: Record<string, unknown> }) => ({ id: 1, ...args.data }),
      },
    } as unknown as PrismaService);

    it(`refuses ${THE_BAD_PASSWORD}`, async () => {
      const errors = await errorsFrom(() => authService(emptyInstall())
        .register('First Admin', `reg-${tag()}@example.test`, THE_BAD_PASSWORD, THE_BAD_PASSWORD));
      expect(Object.keys(errors)).toContain('password');
      expect(errors.password[0]).toBe(passwordPolicyProblem(THE_BAD_PASSWORD));
    });

    it('accepts a passphrase', async () => {
      await expect(authService(emptyInstall())
        .register('First Admin', `reg-${tag()}@example.test`, A_GOOD_PASSPHRASE, A_GOOD_PASSPHRASE))
        .resolves.toBeTruthy();
    });
  });

  describe('they agree', () => {
    it('every password-setting route calls the shared rule, by source', () => {
      const root = join(__dirname, '..');
      const sites = [
        'users/users.service.ts',
        'auth/auth.service.ts',
        'auth/password-reset.service.ts',
      ];
      for (const site of sites) {
        expect(readFileSync(join(root, site), 'utf8')).toContain('passwordPolicyProblem');
      }
    });

    it('no route carries a competing minimum of its own', () => {
      const root = join(__dirname, '..');
      for (const site of ['auth/dto/change-password.dto.ts', 'auth/dto/register.dto.ts']) {
        const source = readFileSync(join(root, site), 'utf8');
        // A @MinLength on a password field is a second rule; the one rule is the policy module.
        expect(source).not.toMatch(/@MinLength\(\d+\)\s*\n\s*password/);
      }
    });
  });
});

describe('what the rule must NOT do', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /**
   * The compatibility promise. Every existing password in the database predates this rule and most
   * would fail it; applying it at sign-in would lock out precisely the people who need to get in
   * and change theirs.
   */
  it('lets an existing account with a now-forbidden password still sign in', async () => {
    await inRollback(async (tx) => {
      const passwords = new PasswordHashService(new ConfigService());
      const t = tag();
      const email = `legacy-${t}@example.test`;
      await tx.users.create({
        data: {
          name: `Legacy ${t}`, username: `legacy-${t}`, email,
          // Stored before the policy existed, and refused by it today.
          password: await passwords.hashPassword(THE_BAD_PASSWORD),
          role: 'agent', status: 'Active', created_at: new Date(), updated_at: new Date(),
        },
      });

      expect(passwordPolicyProblem(THE_BAD_PASSWORD)).toEqual(expect.any(String));
      await expect(authService(tx).login(email, THE_BAD_PASSWORD)).resolves.toBeTruthy();
    });
  });

  it('never writes a password into an audit row', async () => {
    await inRollback(async (tx) => {
      auditRows.length = 0;
      const secret = 'kettle harbour ninety';
      await usersService(tx).store(actor, userBody({ password: secret, password_confirmation: secret }));

      expect(auditRows.length).toBeGreaterThan(0);
      const written = JSON.stringify(auditRows);
      expect(written).not.toContain(secret);
      expect(written.toLowerCase()).not.toContain('password');
    });
  });
});
