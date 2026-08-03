import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Anything that can read `users` — the base client or an interactive transaction client.
 *
 * Callers inside a `$transaction` must pass their own client, or the lookup reads OUTSIDE the
 * transaction and cannot see rows the same transaction has already written. `applySplitUpgrade`
 * reads a profile and then writes it, so that difference is not theoretical.
 */
type PrismaLike = Pick<PrismaService, 'users'>;

export interface ResolvedPerson {
  id: number;
  name: string;
  email: string | null;
  status: string | null;
  profile: string | null;
}

/**
 * Which user a record means, preferring the id it stores over the name it displays.
 *
 * WHY THIS EXISTS. Commission splits, agent emails and review notices all resolved a person with
 * `users.findFirst({ where: { name } })`. A name is editable and not unique over time, so that
 * lookup is ambiguous by construction — and `findFirst` with no `orderBy` has no defined order.
 * Measured in the Users audit (U-C1): with a deactivated agent on a 10% split and an active
 * namesake on 90%, it returned the INACTIVE row three times out of three, so every deal the new
 * agent closed would have paid the departed colleague's percentage.
 *
 * Seven call sites did that lookup, each with slightly different rules about status. This is one
 * place, so a change to what "the same person" means happens once.
 *
 * THE NAME FALLBACK IS DELIBERATE AND STAYS. Rows written before `agent_user_id` and
 * `team_members.user_id` existed, and rows whose name matched more than one account or none, have
 * no id to use — and the backfill left those NULL on purpose rather than guessing between two
 * candidates. For them this behaves exactly as it did before: no better, but no worse. Removing
 * the fallback would turn an ambiguous answer into no answer, which for a commission split is a
 * worse failure than the one being fixed.
 */
@Injectable()
export class PersonResolver {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly SELECT = { id: true, name: true, email: true, status: true, profile: true } as const;

  /**
   * By id when the record has one, otherwise by name.
   *
   * `activeOnly` matches what each caller already did: the email paths only ever wanted a live
   * account to write to, while the commission paths deliberately accept any row, because a deal
   * closed by somebody who has since left still has to pay out at their split.
   *
   * When an id is stored it is trusted even if the account is now inactive — that is the point of
   * having it. `activeOnly` then filters the *result*, so a caller that wanted a live mailbox still
   * gets nothing rather than a departed colleague's address.
   */
  async resolve(
    userId: number | null | undefined,
    name: string | null | undefined,
    opts: { activeOnly?: boolean; client?: PrismaLike } = {},
  ): Promise<ResolvedPerson | null> {
    const db = opts.client ?? this.prisma;
    const byId = userId
      ? await db.users.findUnique({ where: { id: userId }, select: PersonResolver.SELECT })
      : null;
    const found = byId ?? (name ? await this.byName(name, opts.activeOnly === true, db) : null);
    if (!found) return null;
    if (opts.activeOnly && (found.status ?? 'Active') !== 'Active') return null;
    return found;
  }

  /**
   * The last-resort lookup, with the one improvement that can be made to it: a deterministic order.
   *
   * `findFirst` without `orderBy` let the query planner decide which of two namesakes won, which
   * could change after a VACUUM or a restore with no code change. Active rows are preferred and
   * ties are broken by the lowest id, so the answer is at least stable and reproducible — it cannot
   * be made *correct*, because the question itself is ambiguous.
   */
  private async byName(name: string, activeOnly: boolean, db: PrismaLike = this.prisma): Promise<ResolvedPerson | null> {
    const rows = await db.users.findMany({
      where: { name, ...(activeOnly ? { status: 'Active' } : {}) },
      select: PersonResolver.SELECT,
      orderBy: { id: 'asc' },
    });
    if (!rows.length) return null;
    return rows.find((r) => (r.status ?? 'Active') === 'Active') ?? rows[0];
  }

  /**
   * Resolve many at once, for the callers that build a per-person cache.
   *
   * Keyed by name because that is what the transaction and team-member rows carry on screen, and
   * what the existing caches are keyed by. One query per distinct person, not one per row.
   */
  async resolveManyByName(names: string[], opts: { activeOnly?: boolean } = {}): Promise<Map<string, ResolvedPerson>> {
    const wanted = [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))];
    if (!wanted.length) return new Map();

    const rows = await this.prisma.users.findMany({
      where: { name: { in: wanted }, ...(opts.activeOnly ? { status: 'Active' } : {}) },
      select: PersonResolver.SELECT,
      orderBy: { id: 'asc' },
    });

    const out = new Map<string, ResolvedPerson>();
    for (const row of rows) {
      const held = out.get(row.name);
      // Same rule as `byName`: an active row wins, then the lowest id. Deterministic either way.
      if (!held || ((held.status ?? 'Active') !== 'Active' && (row.status ?? 'Active') === 'Active')) {
        out.set(row.name, row);
      }
    }
    return out;
  }
}
