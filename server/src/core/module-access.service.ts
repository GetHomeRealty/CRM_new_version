import { Injectable } from '@nestjs/common';
import type { subscriptions } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AREAS, type Area } from '../common/domain';

/**
 * Which modules a person may open — the first piece of the Core Platform layer.
 *
 * Access is the AND of two independent facts:
 *
 *   licensed   the company bought the module        → `subscriptions`
 *   assigned   this person may open it              → `user_modules`
 *
 * Both are required, and they are stored apart on purpose. Ending a subscription must not erase who
 * was assigned what, or resubscribing would return to a blank slate instead of the arrangement the
 * brokerage had. Equally, assigning someone a module they are not licensed for is a harmless record
 * of intent rather than an error to reject at the point of assignment.
 *
 * This sits ABOVE screen permissions and does not replace them. A module decides whether an area
 * exists for you at all; the permission map still decides which screens inside it you may open. The
 * two answer different questions and both still apply.
 *
 * Everything defaults OPEN when a fact is missing — no subscription row means licensed, no module
 * rows for a user means assigned. A deployment that has not been told about licensing behaves exactly
 * as it did before licensing existed, which is what makes this safe to introduce to a running system.
 */

/** The deployment's licence. One row, enforced by a singleton unique index on `subscriptions`. */
export interface Licence {
  crm: boolean;
  desk: boolean;
  plan: string | null;
  status: string;
  expires: string | null;
  /** False once the expiry date has passed or the status is not `active`. */
  valid: boolean;
}

@Injectable()
export class ModuleAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The licence, briefly remembered.
   *
   * `ScreenGuard` asks on every request that names a screen, and a subscription changes when someone
   * signs a contract — never, on the timescale of a web request. Ten seconds is short enough that
   * nobody notices a licence change and long enough that a burst of requests costs one query.
   *
   * Expiry is still evaluated fresh against the clock on every read, so a licence cannot outlive its
   * end date by sitting in this cache.
   */
  private cached: { row: subscriptions | null; at: number } | null = null;
  private static readonly CACHE_MS = 10_000;

  /**
   * What the company has bought.
   *
   * No row at all means fully licensed: the table is new, and a deployment upgraded before anyone
   * filled it in must keep working. An expired or suspended subscription licenses nothing.
   *
   * `findFirst` rather than a keyed lookup: the row is a singleton, and the database enforces that
   * with a unique index on a constant expression rather than on a company id.
   */
  async licence(): Promise<Licence> {
    const fresh = this.cached && Date.now() - this.cached.at < ModuleAccessService.CACHE_MS;
    if (!fresh) {
      const row = await this.prisma.subscriptions.findFirst({ orderBy: { id: 'asc' } });
      this.cached = { row, at: Date.now() };
    }
    const row = this.cached!.row;
    if (!row) {
      return { crm: true, desk: true, plan: null, status: 'active', expires: null, valid: true };
    }

    const expired = !!row.expiry_date && row.expiry_date.getTime() < Date.now();
    const valid = row.status === 'active' && !expired;
    return {
      // An invalid licence grants nothing, whatever the individual flags say.
      crm: valid && row.crm_enabled,
      desk: valid && row.transaction_enabled,
      plan: row.plan,
      status: expired && row.status === 'active' ? 'expired' : row.status,
      expires: row.expiry_date ? row.expiry_date.toISOString().slice(0, 10) : null,
      valid,
    };
  }

  /**
   * The modules assigned to one person, ignoring what the company is licensed for.
   *
   * Reads EVERY row, not just the active ones, because the difference between "nobody has decided
   * yet" and "somebody decided: none" is the difference between the two rows and no rows. Filtering
   * to active in the query would collapse them and make an administrator who deliberately removed
   * every module look identical to a user nobody had got to yet — and that default is both.
   */
  async assigned(userId: number): Promise<Area[]> {
    const rows = await this.prisma.user_modules.findMany({
      where: { user_id: userId },
      select: { module_name: true, status: true },
    });
    return this.assignedFrom(rows);
  }

  /**
   * The same answer from rows already in hand.
   *
   * `AuthGuard` loads a user's module rows with the user, so the per-request check does not need a
   * query of its own.
   */
  assignedFrom(rows: { module_name: string; status: string }[]): Area[] {
    // No rows at all means nobody has decided — treat that as both, so a user created before this
    // table existed, or by a caller that does not know about it, is not locked out.
    if (rows.length === 0) return [...AREAS];
    return AREAS.filter((a) => rows.some((r) => r.module_name === a && r.status === 'active'));
  }

  /** What this person can actually open: licensed AND assigned. */
  async forUser(userId: number): Promise<Area[]> {
    const [licence, assigned] = await Promise.all([this.licence(), this.assigned(userId)]);
    return assigned.filter((a) => (a === 'crm' ? licence.crm : licence.desk));
  }

  async canOpen(userId: number, area: Area): Promise<boolean> {
    return (await this.forUser(userId)).includes(area);
  }

  /**
   * Replace someone's assignments.
   *
   * The writes are sequential rather than wrapped in `$transaction`, so this can be called from
   * inside a caller's transaction — creating a user and assigning their modules as one unit, say.
   * A nested `$transaction` is not possible in Prisma, and a service in the platform layer that
   * cannot be composed into a larger operation is a service other code has to work around.
   *
   * That is safe here because each statement is atomic and the sequence is idempotent: a failure
   * part-way leaves a subset of the intended rows, and saving again converges on the right answer.
   *
   * A module the caller did not ask for is written as a 'disabled' row rather than deleted. Deleting
   * it would erase the fact that anyone decided, and since no rows at all is read as the open
   * default, an administrator who unticked every module would grant both — the exact opposite of
   * what they did. Writing the decision down is what makes "none" sayable at all.
   */
  async setAssigned(userId: number, modules: Area[], db: Pick<PrismaService, 'user_modules'> = this.prisma): Promise<Area[]> {
    const wanted = AREAS.filter((a) => modules.includes(a));
    const now = new Date();

    for (const module_name of AREAS) {
      const status = wanted.includes(module_name) ? 'active' : 'disabled';
      await db.user_modules.upsert({
        where: { user_id_module_name: { user_id: userId, module_name } },
        create: { user_id: userId, module_name, status, created_at: now, updated_at: now },
        update: { status, updated_at: now },
      });
    }

    return wanted;
  }
}
