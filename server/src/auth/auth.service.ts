import { ModuleAccessService } from '../core/module-access.service';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { throwValidation } from '../common/laravel-exceptions';
import { PermissionService } from './permission.service';
import type { AuthPayload, AuthUserRecord } from './auth.types';
import { runAsSystem } from '../core/tenant-context';

import { isAdminOrAbove, isSuperAdmin } from '../core/authz';
@Injectable()
export class AuthService {
  private readonly rounds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly moduleAccess: ModuleAccessService,
    config: ConfigService,
  ) {
    this.rounds = config.get<number>('bcryptRounds') ?? 12;
  }

  /**
   * Shape the public user payload — a copy of AuthController::payload().
   *
   * `modules` and `licence` are added asynchronously by `payloadWithModules`; this synchronous form is
   * kept because several callers build a payload where awaiting is not possible, and they are not
   * asking about module access.
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
    // System, and it has to be. This runs on every request BEFORE anything knows which brokerage
    // the caller belongs to — resolving the session's user is how the tenant is discovered in the
    // first place. Scoping it would make authentication depend on its own result.
    const user = await runAsSystem(() => this.prisma.users.findUnique({
      where: { id },
      include: { user_permissions: true, user_modules: true },
    }));
    if (!user) return null;
    return (user.status ?? 'Active') === 'Inactive' ? null : user;
  }

  /**
   * Log in by username, falling back to email (usernames may themselves be
   * email-formatted, so both columns are tried) — mirrors AuthController::login.
   * Throws a Laravel-style 422 on failure.
   */
  async login(login: string, password: string): Promise<AuthUserRecord> {
    const user = await this.findAuthenticatable(login, password);
    if (!user) {
      throwValidation({ username: ['The provided credentials are incorrect.'] });
    }
    if ((user.status ?? 'Active') === 'Inactive') {
      throwValidation({ username: ['This account is inactive. Please contact an administrator.'] });
    }
    return user;
  }

  private async findAuthenticatable(login: string, password: string): Promise<AuthUserRecord | null> {
    for (const where of [{ username: login }, { email: login }]) {
      // Signing in is the moment the tenant becomes knowable; it cannot already be known here.
      const user = await runAsSystem(() => this.prisma.users.findFirst({
        where,
        include: { user_permissions: true },
      }));
      if (user && bcrypt.compareSync(password, user.password)) return user;
    }
    return null;
  }

  /**
   * Bootstrap registration — only allowed while there are zero users (creates the
   * first Admin). Mirrors AuthController::register.
   */
  async register(name: string, email: string, password: string, passwordConfirmation: string): Promise<AuthUserRecord> {
    if ((await runAsSystem(() => this.prisma.users.count())) > 0) {
      throw new ForbiddenException({
        message: 'Registration is closed. Ask an administrator to create your account.',
      });
    }
    if (password !== passwordConfirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    if (await runAsSystem(() => this.prisma.users.findUnique({ where: { email } }))) {
      throwValidation({ email: ['The email has already been taken.'] });
    }

    return this.prisma.users.create({
      data: {
        name,
        email,
        password: bcrypt.hashSync(password, this.rounds),
        role: 'admin', // first user is the administrator
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
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      throwValidation({ current_password: ['Your current password is incorrect.'] });
    }
    if (newPassword !== newPasswordConfirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    await this.prisma.users.update({
      where: { id: user.id },
      data: { password: bcrypt.hashSync(newPassword, this.rounds) },
    });
  }

  usersExist(): Promise<boolean> {
    return runAsSystem(() => this.prisma.users.count()).then((n) => n > 0);
  }
}
