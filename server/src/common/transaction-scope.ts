import { Prisma } from '@prisma/client';
import { isAgent } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Which deals a signed-in user may see — written once, for every screen that asks.
 *
 * `TransactionsService` spelled this rule inline in four places and the Calendar did not spell it
 * at all: linking an event to a deal checked only that the deal EXISTED. That was enough for an
 * agent whose Transactions screen showed nothing to walk the id range and read back every deal's
 * trade number and street address, and to leave an audit entry in each one on the way past.
 *
 * The rule itself is unchanged:
 *
 *   - An agent sees the deals they are the agent on, and the deals they are split into as a team
 *     member.
 *   - A deal with no agent at all is unassigned brokerage work and is administrator-only, even
 *     when team rows exist — matching `authorizeAgentAccess`.
 *   - Every other role sees the brokerage's deals; the deal core is deliberately shared, unlike
 *     the personal CRM modules.
 *
 * WHAT CHANGED: IDENTITY IS AN ID, NOT A NAME.
 *
 * This compared `transactions.agent` to `user.name`, and `team_members.name` to the same string.
 * A name is user-editable and not unique over time — this database already holds two active
 * accounts called "Akhil", which is why `PersonResolver`, `transactions.agent_user_id` and
 * `team_members.user_id` exist at all (migration 20260803010000_person_user_ids). Under the old
 * rule those two people saw each other's deals, and renaming somebody silently moved their access.
 *
 * The rule is now: MATCH ON THE ID WHENEVER THE ROW HAS ONE. A row that carries `agent_user_id`
 * is decided by the id alone, so a namesake cannot match it however they are named. The name
 * comparison survives only for rows whose id could not be resolved — legacy deals where the name
 * matched no account, or more than one — and those keep behaving exactly as they did before, which
 * is what stops this from removing access anybody has today. Migration
 * 20260814090000_transaction_owner_ids re-runs the backfill and reports what is left.
 */

/** The subset of the signed-in user this module needs. Every caller already has these three. */
export interface ScopedUser {
  id?: number | null;
  name?: string | null;
  role?: string | null;
}

/** A user record with no usable identity matches nothing, rather than matching everything. */
const MATCHES_NOTHING: Prisma.transactionsWhereInput = { id: { in: [] } };

const idOf = (user: ScopedUser | null | undefined): number | null =>
  typeof user?.id === 'number' && Number.isFinite(user.id) ? user.id : null;

const nameOf = (user: ScopedUser | null | undefined): string | null => {
  const n = (user?.name ?? '').trim();
  return n === '' ? null : n;
};

/**
 * "This person is the agent on the deal" — as a query term.
 *
 * Two shapes, and the second one is deliberately narrow: it only applies to rows that have no
 * `agent_user_id`, so a resolved row is never re-decided by its name.
 */
function ownerTerms(user: ScopedUser): Prisma.transactionsWhereInput[] {
  const id = idOf(user);
  const name = nameOf(user);
  const terms: Prisma.transactionsWhereInput[] = [];
  if (id !== null) terms.push({ agent_user_id: id });
  if (name !== null) terms.push({ AND: [{ agent_user_id: null }, { agent: name }] });
  return terms;
}

/**
 * "This person is on the team split" — as a `team_members` term.
 *
 * Exported because the write path and the document guards look the membership row up directly
 * (they also care about `access`), and a second spelling of "which row is mine" is exactly how the
 * id rule would come back apart.
 */
export function teamMemberIdentity(user: ScopedUser): Prisma.team_membersWhereInput {
  const id = idOf(user);
  const name = nameOf(user);
  const or: Prisma.team_membersWhereInput[] = [];
  if (id !== null) or.push({ user_id: id });
  if (name !== null) or.push({ AND: [{ user_id: null }, { name }] });
  // No identity at all: a term that cannot match, rather than one that matches every row.
  return or.length ? { OR: or } : { id: { in: [] } };
}

/** The deals this user is the agent on. Empty for anyone who is not an agent. */
export function transactionOwnerWhere(user: ScopedUser | null | undefined): Prisma.transactionsWhereInput {
  if (!user || !isAgent(user)) return {};
  const terms = ownerTerms(user);
  return terms.length ? { OR: terms } : MATCHES_NOTHING;
}

/** The deals this user is the agent on, plus the deals they are split into. */
export function transactionScopeWhere(user: ScopedUser | null | undefined): Prisma.transactionsWhereInput {
  if (!user || !isAgent(user)) return {};
  const terms = ownerTerms(user);
  if (!terms.length) return MATCHES_NOTHING;
  return {
    OR: [
      ...terms,
      {
        AND: [
          // An unassigned deal is nobody's, so team rows on it grant nothing.
          { agent: { not: null } },
          { agent: { not: '' } },
          { team_members: { some: teamMemberIdentity(user) } },
        ],
      },
    ],
  };
}

/**
 * The same owner question, answered against a row already in hand.
 *
 * Used by the per-record guards, which have loaded the transaction anyway and would otherwise
 * re-state the id-then-name rule in six places.
 */
export function ownsTransaction(
  user: ScopedUser | null | undefined,
  txn: { agent: string | null; agent_user_id: number | null },
): boolean {
  if (!user) return false;
  const id = idOf(user);
  if (txn.agent_user_id !== null) return id !== null && txn.agent_user_id === id;
  const name = nameOf(user);
  return name !== null && txn.agent === name;
}

/**
 * Which REVIEW items belong to this person — the same rule, for `transaction_reviews`.
 *
 * A review decision is about an agent, and until now it said so with `agent_name` only. Two active
 * accounts here share a name, so a namesake's review feed, unread count, notification and
 * mark-as-seen all matched the wrong person's items — and a review item carries the rejected field,
 * the reason, and the old and new values. That is the same class of disclosure the transaction scope
 * was moved off names to prevent.
 *
 * Same shape as `transactionScopeWhere`: the id decides wherever the row has one, and the name
 * decides only rows written before `agent_user_id` existed or whose owner could not be resolved.
 * Empty for anyone who is not an agent — the office sees the brokerage's reviews, as it always has.
 */
export function reviewScopeWhere(user: ScopedUser | null | undefined): Prisma.transaction_reviewsWhereInput {
  if (!user || !isAgent(user)) return {};
  const id = idOf(user);
  const name = nameOf(user);
  const or: Prisma.transaction_reviewsWhereInput[] = [];
  if (id !== null) or.push({ agent_user_id: id });
  if (name !== null) or.push({ AND: [{ agent_user_id: null }, { agent_name: name }] });
  return or.length ? { OR: or } : { id: { in: [] } };
}

/** Narrow an `AuthUserRecord` to what this module reads, for callers that hold the full record. */
export const scopedUser = (u: AuthUserRecord | null | undefined): ScopedUser | null =>
  u ? { id: u.id, name: u.name, role: u.role } : null;
