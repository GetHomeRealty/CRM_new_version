import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';
import { leadScopeWhere } from '../common/lead-scope';
import { throwValidation } from '../common/laravel-exceptions';
import { LeadAuditService } from './lead-audit.service';
import { LeadAssignmentHistoryService, type AssignmentSide } from './lead-assignment-history.service';
import { CrmEventNotifier } from '../notifications/crm-events.service';

/** The lead fields an assignment decision reads. */
export interface AssignableLead {
  id: number;
  name: string;
  email?: string | null;
  owner_user_id: number | null;
  team_id: number | null;
  assigned_to: number | null;
}

/** A validated change: where the lead ends up, plus the names the history needs. */
export interface AssignmentPlan {
  before: AssignmentSide;
  after: AssignmentSide;
  changed: boolean;
}

const hasKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * TEAM OWNERSHIP AND AGENT HANDLING — the rules, in one place.
 *
 * ================================================================================================
 *   team_id       the team that OWNS the lead (null = not a team lead)
 *   assigned_to   the agent HANDLING it right now (null = unassigned) — `assigned_to_user_id`
 * ================================================================================================
 *
 * They are separate facts and every rule below keeps them separate: reassigning the handler never
 * touches the team, and the team is changed only on purpose.
 *
 * WHO MAY DO WHAT
 *
 *   Admin / Super Admin (`leads.rewrite-identity`)
 *       put a brokerage lead in a team, move it between teams, take it out of a team, and choose
 *       any handler — who must be an active member when the lead has a team.
 *   Team Lead of the lead's team
 *       choose, change or clear the handler, among the team's active members. Cannot change the
 *       team: the lead stays owned by the team whatever they do.
 *   Everybody else, including the team's own agents
 *       nothing here. An agent works the lead; they do not route it.
 *
 * WHAT NOBODY MAY DO: put an agent's PRIVATE lead in a team. A private lead is its agent's own book
 * and the private-lead rules are unchanged by teams — the database's `leads_private_or_team_chk`
 * refuses such a row as well, so this is the readable version of a rule already enforced below.
 */
