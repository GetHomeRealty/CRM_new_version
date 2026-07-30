import { ModuleAccessService } from '../core/module-access.service';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { throwValidation } from '../common/laravel-exceptions';
import { PermissionService } from './permission.service';
import type { AuthPayload, AuthUserRecord } from './auth.types';

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
      is_admin: user.role === 'admin',
      is_super_admin: user.role === 'admin',
      is_admin_or_above: user.role === 'admin' || user.role === 'manager',
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

  /** Load a user (with permission overrides) by id — used by the auth guard. */
  loadUser(id: number): Promise<AuthUserRecord | null> {
    return this.prisma.users.findUnique({
      where: { id },
      include: { user_permissions: true },
    });
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
      const user = await this.prisma.users.findFirst({
        where,
        include: { user_permissions: true },
      });
      if (user && bcrypt.compareSync(password, user.password)) return user;
    }
    return null;
  }

  /**
   * Bootstrap registration — only allowed while there are zero users (creates the
   * first Admin). Mirrors AuthController::register.
   */
  async register(name: string, email: string, password: string, passwordConfirmation: string): Promise<AuthUserRecord> {
    if ((await this.prisma.users.count()) > 0) {
      throw new ForbiddenException({
        message: 'Registration is closed. Ask an administrator to create your account.',
      });
    }
    if (password !== passwordConfirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    if (await this.prisma.users.findUnique({ where: { email } })) {
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
    return this.prisma.users.count().then((n) => n > 0);
  }
}
