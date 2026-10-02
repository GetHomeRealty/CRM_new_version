import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { isSuperAdmin } from '../core/authz';
import { teamLeadIdOf } from '../users/team-lead';

export interface StatusCounts { total: number; active: number; inactive: number }

export interface TeamStructureRow {
  team_lead_id: number | null;
  team_lead_name: string | null;
  team_lead_status: string | null;
  agents: StatusCounts;
}

/**
 * The CRM dashboard's Team Lead cards — who manages whom, counted from Users and nothing else.
 *
 *   Super Admin  every Team Lead and Agent, and the Agents grouped by Team Lead
 *   Team Lead    their own Agents only
 *   anyone else  nothing (`scope: 'none'`), so the Agent dashboard is exactly what it was
 *
 * Reads `users` only. No lead, deal or calendar figure is computed here, so these cards cannot
 * disagree with, or change, any other module's numbers.
 *
 * An "Agent" here is `role = 'agent'` and not a Team Lead; a Team Lead is the same role with the
 * flag (see users/team-lead.ts).
 */
@Injectable()
export class TeamStructureService {
  constructor(private readonly prisma: PrismaService) {}

  async forUser(user: AuthUserRecord | null): Promise<
    | { scope: 'admin'; team_leads: StatusCounts; agents: StatusCounts; teams: TeamStructureRow[] }
    | { scope: 'team_lead'; agents: StatusCounts; members: { id: number; name: string; status: string }[] }
    | { scope: 'none' }
  > {
    if (isSuperAdmin(user)) return { scope: 'admin', ...(await this.brokerage()) };

    const lead = teamLeadIdOf(user);
    if (lead !== null) {
      const members = await this.prisma.users.findMany({
        where: { role: 'agent', is_team_lead: false, team_lead_id: lead },
        select: { id: true, name: true, status: true },
        orderBy: { name: 'asc' },
      });
      return {
        scope: 'team_lead',
        agents: this.count(members),
        members: members.map((m) => ({ id: m.id, name: m.name, status: m.status ?? 'Active' })),
      };
    }

    return { scope: 'none' };
  }

  private async brokerage(): Promise<{ team_leads: StatusCounts; agents: StatusCounts; teams: TeamStructureRow[] }> {
    const [leads, agents] = await Promise.all([
      this.prisma.users.findMany({ where: { role: 'agent', is_team_lead: true }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } }),
      this.prisma.users.findMany({ where: { role: 'agent', is_team_lead: false }, select: { status: true, team_lead_id: true } }),
    ]);

    const byLead = new Map<number | null, { status: string | null }[]>();
    for (const a of agents) {
      // An Agent pointing at somebody who is no longer a Team Lead is unassigned in practice.
      const key = a.team_lead_id !== null && leads.some((l) => l.id === a.team_lead_id) ? a.team_lead_id : null;
      byLead.set(key, [...(byLead.get(key) ?? []), a]);
    }

    const teams: TeamStructureRow[] = leads.map((l) => ({
      team_lead_id: l.id,
      team_lead_name: l.name,
      team_lead_status: l.status ?? 'Active',
      agents: this.count(byLead.get(l.id) ?? []),
    }));
    const unassigned = byLead.get(null) ?? [];
    if (unassigned.length) teams.push({ team_lead_id: null, team_lead_name: null, team_lead_status: null, agents: this.count(unassigned) });

    return { team_leads: this.count(leads), agents: this.count(agents), teams };
  }

  /** Active means exactly "Active"; anything else is counted as inactive, as the Users screen shows it. */
  private count(rows: { status: string | null }[]): StatusCounts {
    const active = rows.filter((r) => (r.status ?? 'Active') === 'Active').length;
    return { total: rows.length, active, inactive: rows.length - active };
  }
}
