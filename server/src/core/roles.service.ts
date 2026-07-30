import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RolePermissionStore } from './role-permission.store';
import { LEVELS, SCREENS, type Level } from '../auth/permission.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Roles and their permissions, editable at runtime.
 *
 * The tables have been the source of truth since the roles migration; what was missing was any way
 * to change them without a hand-written SQL statement and a restart. Every write here refreshes the
 * in-memory snapshot, so a permission change takes effect on the next request rather than the next
 * deploy.
 *
 * THE SAFETY RULES ARE THE INTERESTING PART. A roles screen is the easiest place in an application
 * to lock everybody out of it, and the fail-closed switch made that worse: a role that grants
 * nothing now really does grant nothing.
 *
 *   - A system role cannot be deleted or renamed by key. Those six are what the application's own
 *     capabilities are defined against.
 *   - No role can be deleted while anyone holds it. `users.role` is a key, not a foreign key, so
 *     deleting the row would leave those accounts pointing at nothing — which under fail-closed
 *     means they can open nothing. Deactivation is offered instead, and is reversible.
 *   - The last role that can administer users cannot be deactivated or stripped of that power.
 *     Otherwise the screen can be used to remove the ability to get back into the screen.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: RolePermissionStore,
    private readonly audit: AuditService,
  ) {}

  /** Roles with what each grants and how many people hold it. */
  async list(): Promise<Record<string, unknown>[]> {
    const roles = await this.prisma.roles.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    const users = await this.prisma.users.groupBy({ by: ['role'], _count: true });
    const held = new Map(users.map((u) => [u.role, u._count]));

    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      is_system: r.is_system,
      is_active: r.is_active,
      sort: r.sort,
      users: held.get(r.key) ?? 0,
      // The effective map, so the screen shows what the role actually grants rather than a count.
      permissions: this.store.defaultsFor(r.key) ?? {},
    }));
  }

  /** Create a role, optionally starting from what another role grants. */
  async create(actor: AuthUserRecord | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = String(body.key ?? '').trim().toLowerCase();
    const label = String(body.label ?? '').trim();
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) {
      throw new UnprocessableEntityException({ message: 'A role key must be 2-32 characters: lowercase letters, digits and underscores, starting with a letter.' });
    }
    if (!label) throw new UnprocessableEntityException({ message: 'A role needs a name.' });
    if (await this.prisma.roles.findFirst({ where: { key } })) {
      throw new UnprocessableEntityException({ message: `A role with the key "${key}" already exists.` });
    }

    const last = await this.prisma.roles.findFirst({ orderBy: { sort: 'desc' }, select: { sort: true } });
    const now = new Date();
    const role = await this.prisma.roles.create({
      data: { key, label, is_system: false, is_active: true, sort: (last?.sort ?? 0) + 1, created_at: now, updated_at: now },
    });

    const copyFrom = String(body.copy_from ?? '').trim();
    if (copyFrom) {
      const source = this.store.defaultsFor(copyFrom);
      if (source) await this.writeGrants(role.id, source);
    }

    await this.store.reload();
    await this.logChange(actor, 'Role created', `${label} (${key})`);
    return (await this.list()).find((r) => r.id === role.id)!;
  }

  /** Rename, reorder or retire a role. The key is never editable — grants hang off it. */
  async update(actor: AuthUserRecord | null, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const role = await this.mustFind(id);
    const data: Record<string, unknown> = { updated_at: new Date() };

    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (!label) throw new UnprocessableEntityException({ message: 'A role needs a name.' });
      data.label = label;
    }

    if (body.is_active !== undefined) {
      const next = body.is_active === true || body.is_active === 'true';
      if (!next) await this.assertNotLastAdministrator(role.key, 'deactivate');
      if (!next) {
        const holders = await this.prisma.users.count({ where: { role: role.key } });
        if (holders > 0) {
          throw new UnprocessableEntityException({
            message: `${holders} ${holders === 1 ? 'person holds' : 'people hold'} this role. Move them to another role before retiring it — a retired role grants nothing.`,
          });
        }
      }
      data.is_active = next;
    }

    const updated = await this.prisma.roles.update({ where: { id }, data });
    await this.store.reload();
    await this.logChange(actor, body.is_active !== undefined ? (updated.is_active ? 'Role reactivated' : 'Role retired') : 'Role renamed', `${updated.label} (${updated.key})`);
    return (await this.list()).find((r) => r.id === id)!;
  }

  /** Replace what a role grants. Absent screens are revoked, which is what a permission editor means. */
  async setGrants(actor: AuthUserRecord | null, id: number, permissions: Record<string, unknown>): Promise<Record<string, unknown>> {
    const role = await this.mustFind(id);

    const wanted: Record<string, Level> = {};
    for (const [screen, level] of Object.entries(permissions ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(SCREENS, screen)) continue;
      if (!(LEVELS as readonly string[]).includes(String(level))) continue;
      wanted[screen] = String(level) as Level;
    }

    // Refuse to remove the last way back in before writing anything.
    if (wanted.users !== 'edit') await this.assertNotLastAdministrator(role.key, 'remove user administration from');

    await this.writeGrants(id, wanted);
    await this.store.reload();
    await this.logChange(actor, 'Role permissions changed', role.label);
    return (await this.list()).find((r) => r.id === id)!;
  }

  /** Delete a role nobody holds. */
  async remove(actor: AuthUserRecord | null, id: number): Promise<{ message: string }> {
    const role = await this.mustFind(id);
    if (role.is_system) {
      throw new UnprocessableEntityException({
        message: 'This is a built-in role and cannot be deleted. It can be renamed, and what it grants can be changed.',
      });
    }
    const holders = await this.prisma.users.count({ where: { role: role.key } });
    if (holders > 0) {
      throw new UnprocessableEntityException({
        message: `${holders} ${holders === 1 ? 'person holds' : 'people hold'} this role. Move them to another role first — deleting it would leave their accounts with no permissions at all.`,
      });
    }

    await this.prisma.role_permissions.deleteMany({ where: { role_id: id } });
    await this.prisma.roles.delete({ where: { id } });
    await this.store.reload();
    await this.logChange(actor, 'Role deleted', `${role.label} (${role.key})`);
    return { message: 'Role deleted' };
  }

  // ------------------------------------------------------------------ internals

  private async mustFind(id: number) {
    const role = await this.prisma.roles.findUnique({ where: { id } });
    if (!role) throw new NotFoundException({ message: 'That role no longer exists.' });
    return role;
  }

  /**
   * Refuse a change that would leave nobody able to administer users.
   *
   * The roles screen lives behind the very permission it can edit, so without this it can be used
   * to lock the door from the inside — with no way back in short of editing the database by hand.
   */
  private async assertNotLastAdministrator(roleKey: string, verb: string): Promise<void> {
    const roles = await this.prisma.roles.findMany({ where: { is_active: true }, select: { key: true } });
    const others = roles
      .map((r) => r.key)
      .filter((k) => k !== roleKey)
      .filter((k) => this.store.defaultsFor(k)?.users === 'edit');

    if (others.length > 0) return;

    // Nobody else can administer users — but the change is harmless if nobody holds this role.
    const holders = await this.prisma.users.count({ where: { role: roleKey } });
    if (holders === 0) return;

    throw new UnprocessableEntityException({
      message: `This is the only role that can manage users. You cannot ${verb} it — there would be no way to change roles again.`,
    });
  }

  /** Write a role's grants, replacing whatever was there. */
  private async writeGrants(roleId: number, map: Record<string, string>): Promise<void> {
    const perms = await this.prisma.permissions.findMany({ select: { id: true, screen: true, level: true } });
    const idOf = new Map(perms.map((p) => [`${p.screen}.${p.level}`, p.id]));

    const wanted: number[] = [];
    for (const [screen, level] of Object.entries(map)) {
      // Levels are ranked, so 'edit' implies 'view' and both rows are written — the reader takes
      // the highest it finds, and a query for "may view" must not miss someone who may edit.
      const rank = LEVELS.indexOf(level as Level);
      for (const l of LEVELS) {
        if (l === 'none') continue;
        if (LEVELS.indexOf(l) > rank) continue;
        const id = idOf.get(`${screen}.${l}`);
        if (id) wanted.push(id);
      }
    }

    await this.prisma.role_permissions.deleteMany({ where: { role_id: roleId } });
    if (wanted.length) {
      await this.prisma.role_permissions.createMany({
        data: wanted.map((permission_id) => ({ role_id: roleId, permission_id, created_at: new Date() })),
        skipDuplicates: true,
      });
    }
  }

  private async logChange(actor: AuthUserRecord | null, action: string, field: string): Promise<void> {
    await this.audit.logModule(actor ? { id: actor.id, name: actor.name } : null, 'Settings', {
      section: 'Roles & Permissions', field, action,
    });
  }
}
