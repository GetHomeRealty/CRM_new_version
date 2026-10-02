import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isSuperAdmin } from '../core/authz';

/**
 * TEAM LEAD — an Agent who manages their own team of Agents from the Users module.
 *
 * A Team Lead is `role = 'agent'` plus `is_team_lead = true`, never a role of its own. Every other
 * module limits an Agent to their own records by testing for the `agent` role, so a separate role
 * key would be treated as brokerage staff everywhere outside Users. Keeping the role means Leads,
 * Transactions, Documents, Reports and the rest see a Team Lead exactly as they see any Agent; only
 * Users and Dashboard read the flag. See migration 20261002120000_users_team_lead.
 *
 * WHAT A TEAM LEAD MAY DO IN USERS
 *   list / view    their own Agents only
 *   create         Agents only, linked to themselves
 *   edit           basic profile and Active / Inactive on their own Agents
 *   remove         their own Agent ONLY when that Agent holds no records at all (no leads, deals,
 *                  documents, notes, mail, Meta...); otherwise Inactive is the way out
 *   never          change role, permissions or modules, transfer to another Team Lead
 */

interface TeamLeadPrincipal {
  id?: number | null;
  role?: string | null;
  status?: string | null;
  is_team_lead?: boolean | null;
}

/** The Team Lead's own user id when this principal is an active Team Lead, otherwise null. */
export function teamLeadIdOf(u: TeamLeadPrincipal | null | undefined): number | null {
  if (!u?.id || !u.is_team_lead) return null;
  if ((u.role ?? '') !== 'agent') return null;
  if ((u.status ?? 'Active') !== 'Active') return null;
  return u.id;
}

/**
 * Profile keys a Team Lead may read and write on their Agents.
 *
 * The profile also carries the commission split, loans and deal counts — somebody's pay, which is
 * Transaction Desk business and not a Team Lead's. Those are stripped from what a Team Lead is sent,
 * and a Team Lead's save is MERGED onto the stored profile through this list, so a form that never
 * held those keys cannot wipe them.
 */
export const TEAM_LEAD_PROFILE_KEYS = ['mobile', 'gender', 'personal_email', 'org_email', 'onboard_date', 'photo_path'] as const;

/** Top-level fields a Team Lead may change on one of their Agents. */
export const TEAM_LEAD_EDITABLE_FIELDS = ['name', 'username', 'email', 'status', 'department', 'designation'] as const;

const TEAM_LEAD_ALLOWED = 'users:team-lead-allowed';

/** Marks a Users route a Team Lead may call. The service still scopes what they get. */
export const TeamLeadAllowed = (): MethodDecorator & ClassDecorator => SetMetadata(TEAM_LEAD_ALLOWED, true);

/**
 * The Users module's door: a Super Admin everywhere, as before, and an active Team Lead on the
 * routes marked `@TeamLeadAllowed()`. Every other route answers exactly what `AdminGuard` answered.
 * Must run after AuthGuard.
 */
@Injectable()
export class UsersAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (isSuperAdmin(req.authUser)) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(TEAM_LEAD_ALLOWED, [context.getHandler(), context.getClass()]);
    if (allowed && teamLeadIdOf(req.authUser) !== null) return true;
    throw new ForbiddenException({ message: 'Administrator access required.' });
  }
}
