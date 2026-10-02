import { AREAS, type Area } from '../common/domain';
import { ModuleAccessService } from '../core/module-access.service';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PasswordHashService } from '../auth/password-hash.service';
import { passwordPolicyProblem } from '../auth/password-policy';
import { Prisma, type users, type user_permissions, type user_modules } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionService, LEVELS, ROLES, SCREENS } from '../auth/permission.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { parseJson, phpJsonNormalize, toDateString } from '../common/serialize';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

import { isSuperAdmin, superAdminRoles } from '../core/authz';
import { OffboardingService } from './offboarding.service';
import { UserRenameService } from './user-rename.service';
import { TEAM_LEAD_EDITABLE_FIELDS, TEAM_LEAD_PROFILE_KEYS, teamLeadIdOf } from './team-lead';
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
    // @Inject names the provider outright: a `| null` type is emitted as Object, which Nest cannot
    // resolve - that is what kept crm-api from starting on 2026-09-16. The default keeps hand-built specs working.
    @Inject(UserRenameService) private readonly rename: UserRenameService | null = null,
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
  async index(q: { page?: unknown; limit?: unknown } = {}, actor: AuthUserRecord | null = null): Promise<Record<string, unknown>[]> {
    // A Team Lead's Users screen is their own team and nobody else.
    const lead = this.teamLeadScope(actor);
    const rows = await this.prisma.users.findMany({
      ...(lead !== null ? { where: this.ownAgentsWhere(lead) } : {}),
      include: { user_permissions: { orderBy: { id: 'asc' } }, user_modules: true },
    });
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);
    const asPayload = (u: UserWithPerms) => this.payload(u, lead !== null);

    const limit = Number(q.limit);
    if (!Number.isFinite(limit) || limit <= 0) return rows.map(asPayload);

    const perPage = Math.min(MAX_USERS_PER_PAGE, Math.floor(limit));
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    return rows.slice((page - 1) * perPage, page * perPage).map(asPayload);
  }

  /**
   * A-1 - ONE USER, BY ID.
   *
   * There was no way to fetch a single user: PUT, PATCH and DELETE all took `users/:user`, and GET
   * did not exist, so /api/users/2903 answered 404 even for a Super Admin. The only way to render
   * one person was to load the entire table and find them in it - the amplifier behind P-2 - and any
   * integration written to the obvious REST shape broke on the first call.
   *
   * The SAME payload the list emits per row, deliberately: a second shape for the same record is how
   * two screens come to disagree about one person.
   */
  async show(id: number, actor: AuthUserRecord | null = null): Promise<Record<string, unknown>> {
    const lead = this.teamLeadScope(actor);
    const u = await this.prisma.users.findUnique({
      where: { id },
      include: { user_permissions: { orderBy: { id: 'asc' } }, user_modules: true },
    });
    // Another team's Agent answers exactly like a user who does not exist.
    if (!u || (lead !== null && !this.isOwnAgent(u, lead))) throw new NotFoundException({ message: 'User not found.' });
    return this.payload(u, lead !== null);
  }

  async store(actor: AuthUserRecord | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const lead = this.teamLeadScope(actor);
    // A Team Lead creates Agents for their own team, and nothing else: whatever role, permissions,
    // modules or reporting line the request carried is replaced, not merely hidden by the screen.
    if (lead !== null) body = this.teamLeadBody(body, null);
    const data = await this.validate(body, null);
    const hierarchy = lead !== null
      ? { is_team_lead: false, team_lead_id: lead }
      : await this.validateHierarchy(body, null, data.role as string);
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
        is_team_lead: hierarchy.is_team_lead ?? false,
        team_lead_id: hierarchy.team_lead_id ?? null,
        created_by_id: actor?.id ?? null,
        created_at: now,
        updated_at: now,
      },
    }).catch((e) => this.rethrowUniqueViolation(e));
    await this.syncPermissions(user.id, user.role, (data.permissions ?? {}) as Record<string, unknown>);
    // Which modules this person may open. Omitted means both — the same access a user created before
    // module assignment existed would have had, so an older client or an API caller that does not
    // know about modules cannot accidentally create someone who can open nothing.
    //
    // A Team Lead's new Agent gets the Team Lead's own modules: an Agent is not handed more of the
    // application than the person who created them can open.
    await this.moduleAccess.setAssigned(user.id, lead !== null ? await this.assignedModules(lead) : this.wantedModules(body));
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management', field: user.name, action: 'User created',
      details: `${user.email} · ${this.roleLabelOf(user)}`
        + (lead !== null ? ' · created by their Team Lead' : ''),
    });
    return this.payload(await this.load(user.id));
  }

  async update(actor: AuthUserRecord | null, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const lead = this.teamLeadScope(actor);
    const existing = await this.prisma.users.findUnique({ where: { id } });
    if (!existing || (lead !== null && !this.isOwnAgent(existing, lead))) {
      throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    }
    // A Team Lead edits basic profile and status only. Role, password, permissions, modules and the
    // reporting line never reach validation from this caller, so they cannot be changed.
    if (lead !== null) body = this.teamLeadBody(body, existing);
    const data = await this.validate(body, existing);
    const hierarchy: { is_team_lead?: boolean; team_lead_id?: number | null; reassign_to?: number | null } =
      lead !== null ? {} : await this.validateHierarchy(body, existing, data.role as string);

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
      ...(hierarchy.is_team_lead !== undefined ? { is_team_lead: hierarchy.is_team_lead } : {}),
      ...(hierarchy.team_lead_id !== undefined
        ? { team_lead: hierarchy.team_lead_id === null ? { disconnect: true } : { connect: { id: hierarchy.team_lead_id } } }
        : {}),
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
     * A Team Lead's Agents, when a Super Admin changes that Team Lead.
     *
     * `reassign_agents_to` moves the whole team to a replacement Team Lead, or, as null, leaves them
     * with none while one is chosen. Somebody who stops being a Team Lead hands their team to nobody
     * unless a replacement was named: an Agent reporting to a person who leads nobody is a reporting
     * line nobody can manage. Only the reporting line moves — the Agent accounts, their leads, deals
     * and history are untouched.
     */
    let moved: string | null = null;
    if (existing.is_team_lead && hierarchy.reassign_to !== undefined) {
      // The leads an Admin gave this Team Lead go with their Agents, so the replacement can manage them.
      await this.prisma.leads.updateMany({ where: { assigned_team_lead_id: user.id }, data: { assigned_team_lead_id: hierarchy.reassign_to } });
      const r = await this.prisma.users.updateMany({ where: { team_lead_id: user.id }, data: { team_lead_id: hierarchy.reassign_to } });
      if (r.count) moved = `${r.count} agent${r.count === 1 ? '' : 's'} ${hierarchy.reassign_to === null ? 'left without a Team Lead' : 'moved to the replacement Team Lead'}`;
    } else if (existing.is_team_lead && !user.is_team_lead) {
      const r = await this.prisma.users.updateMany({ where: { team_lead_id: user.id }, data: { team_lead_id: null } });
      if (r.count) moved = `${r.count} agent${r.count === 1 ? '' : 's'} left without a Team Lead`;
    }

    /*
     * TD-190 - a new name reaches the deals linked to this account. The dashboard, the reports and
     * the Admin Activities payouts read the agent by the name on the deal, so a rename left all of
     * them at $0.00. Best-effort, like the departure above: the rename itself is already saved, and
     * the same call run later (the backfill) finishes anything this could not.
     */
    let carried: string | null = null;
    // Optional only so the specs that build this service by hand still compile; the app always has it.
    if (this.rename && (existing.name ?? '') !== (user.name ?? '')) {
      try {
        const r = await this.rename.syncNameToDeals(user.id);
        if (r.deals) carried = `new name carried onto ${r.deals} deal${r.deals === 1 ? '' : 's'}`;
        if (r.skipped.length) carried = [carried, `${r.skipped.length} left for review`].filter(Boolean).join(', ');
      } catch (e) {
        carried = `new name NOT carried onto deals: ${(e as Error).message}`;
      }
    }

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

    // Not on a Team Lead's save: they cannot change permissions, and the absent map would otherwise
    // clear whatever overrides a Super Admin had set on this Agent.
    if (lead === null) await this.syncPermissions(user.id, user.role, (data.permissions ?? {}) as Record<string, unknown>);
    // Only when the caller said something about modules. An absent key means "leave it alone" here,
    // unlike on create — a PATCH-shaped save from a screen that does not edit modules must not wipe
    // the assignment.
    if (Array.isArray(body.modules)) await this.moduleAccess.setAssigned(user.id, this.wantedModules(body));
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Users', {
      section: 'User Management',
      field: user.name,
      action: goingInactive ? 'User deactivated' : 'User updated',
      details: `${user.email} · ${this.roleLabelOf(user)} · ${user.status}`
        + (lead !== null ? ' · by their Team Lead' : '')
        + (departure ? ` · ${departure}` : '')
        + (carried ? ` · ${carried}` : '')
        + (moved ? ` · ${moved}` : ''),
    });
    return this.payload(await this.load(id), lead !== null);
  }

  async destroy(actor: AuthUserRecord | null, id: number): Promise<{ message: string }> {
    const lead = this.teamLeadScope(actor);
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user || (lead !== null && !this.isOwnAgent(user, lead))) {
      throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${id}.` });
    }
    if (actor && user.id === actor.id) throw new UnprocessableEntityException({ message: 'You cannot delete your own account.' });

    /*
     * A TEAM LEAD REMOVES ONLY AN AGENT WHO HOLDS NOTHING.
     *
     * For an Agent who did not work out. Anything the Agent has to their name - a lead, a deal or
     * its documents, a note, a call, an email, a showing, a Meta connection, a calendar entry -
     * refuses the removal and points at Inactive instead, which keeps the account and every record.
     * Stricter than the Super Admin's own checks below, which refuse only what deleting would strand.
     */
    if (lead !== null) {
      const held = await this.workRecords(user);
      if (held.length) {
        const summary = held.map((r) => `${r.count} ${r.label}${r.count === 1 ? '' : 's'}`).join(', ');
        throw new UnprocessableEntityException({
          message: `${user.name} cannot be removed: they have ${summary}. Set them to Inactive instead - that ends `
            + 'their access and keeps their records.',
        });
      }
    }
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
      details: email + (lead !== null ? ' · removed by their Team Lead' : '') + (departure ? ` · ${departure}` : ''),
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

  private payload(u: UserWithPerms, forTeamLead = false): Record<string, unknown> {
    const overrides = u.user_permissions;
    const profile = phpJsonNormalize(parseJson(u.profile) ?? []);
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
      // A Team Lead is sent the basic profile only — never the commission split, loans or deal count.
      profile: forTeamLead ? this.pick(profile, TEAM_LEAD_PROFILE_KEYS) : profile,
      is_admin: isSuperAdmin(u),
      is_team_lead: u.is_team_lead,
      team_lead_id: u.team_lead_id,
      created_by_id: u.created_by_id,
      permissions: this.permissions.effectiveFor(u.role, overrides.map((p) => ({ screen: p.screen, level: p.level }))),
      overrides: overrides.length ? Object.fromEntries(overrides.map((p) => [p.screen, p.level])) : [],
    };
  }

  // ---- Team Lead (see team-lead.ts) ----

  /**
   * Null for a Super Admin (the whole table, as before); the Team Lead's own id for a Team Lead.
   * Anyone else is refused here as well as at the guard, so a caller that skips the guard is not
   * handed the table. No actor at all is a caller inside the application, which is unscoped.
   */
  private teamLeadScope(actor: AuthUserRecord | null): number | null {
    if (!actor || isSuperAdmin(actor)) return null;
    const lead = teamLeadIdOf(actor);
    if (lead === null) throw new ForbiddenException({ message: 'Administrator access required.' });
    return lead;
  }

  /** A Team Lead's own Agents: Agents reporting to them, never another Team Lead. */
  private ownAgentsWhere(lead: number): Prisma.usersWhereInput {
    return { team_lead_id: lead, role: 'agent', is_team_lead: false };
  }

  private isOwnAgent(u: users, lead: number): boolean {
    return u.team_lead_id === lead && u.role === 'agent' && !u.is_team_lead;
  }

  /** "Team Lead" for a Team Lead, otherwise the role's usual label. */
  private roleLabelOf(u: Pick<users, 'role' | 'is_team_lead'>): string {
    return u.role === 'agent' && u.is_team_lead ? 'Team Lead' : this.permissions.label(u.role);
  }

  private pick(src: unknown, keys: readonly string[]): Record<string, unknown> {
    const o = (src && typeof src === 'object' && !Array.isArray(src) ? src : {}) as Record<string, unknown>;
    return Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));
  }

  /**
   * What a Team Lead's request is allowed to say, and nothing more.
   *
   * Built from an allowlist rather than by deleting the forbidden keys, so a field added to the
   * Users form later is refused to a Team Lead until somebody decides otherwise. The role is always
   * Agent. On create the password is the new Agent's first one; on update it is not carried at all.
   * The profile is MERGED onto what is stored, so the commission split, loans and deal count a Team
   * Lead is never sent are kept rather than wiped. Fields left out of an update keep their values,
   * so "set Inactive" on its own is a complete request.
   */
  private teamLeadBody(body: Record<string, unknown>, existing: users | null): Record<string, unknown> {
    const out: Record<string, unknown> = { role: 'agent' };
    for (const k of TEAM_LEAD_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
      else if (existing) out[k] = existing[k];
    }
    if (!existing) {
      for (const k of ['password', 'password_confirmation']) {
        if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
      }
    }
    const stored = existing ? (parseJson<Record<string, unknown>>(existing.profile) ?? {}) : {};
    const asked = this.pick(body.profile, TEAM_LEAD_PROFILE_KEYS);
    delete asked.photo_path; // the picture is set through its own endpoint, not typed in
    out.profile = { ...(Array.isArray(stored) ? {} : stored), ...asked };
    return out;
  }

  /**
   * Everything an Agent has to their name, for the Team Lead's remove: the records deleting would
   * strand, plus their deals (by id, or by the name deals still carry) and so those deals'
   * documents, deal team seats, reviews, lead activity, mail and Meta. Account plumbing - settings,
   * sessions, notifications - is not information and does not count.
   */
  private async workRecords(user: users): Promise<{ label: string; count: number }[]> {
    const id = user.id;
    const [stranded, deals, seats, reviews, dealMessages, notes, calls, emails, texts, showings, sent, received, meta, forms, todos, recruits] = await Promise.all([
      this.offboarding.orphanRisk(id),
      this.prisma.transactions.count({ where: { OR: [{ agent_user_id: id }, { agent: user.name }] } }),
      this.prisma.team_members.count({ where: { OR: [{ user_id: id }, { name: user.name }] } }),
      this.prisma.transaction_reviews.count({ where: { agent_user_id: id } }),
      this.prisma.transaction_messages.count({ where: { user_id: id } }),
      this.prisma.lead_notes.count({ where: { user_id: id } }),
      this.prisma.lead_calls.count({ where: { user_id: id } }),
      this.prisma.lead_emails.count({ where: { user_id: id } }),
      this.prisma.lead_messages.count({ where: { user_id: id } }),
      this.prisma.lead_showings.count({ where: { user_id: id } }),
      this.prisma.outbound_emails.count({ where: { user_id: id } }),
      this.prisma.inbound_emails.count({ where: { user_id: id } }),
      this.prisma.meta_connections.count({ where: { user_id: id } }),
      this.prisma.meta_lead_forms.count({ where: { user_id: id } }),
      this.prisma.todos.count({ where: { user_id: id } }),
      this.prisma.recruitment_candidates.count({ where: { agent_user_id: id } }),
    ]);
    return [
      ...stranded,
      { label: 'deal (with its documents)', count: deals },
      { label: 'deal team seat', count: seats },
      { label: 'deal review', count: reviews },
      { label: 'deal message', count: dealMessages },
      { label: 'lead note', count: notes },
      { label: 'call', count: calls },
      { label: 'lead email', count: emails },
      { label: 'text message', count: texts },
      { label: 'showing', count: showings },
      { label: 'sent email', count: sent },
      { label: 'received email', count: received },
      { label: 'Meta connection', count: meta },
      { label: 'Meta lead form', count: forms },
      { label: 'to-do', count: todos },
      { label: 'recruitment record', count: recruits },
    ].filter((r) => r.count > 0);
  }

  /** The modules assigned to a user, used to give a Team Lead's new Agent the same ones. */
  private async assignedModules(userId: number): Promise<Area[]> {
    const rows = await this.prisma.user_modules.findMany({ where: { user_id: userId, status: 'active' }, select: { module_name: true } });
    const names = rows.map((r) => r.module_name);
    return AREAS.filter((a) => names.includes(a));
  }

  /**
   * A Super Admin's reporting-line fields: `is_team_lead`, `team_lead_id` and, when saving a Team
   * Lead, `reassign_agents_to`. Each is optional and an absent key means unchanged.
   *
   * Only an Agent can be a Team Lead or report to one; any other role clears both. A Team Lead does
   * not report to a Team Lead — the hierarchy is Super Admin, Team Lead, Agent — and the Team Lead
   * an Agent is given must be an active one.
   */
  private async validateHierarchy(
    body: Record<string, unknown>,
    existing: users | null,
    role: string,
  ): Promise<{ is_team_lead?: boolean; team_lead_id?: number | null; reassign_to?: number | null }> {
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);
    const errors: FieldErrors = {};
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };
    const idOrNull = (v: unknown): number | null | 'bad' => {
      if (v === null || v === '' || v === undefined) return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : 'bad';
    };

    const out: { is_team_lead?: boolean; team_lead_id?: number | null; reassign_to?: number | null } = {};

    if (role !== 'agent') {
      // Not an Agent: neither a Team Lead nor on a team. Written only if there is something to clear.
      if (!existing || existing.is_team_lead) out.is_team_lead = false;
      if (!existing || existing.team_lead_id !== null) out.team_lead_id = null;
    } else {
      if (has('is_team_lead')) out.is_team_lead = body.is_team_lead === true || body.is_team_lead === 'true' || body.is_team_lead === 1;
      const teamLead = out.is_team_lead ?? existing?.is_team_lead ?? false;

      if (teamLead) {
        // A Team Lead reports to the Super Admin, not to another Team Lead.
        if (!existing || existing.team_lead_id !== null) out.team_lead_id = null;
      } else if (has('team_lead_id')) {
        const id = idOrNull(body.team_lead_id);
        if (id === 'bad') push('team_lead_id', 'Choose a Team Lead from the list.');
        else if (id !== null) {
          const tl = await this.mustBeActiveTeamLead(id, existing?.id ?? null);
          if (tl) push('team_lead_id', tl);
          else out.team_lead_id = id;
        } else out.team_lead_id = null;
      }
    }

    if (existing?.is_team_lead && has('reassign_agents_to')) {
      const id = idOrNull(body.reassign_agents_to);
      if (id === 'bad') push('reassign_agents_to', 'Choose a replacement Team Lead from the list.');
      else if (id !== null) {
        const tl = await this.mustBeActiveTeamLead(id, existing.id);
        if (tl) push('reassign_agents_to', tl);
        else out.reassign_to = id;
      } else out.reassign_to = null;
    }

    /*
     * A LEAVING TEAM LEAD'S AGENTS MUST BE HANDED TO SOMEBODY.
     *
     * Leaving means this save deactivates them or stops them being a Team Lead. Without a decision
     * their Agents would report to a person who can no longer manage them, so the save is refused
     * until a replacement is named. "No Team Lead for now" (null) is accepted only when there is no
     * other active Team Lead to choose — the one case where a replacement genuinely cannot be given.
     */
    if (existing?.is_team_lead && errors.reassign_agents_to === undefined) {
      const stillTeamLead = role === 'agent' && (out.is_team_lead ?? existing.is_team_lead);
      const goingInactive = (existing.status ?? 'Active') === 'Active' && body.status === 'Inactive';
      if (!stillTeamLead || goingInactive) {
        const agents = await this.prisma.users.count({ where: { team_lead_id: existing.id, role: 'agent', is_team_lead: false } });
        if (agents > 0 && (out.reassign_to === undefined || out.reassign_to === null)) {
          const others = await this.prisma.users.count({
            where: { id: { not: existing.id }, role: 'agent', is_team_lead: true, status: 'Active' },
          });
          if (out.reassign_to === undefined || others > 0) {
            push('reassign_agents_to', others > 0
              ? `Choose a replacement Team Lead for ${existing.name}'s ${agents} agent${agents === 1 ? '' : 's'}.`
              : `Say what happens to ${existing.name}'s ${agents} agent${agents === 1 ? '' : 's'}: there is no other active Team Lead, so choose "No Team Lead for now".`);
          }
        }
      }
    }

    if (Object.keys(errors).length) throwValidation(errors);
    return out;
  }

  /** Null when `id` is an active Team Lead other than `self`, otherwise why not. */
  private async mustBeActiveTeamLead(id: number, self: number | null): Promise<string | null> {
    if (id === self) return 'A person cannot be their own Team Lead.';
    const tl = await this.prisma.users.findUnique({ where: { id }, select: { name: true, role: true, status: true, is_team_lead: true } });
    if (!tl || tl.role !== 'agent' || !tl.is_team_lead) return 'Choose a Team Lead from the list.';
    if ((tl.status ?? 'Active') !== 'Active') return `${tl.name}'s account is inactive.`;
    return null;
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

    // password: (required on create / nullable on update)|confirmed|policy
    if (empty(val('password'))) { if (uReq) push('password', 'The password field is required.'); }
    else {
      if (body.password_confirmation !== val('password')) push('password', 'The password field confirmation does not match.');
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
      /*
       * The shared rule, not a local minimum. This said eight characters, which accepted
       * `Admin@123` on a Super Admin account — see `password-policy.ts` for what replaced it and
       * why. An administrator setting a colleague's password is held to exactly what that
       * colleague would be held to when changing it themselves.
       */
      const problem = passwordPolicyProblem(val('password'));
      if (problem) push('password', problem);
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
