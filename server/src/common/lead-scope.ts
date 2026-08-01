import { Prisma } from '@prisma/client';
import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Whose leads a signed-in user may count or read — written once, for every screen that asks.
 *
 * It lived only in `LeadsService`, and the CRM dashboard re-stated it from memory. The two
 * disagreed in both directions at once: the dashboard gave an agent only `assigned_to`, so an agent
 * who OWNED a transferred lead was not counted; and it gave everyone else no filter at all, so an
 * administrator's dashboard read 512 while their Leads screen read 0. A tile and the screen it
 * summarises must never answer the same question differently, so both now call this.
 *
 * The rule itself is unchanged from the one the Leads module has always applied:
 *
 *   - A lead belongs to the person assigned it, and to the person who owns it. Nobody, at any rank,
 *     reads a colleague's book by virtue of their role.
 *   - The administrator still sees the brokerage's intake because the brokerage OWNS it — imports
 *     and Meta/Google leads are recorded against the administrator's account.
 *   - An unowned lead is unattributed intake; it surfaces at the top tier rather than nowhere, so an
 *     import that forgets to stamp an owner is visible to someone instead of vanishing.
 *
 * Soft-deleted leads are excluded by `liveLeadWhere`, not here, because a few callers legitimately
 * want a deleted lead — the restore screen is one — and they compose the two themselves.
 */
export function leadScopeWhere(user: AuthUserRecord | null): Prisma.leadsWhereInput {
  const id = user?.id ?? -1;
  const mine: Prisma.leadsWhereInput[] = [{ assigned_to: id }, { owner_user_id: id }];
  if (isSuperAdmin(user)) mine.push({ owner_user_id: null });
  return { OR: mine };
}

/** The same rule, with deleted leads left out — what every counter and list wants. */
export function liveLeadWhere(user: AuthUserRecord | null): Prisma.leadsWhereInput {
  return { AND: [{ deleted_at: null }, leadScopeWhere(user)] };
}

/**
 * Which lead tasks a user may count: the tasks on the leads they can see.
 *
 * Scoped through the parent lead rather than through the task's own `assigned_to`/`user_id`. The
 * dashboard tile used the task's own columns and the Lead Tasks panel used the parent's, so the
 * tile read 3 while the panel printed directly beneath it read "0 open of 0" — the same question,
 * two answers, on one screen. Going through the lead also drops tasks whose lead has been deleted,
 * which the tile counted and the panel did not.
 */
export function leadTaskScopeWhere(user: AuthUserRecord | null): Prisma.lead_tasksWhereInput {
  return { leads: { is: liveLeadWhere(user) } };
}
