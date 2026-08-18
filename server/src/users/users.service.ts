import { AREAS, type Area } from '../common/domain';
import { ModuleAccessService } from '../core/module-access.service';
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PasswordHashService } from '../auth/password-hash.service';
import { Prisma, type users, type user_permissions, type user_modules } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService, LEVELS, ROLES, SCREENS } from '../auth/permission.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { parseJson, phpJsonNormalize, toDateString } from '../common/serialize';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

import { isSuperAdmin, superAdminRoles } from '../core/authz';
import { OffboardingService } from './offboarding.service';
type UserWithPerms = users & { user_permissions: user_permissions[]; user_modules: user_modules[] };

/** bcrypt ignores everything past 72 bytes, so accepting more would overstate the protection. */
const PASSWORD_MAX_BYTES = 72;
/** Matches the `VarChar(120)` columns `department` and `designation` land in. */
const ORG_FIELD_MAX = 120;
/** `profile` is embedded in the users LIST, so one fat blob degrades the screen for everybody. */
const PROFILE_MAX_CHARS = 64 * 1024;
/** Ceiling on an explicitly requested page, so a large limit cannot undo the point of asking. */
const MAX_USERS_PER_PAGE = 200;

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly audit: AuditService,
    private readonly offboarding: OffboardingService,
    private readonly passwords: PasswordHashService,
  ) {}

  /**
   * All users ordered by name, each with effective permissions + overrides.
   *
   * PAGINATION IS OPTIONAL AND OFF BY DEFAULT, which is a deliberate compromise rather than an
   * oversight. `page`/`limit` used to be accepted and ignored — asking for five users returned every
   * one of them — so a caller could believe it was paging and was not. They are honoured now.
   *
   * The default stays the full list because the response is an ARRAY, and the screen hands a row
   * straight to the editor as the user being edited. Wrapping it in `{ data, meta }` would be the
   * better shape and is a breaking change; a feed that silently changed shape under a client is
   * exactly the failure that blanked the CRM dashboard earlier. So the contract is unchanged and
   * the ceiling is bounded from the other end instead — `PROFILE_MAX_CHARS` stops one account
   * inflating the list for everybody, which was the real amplifier: one 500 kB profile took the
   * list from 4.3 kB to 493 kB.
   */
  async index(q: { page?: unknown; limit?: unknown } = {}): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.users.findMany({ include: { user_permissions: { orderBy: { id: 'asc' } }, user_modules: true } });
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);

    const limit = Number(q.limit);
    if (!Number.isFinite(limit) || limit <= 0) return rows.map((u) => this.payload(u));

    const perPage = Math.min(MAX_USERS_PER_PAGE, Math.floor(limit));
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    return rows.slice((page - 1) * perPage, page * perPage).map((u) => this.payload(u));
  }

  async store(actor: AuthUserRecord | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await this.validate(body, null);
    const now = new Date();
    const user = await this.prisma.users.create({
      data: {
        name: data.name as string,
        username: (data.username ?? null) as string | null,
        email: data.email as string,
        /*
         * Through `PasswordHashService`, at the CONFIGURED cost.
         *
         * This was `bcrypt.hash(password, 10)` — hardcoded, and lower than the 12 that registration
         * and self-service changes used. Because public registration is closed, an administrator
         * creates every account, so this was the cost essentially every password in the system had.
         */
        password: await this.passwords.hashPassword(data.password as string),
        role: data.role as string,
        status: (data.status ?? 'Active') as string,
        department: (data.department ?? null) as string | null,
        designation: (data.designation ?? null) as string | null,
        profile: data.profile !== undefined ? JSON.stringify(data.profile) : null,
        created_at: now,
        updated_at: now,
      },
    }).catch((e) => this.rethrowUniqueViolation(e));
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
    if (data.password) update.password = await this.passwords.hashPassword(data.password as string);
    const passwordChanged = !!data.password;

    /*
     * Only on the transition. Re-saving an already-inactive user is an edit, not a departure, and
     * must not disconnect Meta a second time or sweep leads that have since been reassigned.
     */
    const goingInactive = (existing.status ?? 'Active') === 'Active' && update.status === 'Inactive';

    const user = await this.prisma.users.update({ where: { id }, data: update })
      .catch((e) => this.rethrowUniqueViolation(e));

    /*
     * The consequences of somebody leaving, applied after the status change rather than before it.
     *
     * That order is deliberate: switching off access must not be blocked by a Meta API call or a
     * sweep of the lead table. An agent who leaves badly is exactly when an administrator cannot be
     * made to wait. So the account is off first, and `depart` reports what it managed rather than
     * refusing anything.
     *
     * It disconnects Meta and returns brokerage leads to the brokerage; the agent's own Meta leads
     * stay with them. See `OffboardingService` for why each of those is the right answer.
     */
    const departure = goingInactive ? await this.offboarding.depart(user.id, user.name) : null;

    /*
     * A new password ends every session that account already had open.
     *
     * Without this, resetting a compromised account's password changed only what a NEW sign-in
     * needs — whoever was already inside stayed inside until their cookie expired. That is the one
     * moment the reset exists for, so it has to be the one moment it works.
     *
     * Sessions live in `user_sessions` as JSON keyed by `sid`, so they are matched on the user id
     * inside the payload rather than by a column. Best-effort: a failure here must not undo a
     * password change that has already been written, so it is logged rather than thrown — the new
     * password is still in force for anything that signs in from now on.
     */
    if (passwordChanged) await this.endSessionsFor(user.id);

    await this.syncPermissions(user.id, user.role, (data.permissions ?? {}) as Record<string, unknown>);
    // Only when the caller said something about modules. An absent key means "leave it alone" here,
    // unlike on create — a PATCH-shaped save from a screen that does not edit modules must not wipe
    // the assignment.
    if (Array.isArray(body.modules)) await this.moduleAccess.setAssigned(user.id, this.wantedModules(body));
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management',
      field: user.name,
      action: goingInactive ? 'User deactivated' : 'User updated',
      details: `${user.email} · ${this.permissions.label(user.role)} · ${user.status}`
        + (departure ? ` · ${departure}` : ''),
    });
    return this.payload(await this.load(id));
  }

  async destroy(actor: AuthUserRecord | null, id: number): Promise<{ message: string }> {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    if (actor && user.id === actor.id) throw new UnprocessableEntityException({ message: 'You cannot delete your own account.' });
    /*
     * "The last administrator" means the last of the top tier, whatever that tier is called — and
     * this now asks the authorization engine instead of counting `role: 'admin'` itself.
     *
     * The literal count was the mistake `core/authz.ts` opens by warning against: the day a second
     * top-tier role exists, it under-counts, and the guard lets somebody delete the last account
     * that can administer the brokerage. Only Active accounts count, because an inactive one cannot
     * sign in to administer anything — deleting the last *usable* administrator is the same lockout
     * whether or not a disabled row survives it.
     */
    if (isSuperAdmin(user)) {
      const admins = await this.prisma.users.count({
        where: { role: { in: superAdminRoles() }, status: 'Active' },
      });
      if (admins <= 1) {
        throw new UnprocessableEntityException({
          message: 'Cannot delete the last administrator — there would be nobody left who can manage users.',
        });
      }
    }

    /*
     * DELETING SOMEBODY IS NOT THE SAME AS DEACTIVATING THEM, and it is the more dangerous of the
     * two here. Nothing in this schema points at `users` with a foreign key — verified — so the
     * row simply disappears and everything keyed on their id is left behind:
     *
     *   - leads still carry `owner_user_id` for a person who no longer exists. Nobody can open
     *     them, and they cannot be recovered through `transfer-ownership` either, because that
     *     refuses with "that person no longer exists" when the source is gone. They are lost.
     *   - their Meta lead forms still hold `is_active` claims, so a successor connecting the same
     *     form is refused on behalf of a colleague who is no longer in the system, and the message
     *     cannot even name them.
     *
     * So the departure rules run here too, and the one case they cannot answer is refused rather
     * than guessed. A departing agent's Meta leads are personal: deactivating leaves them with
     * that agent, which is the point. There is no such thing as leaving them with somebody who has
     * been deleted, and quietly handing personal leads to the brokerage is not a decision this
     * function should be making on an administrator's behalf.
     */
    /*
     * Anything that would be left pointing at an id that no longer resolves stops the delete.
     *
     * Forty-two of the forty-seven columns holding a user id have no foreign key, so nothing else
     * would object — the row would simply vanish and their calendar, leads, mailbox and campaigns
     * would reference a person who does not exist. Their calendar in particular becomes reachable
     * by nobody at all, because a calendar is private to its owner.
     *
     * Deactivation is the operation that handles a departure properly, so that is what this points
     * at. Deleting stays possible for an account that never did anything — a mistyped invitation,
     * a duplicate created and abandoned — which is the case it is actually useful for.
     */
    const stranded = await this.offboarding.orphanRisk(id);
    if (stranded.length) {
      const summary = stranded.map((s) => `${s.count} ${s.label}${s.count === 1 ? '' : 's'}`).join(', ');
      throw new UnprocessableEntityException({
        message: `${user.name} still has ${summary}. Deleting the account would leave those records pointing at `
          + 'somebody who no longer exists — their calendar in particular would be reachable by nobody. '
          + 'Deactivate the account instead: that ends their access immediately, releases the brokerage '
          + 'leads they were working back to the pool, and leaves their own leads private with them.',
      });
    }

    /*
     * A REAL DATABASE DEPENDENCY, NAMED RATHER THAN WORKED AROUND.
     *
     * `leads.owner_user_id` is a bare integer with no foreign key and `users` has no soft delete, so
     * removing the row would leave these leads owned by an id that resolves to nobody: invisible on
     * every screen, outside every scope, and unrecoverable.
     *
     * THE OBVIOUS WORKAROUND IS FORBIDDEN. Nulling the owner would make the delete succeed and would
     * hand the departing agent's private clients to the brokerage — the exact conversion this work
     * removed. Deletion is refused instead, and the remedy is stated: the agent exports or clears
     * their own leads, or the account is deactivated, which never needed the leads dealt with first.
     *
     * The message says what it is holding, without naming a single client.
     */
    const { personal } = await this.offboarding.leadCounts(id);
    if (personal > 0) {
      throw new UnprocessableEntityException({
        message: `${user.name} still owns ${personal} lead${personal === 1 ? '' : 's'} of their own. Deleting the `
          + 'account would leave those leads owned by nobody and unrecoverable, and they will not be handed '
          + 'to the brokerage — an agent\'s own leads stay private. Ask them to export or remove their leads '
          + 'first, or deactivate the account instead, which ends their access immediately and does not '
          + 'require the leads to be dealt with at all.',
      });
    }

    // Safe to remove now: disconnect Meta and hand the brokerage its leads back first, so nothing
    // is orphaned by the delete itself.
    const departure = await this.offboarding.depart(id, user.name);

    const name = user.name, email = user.email;
    await this.prisma.users.delete({ where: { id } });
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management', field: name, action: 'User deleted',
      details: email + (departure ? ` · ${departure}` : ''),
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

    /*
     * Trim the identifying fields IN PLACE, before anything reads them.
     *
     * Without this, `" David Chen "` and `"David Chen"` are different strings, so the uniqueness
     * check above passes and two rows end up sharing a name for every practical purpose — which is
     * exactly the ambiguity that rule exists to prevent, reached by adding a space. The same applies
     * to email and username, where a trailing space also makes a login fail for reasons nobody can
     * see on screen.
     *
     * Mutating `body` rather than only the validated copy is deliberate: `store` and `update` read
     * from the validated subset, but the uniqueness lookups below read the raw value, and the two
     * must agree about what is being saved.
     */
    for (const k of ['name', 'username', 'email', 'department', 'designation']) {
      if (typeof body[k] === 'string') body[k] = (body[k] as string).trim();
    }

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
      /*
       * A CEILING, because bcrypt silently ignores everything past 72 bytes.
       *
       * A 10,000-character passphrase was accepted and stored, and only its first 72 bytes had any
       * effect — so somebody choosing a deliberately long password got far less than they believed,
       * with nothing saying so. Refusing above the limit is honest; silently truncating is not.
       * It also stops a very large string being fed to a deliberately slow hash.
       */
      else if (Buffer.byteLength(String(val('password')), 'utf8') > PASSWORD_MAX_BYTES) {
        push('password', `The password field must not be longer than ${PASSWORD_MAX_BYTES} bytes — `
          + 'anything beyond that is ignored by the password hash, so it would not protect the account.');
      }
    }

    // role: required|in:ROLES
    if (empty(val('role'))) push('role', 'The role field is required.');
    else if (!(ROLES as readonly string[]).includes(String(val('role')))) push('role', 'The selected role is invalid.');

    // status: nullable|in:Active,Inactive
    if (!empty(val('status')) && !['Active', 'Inactive'].includes(String(val('status')))) push('status', 'The selected status is invalid.');

    // department / designation: nullable|string|max:120 — matching the columns.
    //
    // These had NO rules and, worse, were not in the validated subset below, so the form collected
    // them, the API answered 201, and nothing was stored. Adding them to the subset without a length
    // rule would have turned that silent loss into a 500 at 121 characters.
    for (const field of ['department', 'designation'] as const) {
      const v = val(field);
      if (empty(v)) continue;
      if (typeof v !== 'string') push(field, `The ${field} field must be a string.`);
      else if ([...v].length > ORG_FIELD_MAX) push(field, `The ${field} field must not be greater than ${ORG_FIELD_MAX} characters.`);
    }

    /*
     * Mobile and gender live inside `profile`, and were required by the FORM ONLY.
     *
     * So anything not going through that form — an API client, an import, a script — created a
     * person with neither, and the screen then showed a record it would refuse to let you save.
     * Enforced here on create only: an existing account predating the rule must stay editable
     * without someone having to invent a mobile number for a colleague who left.
     */
    if (uReq && this.isAssocOrArray(val('profile'))) {
      const p = val('profile') as Record<string, unknown>;
      if (empty(p.mobile)) push('profile.mobile', 'The mobile number field is required.');
      if (empty(p.gender)) push('profile.gender', 'The gender field is required.');
    } else if (uReq && empty(val('profile'))) {
      push('profile.mobile', 'The mobile number field is required.');
      push('profile.gender', 'The gender field is required.');
    }

    // profile: nullable|array
    if (!empty(val('profile')) && !this.isAssocOrArray(val('profile'))) push('profile', 'The profile field must be an array.');
    /*
     * And bounded. `profile` is a TEXT column with no limit, and it is embedded in the users LIST
     * endpoint — so one account carrying a 500 kB blob inflated that list from 4.3 kB to 493 kB for
     * every administrator who opened the screen. Measured.
     */
    else if (!empty(val('profile'))) {
      const size = JSON.stringify(val('profile')).length;
      if (size > PROFILE_MAX_CHARS) {
        push('profile', `The profile data is ${(size / 1024).toFixed(0)} kB — the limit is ${PROFILE_MAX_CHARS / 1024} kB.`);
      }
    }

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
    /*
     * The validated subset — and `department` / `designation` were missing from it.
     *
     * `store` and `update` read those two from here, so their absence meant create always wrote
     * null and update always kept the old value: the form asked for them, the API answered 201, and
     * nothing was saved. They are validated above and carried through now.
     */
    const out: Record<string, unknown> = {};
    for (const k of ['name', 'username', 'email', 'password', 'role', 'status', 'department', 'designation', 'profile', 'permissions']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    }
    return out;
  }

  /**
   * Laravel's default `email` rule is RFCValidation (filter_var-like). This approximates it.
   *
   * DELIBERATELY NOT A FULL RFC 5322 PARSER. That grammar admits quoted local parts, comments and
   * bracketed IP domains, and every attempt to express it as one regular expression is either
   * wrong or unreadable. The useful job here is to catch what a person actually mistypes while
   * never refusing an address that would deliver.
   *
   * What the previous pattern — `[^\s@]+@[^\s@]+\.[^\s@]+` — let through, all of which are
   * undeliverable and were accepted: a local part starting or ending with a dot, doubled dots
   * anywhere, a domain label starting or ending with a hyphen, and a one-character or numeric
   * top-level domain. Each is now refused.
   *
   * What is still accepted, on purpose: plus-addressing, dotted local parts, subdomains, long TLDs
   * and internationalised domains in their punycode form — the shapes real brokerage addresses take.
   */
  private isEmail(s: string): boolean {
    if (s.length > 254) return false;                       // RFC 5321 line limit
    const at = s.lastIndexOf('@');
    if (at < 1 || at === s.length - 1) return false;

    const local = s.slice(0, at);
    const domain = s.slice(at + 1);

    if (local.length > 64) return false;
    if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

    if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.includes('..')) return false;
    const labels = domain.split('.');
    // A domain needs at least one dot, and every label must be a label: no empty, no leading or
    // trailing hyphen.
    if (labels.length < 2) return false;
    if (labels.some((l) => l.length === 0 || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
    // The top-level domain is letters only, at least two of them — this is what rejects "a@b.c"
    // and "user@host.1" while leaving every real TLD alone.
    return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
  }

  private isAssocOrArray(v: unknown): boolean {
    return typeof v === 'object' && v !== null;
  }

  /**
   * EVERY user collides, active or not — and the previous rule, which ignored deactivated accounts,
   * was wrong in a way that cost money.
   *
   * It was justified like this: "a deactivated account keeps its name in the record… nothing
   * resolves splits or routes mail to an inactive account." The second half is not true of this
   * codebase. `dashboard.service.ts` resolves a commission profile with
   * `users.findFirst({ where: { name } })` and no status filter at all, so two rows sharing a name
   * are ambiguous whatever their status.
   *
   * Measured, with a deactivated namesake on a 10% split and the active new hire on 90%: the lookup
   * returned the INACTIVE row, three times out of three. Every deal that agent closed would have
   * paid the departed colleague's percentage, silently, with both records looking correct in
   * isolation.
   *
   * A name is a join key for as long as any historical record uses it, so it stays reserved for as
   * long as the row exists. The cost is that a genuine second "David Chen" must be distinguished —
   * a middle initial — which is a visible, one-off inconvenience rather than an invisible,
   * recurring payroll error.
   */
  private async nameTaken(name: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({
      where: { name, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Case-insensitively, like the address itself.
   *
   * These compared exactly, so `priya@brokerage.ca` and `PRIYA@BROKERAGE.CA` were two accounts —
   * confirmed at runtime, the uppercase duplicate was accepted with a 201. Mail systems treat them
   * as one person, so a password reset or a notification could reach either, and the sign-in form
   * authenticates whichever row matches the typed case. The same applies to a username somebody
   * types with a capital.
   */
  private async usernameTaken(username: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  private async emailTaken(email: string, ignoreId: number | null): Promise<boolean> {
    const row = await this.prisma.users.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Delete every stored session belonging to one user.
   *
   * `user_sessions` is the express-session store: `sid` is the key and everything else lives in a
   * JSON `sess` column, so there is no `user_id` to filter on and this has to read inside the
   * payload. `sess -> 'userId'` is where AuthGuard looks, so it is what identifies them here.
   *
   * Swallows its own errors on purpose — see the caller. A password that has been changed must stay
   * changed even if the tidy-up fails.
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

  /**
   * Turn a database unique violation into the validation error the pre-check would have produced.
   *
   * THE PRE-CHECK CANNOT BE ENOUGH on its own: it is a SELECT followed by an INSERT, and two
   * requests can both pass the SELECT. Observed with three simultaneous creates on one email — one
   * succeeded and **two returned HTTP 500**, because nothing caught the index violation. The data
   * stayed correct; the caller got an unhandled server error instead of "The email has already been
   * taken", which is what two administrators onboarding the same starter, or one double-clicked
   * Save, would see.
   *
   * The index is the real guarantee, so this reports what it decided rather than pretending the
   * race cannot happen.
   */
  private rethrowUniqueViolation(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = err.meta?.target;
      const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
      const field = ['email', 'username', 'name'].find((f) => fields.some((t) => t.includes(f))) ?? 'email';
      const label = field === 'name' ? 'name' : field === 'username' ? 'username' : 'email';
      throwValidation({
        [field]: [`The ${label} has already been taken — somebody else saved that value a moment ago.`],
      });
    }
    throw err;
  }
}
