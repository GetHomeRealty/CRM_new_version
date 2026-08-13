import { ModuleAccessService } from '../core/module-access.service';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PasswordHashService } from './password-hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { throwValidation } from '../common/laravel-exceptions';
import { PermissionService } from './permission.service';
import type { AuthPayload, AuthUserRecord } from './auth.types';
import { AccountLockoutService } from './account-lockout.service';

import { isAdminOrAbove, isSuperAdmin } from '../core/authz';

/**
 * bcrypt reads at most 72 bytes and silently ignores the rest.
 *
 * Left unchecked that is not a cosmetic limit: a 100-character passphrase and its first 72 bytes
 * are the same password as far as the hash is concerned, so the account is weaker than the person
 * setting it believes. `users.service.ts` already refuses anything longer; the two self-service
 * paths here did not, so the same password was accepted or rejected depending on which screen it
 * was typed into.
 */


@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly lockout: AccountLockoutService,
    private readonly passwords: PasswordHashService,
  ) {}

  /**
   * Shape the public user payload — a copy of AuthController::payload().
   *
   * `modules` and `licence` are added asynchronously by `payloadFor`; this synchronous form is kept
   * because several callers build a payload where awaiting is not possible, and they are not asking
   * about module access.
   */
  buildPayload(user: AuthUserRecord): AuthPayload {
    const role = user.role || 'agent';
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      role_label: this.permissions.label(role),
      // The client shows and hides on these three. They come from the engine so the interface and
      // the API can never disagree about who counts as an administrator.
      is_admin: isSuperAdmin(user),
      is_super_admin: isSuperAdmin(user),
      is_admin_or_above: isAdminOrAbove(user),
      permissions: this.permissions.effectiveFor(role, user.user_permissions),
      // Filled in by `payloadFor`. Both modules is the same answer the application gave before
      // licensing existed, so a caller that cannot await still behaves as it always did.
      modules: ['crm', 'desk'],
      licence: { crm: true, desk: true, plan: null, status: 'active', expires: null, valid: true },
    };
  }

  /**
   * The payload as the client should see it, with module access resolved.
   *
   * Separate from `buildPayload` because resolving access is two queries and several callers build a
   * payload where awaiting is neither possible nor wanted. Every route that hands a user to the
   * frontend uses this one.
   */
  async payloadFor(user: AuthUserRecord): Promise<AuthPayload> {
    const [modules, licence] = await Promise.all([
      this.moduleAccess.forUser(user.id),
      this.moduleAccess.licence(),
    ]);
    return { ...this.buildPayload(user), modules, licence };
  }

  /**
   * Load a user (with permission overrides and module assignments) by id — used by the auth guard.
   *
   * An inactive account resolves to null, which the guard turns into the same 401 as no session at
   * all. Without this, `login` was the only place status was ever checked: deactivating someone
   * stopped them signing in again but did nothing to the session they already had, so an account
   * closed on Friday kept working until its cookie expired. The rule is spelled exactly as `login`
   * spells it — a null status means active — so the two cannot disagree about who is shut out.
   */
  async loadUser(id: number): Promise<AuthUserRecord | null> {
    const user = await this.prisma.users.findUnique({
      where: { id },
      include: { user_permissions: true, user_modules: true },
    });
    if (!user) return null;
    return (user.status ?? 'Active') === 'Inactive' ? null : user;
  }

  /**
   * Log in by username, falling back to email (usernames may themselves be email-formatted, so both
   * columns are tried) — mirrors AuthController::login. Throws a Laravel-style 422 on failure.
   */
  async login(login: string, password: string): Promise<AuthUserRecord> {
    // Per-account brake, checked BEFORE the password is verified so a locked account costs an
    // attacker nothing to discover and costs us no bcrypt work. This is what makes online guessing
    // futile; the per-IP throttle cannot, because a brokerage office is a single address and the
    // limit that stops an attacker there also stops the eleventh colleague arriving at 9 a.m.
    this.lockout.assertNotLocked(login);

    const user = await this.findAuthenticatable(login, password);
    if (!user) {
      // Counted only for wrong credentials — the actual guessing signal. An inactive account
      // (below) is a correct password against a disabled user and is not an attack.
      this.lockout.recordFailure(login);
      throwValidation({ username: ['The provided credentials are incorrect.'] });
    }
    // A correct password clears the history, so somebody who mistypes twice and then succeeds is
    // never carrying failures into their next sign-in.
    this.lockout.clear(login);
    if ((user.status ?? 'Active') === 'Inactive') {
      throwValidation({ username: ['This account is inactive. Please contact an administrator.'] });
    }
    return user;
  }

  /**
   * Find the account this login string names, and check the password.
   *
   * MATCHING IS CASE-INSENSITIVE, and has to be. `users` carries the functional unique indexes
   * `users_email_lower_key` and `users_username_lower_key`, and the Users service compares both
   * fields case-insensitively — so the application already treats `Priya@brokerage.ca` and
   * `priya@brokerage.ca` as one account and refuses to create the second. Sign-in was still an
   * exact match, which made the two halves disagree in the worst possible place: an address stored
   * with a capital letter could not be typed in lower case, the person got "the provided
   * credentials are incorrect", and because that is the wrong-password path it also counted toward
   * the lockout — so trying again a few times locked them out of their own account.
   *
   * MATCHED WITH `lower(x) = lower($1)`, NOT WITH PRISMA'S `mode: 'insensitive'`. This is a security
   * fix, not a tidy-up. `mode: 'insensitive'` compiles to **ILIKE**, and ILIKE's right-hand side is
   * a PATTERN — so the string typed into the login box was being used as one. `%` and `_` were live
   * wildcards.
   *
   * Demonstrated against real rows before this was changed: signing in as `ZZ%@probe.test` with a
   * matching account's password SUCCEEDED. What that buys an attacker is a password spray that does
   * not need to know who it is aimed at — an administrator hands out a standard temporary password,
   * and `%` or `staff%@brokerage.ca` finds somebody it fits without the attacker knowing a single
   * address. It also quietly breaks the contract every other part of this file assumes: that the
   * account which signs in is the account that was named.
   *
   * Equality has no pattern semantics, so there is nothing to escape and nothing to get wrong.
   *
   * ON THE INDEX, which is the same change. `users_email_lower_key` and `users_username_lower_key`
   * are functional indexes on `lower(...)`; ILIKE could not use either, so every sign-in was a
   * sequential scan. This form matches them exactly.
   */
  private async findAuthenticatable(login: string, password: string): Promise<AuthUserRecord | null> {
    /*
     * Username first, then email, preserving the original precedence — a username may itself be
     * email-formatted, so one string can legitimately name two different rows. `LIMIT 2` because
     * that is the most there can ever be: both columns are uniquely indexed on `lower(...)`.
     *
     * Parameterised by the tagged template, so the value is bound rather than interpolated.
     */
    const matches = await this.prisma.$queryRaw<Array<{ id: number; by_username: boolean }>>`
      SELECT id, lower(username) = lower(${login}) AS by_username
      FROM users
      WHERE lower(username) = lower(${login}) OR lower(email) = lower(${login})
      ORDER BY by_username DESC NULLS LAST, id ASC
      LIMIT 2
    `;

    for (const match of matches) {
      const user = await this.prisma.users.findUnique({
        where: { id: match.id },
        include: { user_permissions: true },
      });
      /*
       * `verifyPassword` answers false for a null or empty hash rather than throwing — a row with no
       * password set is not a fantasy, it is what a half-finished import leaves behind.
       */
      if (user && await this.passwords.verifyPassword(password, user.password)) {
        await this.upgradeHashIfWeak(user, password);
        return user;
      }
    }
    return null;
  }

  /**
   * Re-hash a correct password when it is stored more weakly than we now write.
   *
   * The cost is embedded in the hash, so a sign-in is the one moment we hold both the plaintext and
   * the evidence that it is out of date. Nobody is asked to reset anything and no hash is reversed.
   *
   * BEST EFFORT, DELIBERATELY. The user has already proved who they are; a failed write here must
   * not cost them the sign-in. It is logged and the next sign-in tries again.
   */
  private async upgradeHashIfWeak(user: AuthUserRecord, password: string): Promise<void> {
    if (!this.passwords.needsRehash(user.password)) return;
    const was = this.passwords.costOf(user.password);
    try {
      const upgraded = await this.passwords.hashPassword(password);
      await this.prisma.users.update({
        where: { id: user.id },
        data: { password: upgraded },
      });
      // The in-memory record is handed to the session payload; keep it consistent with the row.
      user.password = upgraded;
      this.log.log(`Upgraded the password hash for user #${user.id} from cost ${was} to ${this.passwords.getConfiguredCost()}.`);
    } catch (err) {
      this.log.warn(`Could not upgrade the password hash for user #${user.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Bootstrap registration — only allowed while there are zero users (creates the first Admin).
   * Mirrors AuthController::register.
   */
  async register(
    name: string,
    email: string,
    password: string,
    passwordConfirmation: string,
  ): Promise<AuthUserRecord> {
    if ((await this.prisma.users.count()) > 0) {
      throw new ForbiddenException({
        message: 'Registration is closed. Ask an administrator to create your account.',
      });
    }

    if (password !== passwordConfirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    this.assertPasswordFits(password);

    // Case-insensitive for the same reason sign-in is: the unique index is on `lower(email)`, so an
    // exact-match pre-check passes and the INSERT then fails with a raw P2002 instead of a 422.
    const existingUser = await this.prisma.users.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existingUser) {
      throwValidation({ email: ['The email has already been taken.'] });
    }

    const now = new Date();
    return this.prisma.users.create({
      data: {
        name: name.trim(),
        email: email.trim(),
        password: await this.passwords.hashPassword(password),
        role: 'admin', // the first user is the administrator
        created_at: now,
        updated_at: now,
      },
      include: { user_permissions: true },
    });
  }

  /** Change the signed-in user's password (current password required). */
  async changePassword(
    user: AuthUserRecord,
    currentPassword: string,
    newPassword: string,
    newPasswordConfirmation: string,
  ): Promise<void> {
    if (!(await this.passwords.verifyPassword(currentPassword, user.password))) {
      throwValidation({ current_password: ['Your current password is incorrect.'] });
    }
    if (newPassword !== newPasswordConfirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    this.assertPasswordFits(newPassword);
    // Refusing a no-op keeps the record honest: "I changed it" should not be able to mean
    // "I retyped the same one", least of all on the screen people use after a suspected leak.
    if (await this.passwords.verifyPassword(newPassword, user.password)) {
      throwValidation({ password: ['The new password must be different from your current one.'] });
    }

    await this.prisma.users.update({
      where: { id: user.id },
      data: { password: await this.passwords.hashPassword(newPassword), updated_at: new Date() },
    });

    /*
     * EVERY SESSION OPENED WITH THE OLD PASSWORD ENDS HERE.
     *
     * An administrator resetting somebody's password through the Users screen already did this.
     * Changing your own did not — so the one action a person takes when they believe their password
     * has leaked left the other party's session working until its cookie expired. Revoking access
     * already obtained with the old password is the entire reason to change it.
     *
     * The caller's own session is stored the same way and ends too; signing back in once is the
     * correct cost of this, and it is what the Users screen has always done to everyone else.
     */
    await this.endSessionsFor(user.id);
  }

  usersExist(): Promise<boolean> {
    return this.prisma.users.count().then((n) => n > 0);
  }

  /** bcrypt truncates past 72 bytes, so a longer password is not the password it appears to be. */
  private assertPasswordFits(password: string): void {
    if (!this.passwords.fits(password)) {
      throwValidation({
        password: [
          `The password must not be longer than ${PasswordHashService.MAX_PASSWORD_BYTES} bytes — `
          + 'anything past that is ignored when it is stored, so it would not really be part of your password.',
        ],
      });
    }
  }

  /**
   * Delete every stored session belonging to one user.
   *
   * `user_sessions` is the express-session store: `sid` is the key and everything else lives in a
   * JSON `sess` column, so there is no `user_id` to filter on and this has to read inside the
   * payload. `sess -> 'userId'` is where AuthGuard looks, so it is what identifies them here.
   *
   * Swallows its own errors on purpose. The password has already been changed and must stay
   * changed; failing the request because the tidy-up failed would tell the caller it did not work
   * and send them back to retry with a password that is no longer current.
   */
  private async endSessionsFor(userId: number): Promise<number> {
    try {
      return await this.prisma.$executeRaw`
        DELETE FROM user_sessions WHERE (sess -> 'userId')::text = ${String(userId)}
      `;
    } catch (e) {
      this.log.warn(`Could not end existing sessions for user #${userId}: ${(e as Error).message}`);
      return 0;
    }
  }
}
