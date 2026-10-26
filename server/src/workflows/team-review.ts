import type { Prisma, PrismaClient } from '@prisma/client';
import { isSuperAdmin } from '../core/authz';
import { DESK_TEAM_ROLES, deskTeamLeadIdOf } from '../users/team-lead';

/**
 * A TEAM LEAD REVIEWS THEIR TEAM'S REQUESTS (Sai, 25 Oct 2026).
 *
 * A Documentation or Accounting person's request goes to the Super Admins AND to their own Team Lead.
 * Whichever of them decides first decides it; the other is told who did. A Team Lead never decides a
 * request of their own - those go to a Super Admin, as every request did before.
 *
 * "Their team" is exact: the requester's `team_lead_id` is the lead, the requester has the lead's role
 * (Documentation leads Documentation, Accounting leads Accounting), and the lead is active.
 */
type Db = Prisma.TransactionClient | PrismaClient;
type Person = { id: number; role?: string | null; status?: string | null; is_team_lead?: boolean | null };

/** The requester's active Team Lead, when they have one of their own role; otherwise null. */
export async function teamLeadOfRequester(db: Db, requesterId: number | null | undefined): Promise<{ id: number; name: string } | null> {
  if (!requesterId) return null;
  const r = await db.users.findUnique({ where: { id: requesterId }, select: { role: true, team_lead_id: true } });
  if (!r?.team_lead_id || !DESK_TEAM_ROLES.includes(r.role)) return null;
  const lead = await db.users.findUnique({ where: { id: r.team_lead_id }, select: { id: true, name: true, role: true, status: true, is_team_lead: true } });
  if (!lead || deskTeamLeadIdOf(lead) === null || lead.role !== r.role) return null;
  return { id: lead.id, name: lead.name };
}

/** May this person approve or reject this request? A Super Admin always; a Team Lead their team's. */
export async function mayDecide(db: Db, user: Person, requesterId: number | null | undefined): Promise<boolean> {
  if (isSuperAdmin(user as never)) return true;
  if (deskTeamLeadIdOf(user) === null || !requesterId || requesterId === user.id) return false;
  const lead = await teamLeadOfRequester(db, requesterId);
  return lead?.id === user.id;
}

/** "Ravi (Documentation Team Lead)" - how a lead's decision is named to the Super Admins. */
export const leadTitle = (u: { name: string; role?: string | null }): string =>
  `${u.name} (${u.role === 'accounting' ? 'Accounting' : 'Documentation'} Team Lead)`;
