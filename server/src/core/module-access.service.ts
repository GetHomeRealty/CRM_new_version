import { Injectable } from '@nestjs/common';
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

/** One company's licence. `company_id` is `company_settings.id`; this deployment has exactly one. */
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

  /** The company this deployment runs for. One row, id 1 — see the note on `subscriptions`. */
  private readonly companyId = 1;

  /**
   * What the company has bought.
   *
   * No row at all means fully licensed: the table is new, and a deployment upgraded before anyone
   * filled it in must keep working. An expired or suspended subscription licenses nothing.
   */
  async licence(): Promise<Licence> {
    const row = await this.prisma.subscriptions.findUnique({ where: { company_id: this.companyId } });
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

  /** The modules assigned to one person, ignoring what the company is licensed for. */
  async assigned(userId: number): Promise<Area[]> {
    const rows = await this.prisma.user_modules.findMany({
      where: { user_id: userId, status: 'active' },
      select: { module_name: true },
    });
    // No rows means nobody has decided yet — treat that as both, so a user created before this table
    // existed, or by a caller that does not know about it, is not locked out of the application.
    if (rows.length === 0) return [...AREAS];
    return AREAS.filter((a) => rows.some((r) => r.module_name === a));
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
   * Nothing reads a half-applied assignment as meaningful — the reader treats missing rows as
   * "unassigned", which is the open default.
   */
  async setAssigned(userId: number, modules: Area[], db: Pick<PrismaService, 'user_modules'> = this.prisma): Promise<Area[]> {
    const wanted = AREAS.filter((a) => modules.includes(a));
    const now = new Date();

    // Rows for modules no longer wanted go entirely, rather than being marked disabled: a stale
    // 'disabled' row and no row at all mean the same thing, and keeping both spellings around
    // invites code that checks one and not the other.
    await db.user_modules.deleteMany({ where: { user_id: userId, module_name: { notIn: wanted } } });
    for (const module_name of wanted) {
      await db.user_modules.upsert({
        where: { user_id_module_name: { user_id: userId, module_name } },
        create: { user_id: userId, module_name, status: 'active', created_at: now, updated_at: now },
        update: { status: 'active', updated_at: now },
      });
    }

    return wanted;
  }
}
