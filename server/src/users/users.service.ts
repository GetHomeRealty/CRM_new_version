import { AREAS, type Area } from '../common/domain';
import { ModuleAccessService } from '../core/module-access.service';
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma, type users, type user_permissions, type user_modules } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService, LEVELS, ROLES, SCREENS } from '../auth/permission.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { parseJson, phpJsonNormalize, toDateString } from '../common/serialize';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

import { isSuperAdmin } from '../core/authz';
type UserWithPerms = users & { user_permissions: user_permissions[]; user_modules: user_modules[] };

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly audit: AuditService,
  ) {}

  /** All users ordered by name, each with effective permissions + overrides. */
  async index(): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.users.findMany({ include: { user_permissions: { orderBy: { id: 'asc' } }, user_modules: true } });
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
    return rows.map((u) => this.payload(u));
  }

  async store(actor: AuthUserRecord | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await this.validate(body, null);
    const now = new Date();
    const user = await this.prisma.users.create({
      data: {
        name: data.name as string,
        username: (data.username ?? null) as string | null,
        email: data.email as string,
        password: await bcrypt.hash(data.password as string, 10),
        role: data.role as string,
        status: (data.status ?? 'Active') as string,
        department: (data.department ?? null) as string | null,
        designation: (data.designation ?? null) as string | null,
        profile: data.profile !== undefined ? JSON.stringify(data.profile) : null,
        created_at: now,
        updated_at: now,
      },
    });
    await this.syncPermissions(user.id, user.role, (data.permissions ?? {}) as Record<string, unknown>);
    // Which modules this person may open. Omitted means both — the same access a user created before
    // module assignment existed would have had, so an older client or an API caller that does not
    // know about modules cannot accidentally create someone who can open nothing.
    await this.moduleAccess.setAssigned(user.id, this.wantedModules(body));
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management', field: user.name, action: 'User created',
      details: `${user.email} · ${this.permissions.label(user.role)}`,
    });
    return this.payload(await this.load(user.id));
  }

  async update(actor: AuthUserRecord | null, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.prisma.users.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    const data = await this.validate(body, existing);

    const update: Prisma.usersUpdateInput = {
      department: (data.department ?? existing.department) as string | null,
      designation: (data.designation ?? existing.designation) as string | null,
      name: data.name as string,
      username: (data.username ?? existing.username) as string | null,
      email: data.email as string,
      role: data.role as string,
      status: (data.status ?? existing.status ?? 'Active') as string,
      profile: Object.prototype.hasOwnProperty.call(data, 'profile')
        ? (data.profile !== undefined ? JSON.stringify(data.profile) : null)
        : existing.profile,
      updated_at: new Date(),
    };
    if (data.password) update.password = await bcrypt.hash(data.password as string, 10);
    const user = await this.prisma.users.update({ where: { id }, data: update });

    await this.syncPermissions(user.id, user.role, (data.permissions ?? {}) as Record<string, unknown>);
    // Only when the caller said something about modules. An absent key means "leave it alone" here,
    // unlike on create — a PATCH-shaped save from a screen that does not edit modules must not wipe
    // the assignment.
    if (Array.isArray(body.modules)) await this.moduleAccess.setAssigned(user.id, this.wantedModules(body));
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management', field: user.name, action: 'User updated',
      details: `${user.email} · ${this.permissions.label(user.role)} · ${user.status}`,
    });
    return this.payload(await this.load(id));
  }

  async destroy(actor: AuthUserRecord | null, id: number): Promise<{ message: string }> {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    if (actor && user.id === actor.id) throw new UnprocessableEntityException({ message: 'You cannot delete your own account.' });
    // "The last administrator" means the last of the top tier, whatever that tier is called.
    if (isSuperAdmin(user)) {
      const admins = await this.prisma.users.count({ where: { role: 'admin' } });
      if (admins <= 1) throw new UnprocessableEntityException({ message: 'Cannot delete the last administrator.' });
    }

    const name = user.name, email = user.email;
    await this.prisma.users.delete({ where: { id } });
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management', field: name, action: 'User deleted', details: email,
    });
    return { message: 'User deleted' };
  }

  /** Screens / roles / levels / role-defaults for the permission editor. */
  catalog(): ReturnType<PermissionService['catalog']> {
    return this.permissions.catalog();
  }

  /**
   * The agent's paid (Closed) deals as PRIMARY agent, oldest first, limited to the
   * "Existing Split Deals Count" — the deals done under the previous split. Each row
   * carries the split that was used on that deal.
   */
  async dealHistory(id: number): Promise<Record<string, unknown>[]> {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    const name = user.name;
    const profile = (parseJson<Record<string, unknown>>(user.profile) ?? {}) as Record<string, unknown>;
    const threshold = Math.trunc(Number(profile.completed_deals ?? 0)) || 0;

    const deals = await this.prisma.transactions.findMany({
      where: { deleted_at: null, agent: name, transaction_statuses: { some: { status: 'Closed' } } },
      include: { team_members: { where: { name }, orderBy: { id: 'asc' } } },
      orderBy: [{ closing_date: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      ...(threshold > 0 ? { take: threshold } : {}),
    });

    return deals.map((t) => {
      const m = t.team_members[0] ?? null;
      const agentPct = m ? Number(m.agent_pct) : (profile.agent_comm_pct ?? null);
      const brokPct = m ? Number(m.brok_pct) : (profile.brok_comm_pct ?? null);
      return {
        brokerage: 'Get Home Realty',
        property: t.property,
        trade_no: t.trade_no,
        agent_pct: agentPct !== null && agentPct !== undefined ? Number(agentPct) : null,
        brok_pct: brokPct !== null && brokPct !== undefined ? Number(brokPct) : null,
        closing_date: toDateString(t.closing_date),
      };
    });
  }

  private async load(id: number): Promise<UserWithPerms> {
    return (await this.prisma.users.findUnique({ where: { id }, include: { user_permissions: { orderBy: { id: 'asc' } }, user_modules: true } })) as UserWithPerms;
  }

  /** Persist only the overrides that differ from the role default. */
  private async syncPermissions(userId: number, role: string, map: Record<string, unknown>): Promise<void> {
    const defaults = this.permissions.roleDefaults(role);
    await this.prisma.user_permissions.deleteMany({ where: { user_id: userId } });
    const now = new Date();
    for (const [screen, level] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(SCREENS, screen)) continue;
      if (!(LEVELS as readonly string[]).includes(level as string)) continue;
      if ((defaults[screen] ?? 'none') !== level) {
        await this.prisma.user_permissions.create({ data: { user_id: userId, screen, level: level as string, created_at: now, updated_at: now } });
      }
    }
  }

  /**
   * The modules a save is asking for.
   *
   * An absent `modules` key means "unchanged" on update and "both" on create — a caller that does not
   * know about module assignment must not silently strip it. An explicitly empty list is honoured:
   * that is someone deliberately saying this person opens nothing.
   */
  private wantedModules(body: Record<string, unknown>): Area[] {
    const raw = body.modules;
    if (!Array.isArray(raw)) return [...AREAS];
    return AREAS.filter((a) => raw.includes(a));
  }

  private payload(u: UserWithPerms): Record<string, unknown> {
    const overrides = u.user_permissions;
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      role: u.role,
      status: u.status ?? 'Active',
      department: u.department,
      designation: u.designation,
      // Assigned modules, not effective ones: this screen edits the assignment, and showing it
      // filtered by the licence would make an unlicensed module look un-assigned and lose the setting
      // the moment someone saved.
      modules: u.user_modules.filter((m) => m.status === 'active').map((m) => m.module_name),
      profile: phpJsonNormalize(parseJson(u.profile) ?? []),
      is_admin: isSuperAdmin(u),
      permissions: this.permissions.effectiveFor(u.role, overrides.map((p) => ({ screen: p.screen, level: p.level }))),
      overrides: overrides.length ? Object.fromEntries(overrides.map((p) => [p.screen, p.level])) : [],
    };
  }

  // ---- validation (faithful port of UserController::rules) ----

  private async validate(body: Record<string, unknown>, existing: users | null): Promise<Record<string, unknown>> {
    const errors: FieldErrors = {};
    const val = (k: string): unknown => body[k];
    const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };

    // name: required|string|max:255
    if (empty(val('name'))) push('name', 'The name field is required.');
    else {
      if (typeof val('name') !== 'string') push('name', 'The name field must be a string.');
      else if ([...(val('name') as string)].length > 255) push('name', 'The name field must not be greater than 255 characters.');
    }

    // username: (required on create / nullable on update)|string|max:255|unique
    const uReq = existing === null;
    if (empty(val('username'))) { if (uReq) push('username', 'The username field is required.'); }
    else {
      if (typeof val('username') !== 'string') push('username', 'The username field must be a string.');
      else if ([...(val('username') as string)].length > 255) push('username', 'The username field must not be greater than 255 characters.');
    }

    // email: required|email|max:255|unique
    if (empty(val('email'))) push('email', 'The email field is required.');
    else {
      if (!this.isEmail(String(val('email')))) push('email', 'The email field must be a valid email address.');
      else if ([...String(val('email'))].length > 255) push('email', 'The email field must not be greater than 255 characters.');
    }

    // password: (required on create / nullable on update)|confirmed|min:8
    if (empty(val('password'))) { if (uReq) push('password', 'The password field is required.'); }
    else {
      if (body.password_confirmation !== val('password')) push('password', 'The password field confirmation does not match.');
      if ([...String(val('password'))].length < 8) push('password', 'The password field must be at least 8 characters.');
    }

    // role: required|in:ROLES
    if (empty(val('role'))) push('role', 'The role field is required.');
    else if (!(ROLES as readonly string[]).includes(String(val('role')))) push('role', 'The selected role is invalid.');

    // status: nullable|in:Active,Inactive
    if (!empty(val('status')) && !['Active', 'Inactive'].includes(String(val('status')))) push('status', 'The selected status is invalid.');

    // profile: nullable|array
    if (!empty(val('profile')) && !this.isAssocOrArray(val('profile'))) push('profile', 'The profile field must be an array.');

    // permissions: nullable|array ; permissions.*: in:LEVELS
    if (!empty(val('permissions'))) {
      if (!this.isAssocOrArray(val('permissions'))) push('permissions', 'The permissions field must be an array.');
      else for (const [k, v] of Object.entries(val('permissions') as Record<string, unknown>)) {
        if (!(LEVELS as readonly string[]).includes(String(v))) push(`permissions.${k}`, `The selected permissions.${k} is invalid.`);
      }
    }

    // Uniqueness (DB) — only when the field passed its format rules (Rule::unique ignore self).
    //
    // NAME IS UNIQUE HERE BECAUSE IT IS A JOIN KEY, not for tidiness. Transactions record their
    // agent as a NAME, team members are stored by NAME, and the application resolves people from
    // those strings all over: commission splits (`users.findFirst({ where: { name } })`), agent
    // loan positions, the email routing for documents, notices of sale and quick sends, and the
    // dashboard/notification scoping that decides which deals an agent may see.
    //
    // Two active accounts sharing a name therefore does not degrade gracefully — it silently
    // resolves to ONE OF THEM, chosen by the query planner. That has been observed in this
    // database: two users called "Akhil" with commission percentages of 0 and 90, where which one
    // a deal paid depended on the plan and could change after a VACUUM or a restore with no code
    // change at all. Agent loan positions overwrite each other last-wins, and name-scoped
    // visibility matches both people's deals.
    if (errors.name === undefined && !empty(val('name')) && (await this.nameTaken(String(val('name')), existing?.id ?? null))) {
      push('name', 'Another active user already has this name. Names identify agents on transactions, so they must be distinct.');
    }
    if (errors.username === undefined && !empty(val('username')) && (await this.usernameTaken(String(val('username')), existing?.id ?? null))) {
      push('username', 'The username has already been taken.');
    }
    if (errors.email === undefined && !empty(val('email')) && (await this.emailTaken(String(val('email')), existing?.id ?? null))) {
      push('email', 'The email has already been taken.');
    }

    if (Object.keys(errors).length) throwValidation(errors);

    // Return the validated() subset: only the keys the rules cover (Laravel validated()).
    const out: Record<string, unknown> = {};
    for (const k of ['name', 'username', 'email', 'password', 'role', 'status', 'profile', 'permissions']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    }
    return out;
  }

  private isEmail(s: string): boolean {
    // Laravel's default 'email' rule = RFCValidation (filter_var-like). Approximate with a
    // standard pattern; the SPA-facing failure text is what must match, not exotic edge cases.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  private isAssocOrArray(v: unknown): boolean {
    return typeof v === 'object' && v !== null;
  }

  /**
   * Only ACTIVE users collide. A deactivated account keeps its name in the record — every closed
   * deal it appears on still reads correctly — and blocking a new hire from using a departed
   * colleague's name would be an odd rule with no safety value, because nothing resolves splits or
   * routes mail to an inactive account.
   */
  private async nameTaken(name: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({
      where: { name, status: 'Active', ...(ignoreId ? { id: { not: ignoreId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  private async usernameTaken(username: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({ where: { username, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });
    return row !== null;
  }

  private async emailTaken(email: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({ where: { email, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });
    return row !== null;
  }
}
