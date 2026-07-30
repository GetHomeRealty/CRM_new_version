import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { runAsSystem } from './tenant-context';
import { LEVELS, SCREENS, type Level, type PermissionMap } from '../auth/permission.service';

/**
 * The role defaults, read from the database and held in memory.
 *
 * `PermissionService.effectiveFor` is called synchronously on nearly every request, from guards and
 * from resource serializers. Making it async to fetch grants would ripple through every call site and
 * add a query to each one, for data that changes when an administrator edits a role — which is to say
 * almost never. So the grants are loaded once at start-up and refreshed when something writes them.
 *
 * The store is deliberately incapable of locking anyone out:
 *
 *   - Until the first load completes, and if the tables are empty, `defaultsFor` returns null and the
 *     caller falls back to the defaults compiled into the application.
 *   - A failed load leaves the previous snapshot in place and logs; it never yields an empty map,
 *     because an empty map means "no access to anything" and that is never the right answer to a
 *     database hiccup.
 *
 * Screen ORDER comes from `SCREENS` in code, not from the table. The permission map is serialized into
 * API responses and its key order is part of that shape; ordering by whatever the database returned
 * would make it drift.
 */
@Injectable()
export class RolePermissionStore implements OnModuleInit {
  private readonly log = new Logger(RolePermissionStore.name);
  /** role key → screen → level. Null until a successful load has produced something. */
  private snapshot: Record<string, PermissionMap> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  private rank(level: string): number {
    const i = LEVELS.indexOf(level as Level);
    return i < 0 ? 0 : i;
  }

  /** Re-read the grants. Call after writing roles or role_permissions. */
  async reload(): Promise<void> {
    try {
      const rows = await runAsSystem(() => this.prisma.role_permissions.findMany({
        select: { roles: { select: { key: true } }, permissions: { select: { screen: true, level: true } } },
      }));
      if (rows.length === 0) {
        // Nothing seeded. Leave whatever we had — the caller falls back to the code defaults.
        this.log.warn('No role permissions in the database; using the defaults compiled into the application.');
        return;
      }

      const next: Record<string, PermissionMap> = {};
      for (const row of rows) {
        const role = row.roles.key;
        // Every screen starts at 'none' and in SCREENS order, so a role that grants nothing on a
        // screen still has the key, and the emitted shape matches what it always was.
        next[role] ??= Object.fromEntries(Object.keys(SCREENS).map((s) => [s, 'none']));
        const { screen, level } = row.permissions;
        if (!(screen in next[role])) continue; // a screen the application no longer has
        if (this.rank(level) > this.rank(next[role][screen])) next[role][screen] = level;
      }
      this.snapshot = next;
      this.log.log(`Loaded permissions for ${Object.keys(next).length} roles.`);
    } catch (e) {
      // Keep serving the previous snapshot rather than degrading access on a transient failure.
      this.log.error(`Could not load role permissions: ${(e as Error).message}`);
    }
  }

  /** The stored defaults for a role, or null when there is nothing to serve. */
  defaultsFor(role: string): PermissionMap | null {
    const map = this.snapshot?.[role];
    // A copy: callers overlay per-user overrides onto this and must not mutate the cache.
    return map ? { ...map } : null;
  }

  /** Whether the database is the source of truth right now. Surfaced for diagnostics. */
  get loaded(): boolean {
    return this.snapshot !== null;
  }

  /** The roles the database knows about, in their configured order. */
  async roles(): Promise<{ key: string; label: string; is_system: boolean }[]> {
    return runAsSystem(() => this.prisma.roles.findMany({
      where: { company_id: 1 },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      select: { key: true, label: true, is_system: true },
    }));
  }
}