@Injectable()
export class LeadTeamAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
    private readonly history: LeadAssignmentHistoryService,
    private readonly crmEvents?: CrmEventNotifier,
  ) {}

  /** May this person move leads between teams (and in or out of one)? */
  mayMoveTeams(user: AuthUserRecord): boolean {
    return can(user, 'leads.rewrite-identity');
  }

  /** Is this person the Team Lead of this (active) team? */
  async leadsTeam(teamId: number | null, userId: number | undefined): Promise<boolean> {
    if (teamId === null || !userId) return false;
    const team = await this.prisma.crm_teams.findFirst({
      where: { id: teamId, is_active: true, team_lead_user_id: userId }, select: { id: true },
    });
    return !!team;
  }

  /**
   * Is this person someone the team's leads may be handed to: an ACTIVE user who is the team's lead
   * or an active member of it.
   */
  async isAssignableMember(teamId: number, userId: number): Promise<boolean> {
    const team = await this.prisma.crm_teams.findFirst({
      where: {
        id: teamId,
        OR: [
          { team_lead_user_id: userId },
          { crm_team_members: { some: { user_id: userId, is_active: true } } },
        ],
      },
      select: { id: true },
    });
    if (!team) return false;
    const user = await this.prisma.users.findFirst({ where: { id: userId }, select: { status: true } });
    return !!user && (user.status ?? 'Active') !== 'Inactive';
  }

  private parseId(raw: unknown, field: string): number | null {
    if (raw === null || raw === undefined || raw === '' || raw === 'unassigned' || raw === 'none') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throwValidation({ [field]: ['Not a valid selection.'] });
    return n;
  }

  /**
   * Validate a requested team / handler change against the rules above, without writing anything.
   *
   * `body` may carry `team_id`, `assigned_to`, or both. A key that is absent means "leave it". When
   * the team changes and no handler is named, the current handler is kept only if they are a member
   * of the new team — otherwise the lead arrives in its new team unassigned, rather than handled by
   * somebody who cannot see it.
   */
  async plan(lead: AssignableLead, body: Record<string, unknown>, user: AuthUserRecord): Promise<AssignmentPlan> {
    const teamGiven = hasKey(body, 'team_id');
    const agentGiven = hasKey(body, 'assigned_to') || hasKey(body, 'assigned_to_user_id');
    const rawAgent = hasKey(body, 'assigned_to') ? body.assigned_to : body.assigned_to_user_id;

    const targetTeam = teamGiven ? this.parseId(body.team_id, 'team_id') : lead.team_id;
    const teamChanged = targetTeam !== lead.team_id;

    if (lead.owner_user_id !== null && targetTeam !== null) {
      throwValidation({ team_id: ['This is an agent’s private lead, so it cannot be given to a team. Private leads stay with their agent.'] });
    }

    const mayMove = this.mayMoveTeams(user);
    if (teamChanged && !mayMove) {
      throw new ForbiddenException({ message: 'Only an administrator can move a lead to another team.' });
    }

    // The handler after this change.
    let targetAgent: number | null;
    if (agentGiven) targetAgent = this.parseId(rawAgent, 'assigned_to');
    else if (teamChanged && lead.assigned_to !== null && targetTeam !== null) {
      targetAgent = (await this.isAssignableMember(targetTeam, lead.assigned_to)) ? lead.assigned_to : null;
    } else targetAgent = lead.assigned_to;
    const agentChanged = targetAgent !== lead.assigned_to;

    // Handler changes on a TEAM lead: an administrator, or that team's own lead.
    if (agentChanged && !mayMove) {
      const current = targetTeam;
      if (current === null || !(await this.leadsTeam(current, user.id))) {
        throw new ForbiddenException({
          message: 'Only the team lead or an administrator can change who handles this lead.',
        });
      }
    }

    let teamName: string | null = null;
    if (targetTeam !== null) {
      const team = await this.prisma.crm_teams.findUnique({ where: { id: targetTeam }, select: { name: true, is_active: true } });
      if (!team) throwValidation({ team_id: ['That team does not exist.'] });
      if (teamChanged && !team!.is_active) throwValidation({ team_id: [`${team!.name} is inactive, so leads cannot be given to it.`] });
      teamName = team!.name;
    }

    if (agentChanged && targetAgent !== null) {
      const person = await this.prisma.users.findFirst({ where: { id: targetAgent }, select: { name: true, status: true } });
      if (!person) throwValidation({ assigned_to: ['That user does not exist.'] });
      if ((person!.status ?? 'Active') === 'Inactive') throwValidation({ assigned_to: [`${person!.name}’s account is inactive.`] });
      if (targetTeam !== null && !(await this.isAssignableMember(targetTeam, targetAgent))) {
        throwValidation({ assigned_to: [`${person!.name} is not an active member of ${teamName}. Only the team’s active members can handle its leads.`] });
      }
    }

    const names = await this.userNames([lead.assigned_to, targetAgent]);
    const beforeTeamName = lead.team_id === null ? null
      : lead.team_id === targetTeam ? teamName
        : (await this.prisma.crm_teams.findUnique({ where: { id: lead.team_id }, select: { name: true } }))?.name ?? null;

    return {
      before: { team_id: lead.team_id, team_name: beforeTeamName, assigned_to: lead.assigned_to, assigned_name: lead.assigned_to ? names.get(lead.assigned_to) ?? null : null },
      after: { team_id: targetTeam, team_name: teamName, assigned_to: targetAgent, assigned_name: targetAgent ? names.get(targetAgent) ?? null : null },
      changed: teamChanged || agentChanged,
    };
  }

  /**
   * Record what a plan did: the ownership history, the audit trail, and the assignee's notification.
   * Called after the row has been written, so nothing announces a change a later failure undid.
   */
  async afterWrite(lead: AssignableLead, plan: AssignmentPlan, user: AuthUserRecord): Promise<void> {
    if (!plan.changed) return;
    const lines = await this.history.record(lead.id, plan.before, plan.after, { id: user.id ?? null, name: user.name ?? null });
    for (const line of lines) await this.audit.record(user, 'Lead assignment changed', lead.name, line);
    if (plan.after.assigned_to && plan.after.assigned_to !== plan.before.assigned_to && plan.after.assigned_to !== (user.id ?? null)) {
      void this.crmEvents?.leadAssigned(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email ?? null },
        plan.after.assigned_to, user.id ?? null, user.name,
      );
    }
  }

  /**
   * PUT /leads/:id/team-assignment — the Team & Assignment control.
   *
   * Scoped like every other read: a lead the caller cannot see is not found, whatever their role.
   */
  async assign(leadId: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const lead = await this.prisma.leads.findFirst({
      where: { AND: [{ id: leadId, deleted_at: null }, leadScopeWhere(user)] },
      select: { id: true, name: true, email: true, owner_user_id: true, team_id: true, assigned_to: true },
    });
    if (!lead) throw new NotFoundException({ message: 'Lead not found.' });

    const plan = await this.plan(lead, body ?? {}, user);
    if (plan.changed) {
      await this.prisma.leads.update({
        where: { id: lead.id },
        data: { team_id: plan.after.team_id, assigned_to: plan.after.assigned_to, updated_at: new Date() },
      });
      await this.afterWrite(lead, plan, user);
    }
    return {
      id: lead.id,
      team_id: plan.after.team_id,
      team_name: plan.after.team_name ?? null,
      assigned_to: plan.after.assigned_to,
      assigned_to_user_id: plan.after.assigned_to,
      assigned_to_name: plan.after.assigned_name ?? null,
      ownership_type: lead.owner_user_id !== null ? 'PRIVATE' : plan.after.team_id !== null ? 'TEAM' : 'BROKERAGE',
      changed: plan.changed,
    };
  }

  private async userNames(ids: (number | null)[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((n): n is number => typeof n === 'number' && n > 0))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.users.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
