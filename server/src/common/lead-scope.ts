import { Prisma } from '@prisma/client';
import { can, isAgent, type Principal } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * WHOSE LEADS A SIGNED-IN USER MAY WORK WITH. The single definition, for every CRM module.
 *
 * ================================================================================================
 * THE TWO CATEGORIES, AND HOW THIS DATABASE ALREADY TELLS THEM APART
 *
 *   owner_user_id IS NULL   the BROKERAGE's lead — central intake, brokerage imports, website and
 *                           campaign enquiries, anything that arrived without a person's name on it
 *   owner_user_id = X       agent X's PRIVATE lead — their own book, their own relationship
 *
 * and, independently of both:
 *
 *   assigned_to = Y         who is WORKING it right now
 *
 * OWNERSHIP AND ASSIGNMENT ARE NOT THE SAME FIELD AND MUST NOT COLLAPSE INTO ONE. A brokerage lead
 * handed to an agent keeps `owner_user_id IS NULL` and gains `assigned_to = Y`, so the brokerage
 * still sees it, the assignee sees it, and no other agent does. That is the whole model, and it is
 * expressible in the columns this table already has — nothing here introduces a second ownership
 * system. See `LeadTransferService.transfer`, which is what stopped collapsing them.
 * ================================================================================================
 *
 * THE RULE
 *
 *   Everyone            leads they own, and leads assigned to them.
 *   Brokerage scope     PLUS every lead the brokerage owns (`owner_user_id IS NULL`).
 *
 * `leads.brokerage-scope` decides the second line — `admin`, `manager` and `crm`. It is asked as a
 * capability rather than tested as a role so that the answer stays right for roles nobody has
 * invented yet, and so this file is not a second place that knows which roles are which.
 *
 * WHAT NO ROLE GETS, AT ANY RANK: another agent's private book. There is no branch below that
 * returns `{}`, and that absence is load-bearing — three CRM modules used to have one. A holder of
 * brokerage scope reaches the brokerage's leads and their own, and stops.
 *
 * WHAT CHANGED, AND WHY IT IS A NARROWING OVERALL. This clause was `isSuperAdmin(user)`, so the
 * brokerage's own leads were visible to the top tier alone: a Manager's Leads screen showed **0**
 * while 81 brokerage leads sat in the database, and the CRM role — whose entire job is brokerage
 * marketing — saw nothing either. Meanwhile Campaigns and "Send a CRM Email" each answered the same
 * question with `{}`, which is EVERY lead including every agent's private book. So the CRM was
 * simultaneously too tight on the screen people work from and too loose on the two paths that
 * actually send mail to clients. Routing all three through this function fixes both directions at
 * once: brokerage roles gain the brokerage's leads, and campaigns and direct email lose their reach
 * into private books.
 *
 * Soft-deleted leads are excluded by `liveLeadWhere`, not here, because a few callers legitimately
 * want a deleted lead — the restore screen is one — and they compose the two themselves.
 */
export function leadScopeWhere(user: AuthUserRecord | null): Prisma.leadsWhereInput {
  const id = user?.id ?? -1;
  const mine: Prisma.leadsWhereInput[] = [{ assigned_to: id }, { owner_user_id: id }];
  if (hasBrokerageLeadScope(user)) mine.push({ owner_user_id: null });
  return { OR: mine };
}

/**
 * Does this person's data scope include the leads the brokerage owns?
 *
 * Exported because a few callers hold a row already and cannot express the question as a query —
 * `LeadsService.canSee`, `ResourceAccessService.assertLead` and the import engine's duplicate
 * matcher. Each of those used to spell `isSuperAdmin` itself, which is how the row answer and the
 * query answer drift apart. They now ask this, so there is exactly one definition of the scope and
 * one of the population that holds it.
 */
export function hasBrokerageLeadScope(user: Principal | null | undefined): boolean {
  return can(user, 'leads.brokerage-scope');
}

/**
 * Is this row the brokerage's own lead, rather than somebody's private one?
 *
 * One predicate so no caller re-decides what "brokerage lead" means from the column directly.
 */
export const isBrokerageLead = (lead: { owner_user_id: number | null }): boolean =>
  lead.owner_user_id === null;

/**
 * WHO OWNS A LEAD AT THE MOMENT IT ARRIVES — the one rule, for every intake path.
 *
 * ================================================================================================
 *   an AGENT creates it        → they own it. Their book, their relationship, private to them.
 *   ANYBODY ELSE creates it    → the BROKERAGE owns it (`null`), whatever the source.
 * ================================================================================================
 *
 * "Whatever the source" is the point. Manual entry, a CSV import and a Meta lead form all ask this
 * same question, so the answer cannot depend on which door the lead came through — only on who was
 * standing at it. An administrator importing a list, a CRM staffer running the brokerage's Facebook
 * ads and a manager typing in a walk-in are all the brokerage acting for itself.
 *
 * `null` IS THE ANSWER, NOT THE ABSENCE OF ONE. In this database a lead with no `owner_user_id` is
 * the brokerage's — that is what `leads_owner_email_key` COALESCEs to book 0, and what
 * `leadScopeWhere` shows to every holder of `leads.brokerage-scope`. It is not an unattributed row
 * that fell through a gap.
 *
 * WHY `isAgent` AND NOT `hasBrokerageLeadScope`. They currently name the same split from opposite
 * sides, and asking the question this way round is what keeps them honest: ownership is decided by
 * "is this person working their own book?", which is a fact about the person, not a permission an
 * administrator can grant. If the two ever disagreed, a role could create leads it could not then
 * see — so `authz.ts` lists the capability's holders as exactly the non-agent roles, and a test
 * asserts the two stay in step.
 *
 * ASSIGNMENT IS UNTOUCHED BY THIS. A brokerage lead may be assigned to an agent the moment it
 * arrives and still belong to the brokerage; that separation is the whole model.
 */
export function ownerAtIntake(user: Principal | null | undefined): number | null {
  return isAgent(user) ? (user?.id ?? null) : null;
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
