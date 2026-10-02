import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { teamLeadIdOf } from '../users/team-lead';
import { LeadAssignmentHistoryService } from '../leads/lead-assignment-history.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { CrmEventNotifier } from '../notifications/crm-events.service';

export interface TeamLeadLeadRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  lead_status: string | null;
  lead_source: string | null;
  created_at: string | null;
  assigned_to: number | null;
  assigned_name: string | null;
  /** 'Active' | 'Inactive' for the assignee, so an Agent who has left shows as such. */
  assigned_status: string | null;
  /** False when the assignee is not one of this Team Lead's Agents (e.g. the Team Lead themselves). */
  assigned_in_team: boolean;
  /** The lead is with the Team Lead and not yet given to an Agent (an Admin assigned it to them). */
  with_team_lead: boolean;
  /**
   * own     the Team Lead owns it
   * admin   a brokerage lead an Admin assigned to this Team Lead (Assigned To / Lead books)
   * shared  a brokerage lead an Admin put in a CRM team this Team Lead leads
   */
  source: 'own' | 'admin' | 'shared';
  /** The team a team-shared lead is in. Null otherwise. */
  team_name: string | null;
}

const PAGE_SIZE = 25;

/**
 * TEAM LEAD LEAD ASSIGNMENT — on the CRM dashboard.
 *
 * A Team Lead hands leads to Agents on THEIR OWN team (Admin -> Team Lead -> Agent), from:
 *
 *   own     `leads.owner_user_id` is the Team Lead.
 *   admin   a BROKERAGE lead (no owner, no team) an Admin assigned to the Team Lead the existing way
 *           — `assigned_to` = the Team Lead, from the lead editor or Lead books ("assigned to you").
 *           Once the Team Lead passes it on, `assigned_to` is the Agent and
 *           `leads.assigned_team_lead_id` remembers the Team Lead, so it stays theirs to reassign
 *           while it is with one of their own Agents (or back with nobody).
 *   shared  a BROKERAGE lead an Admin placed in a CRM team the Team Lead leads (CRM Teams).
 *
 * Assigning writes `assigned_to` (and, for an Admin-assigned lead, `assigned_team_lead_id`) and
 * nothing else. The owner and the team stay exactly as they were, so ownership never moves through
 * this action — the Agent is responsible for working the lead. An assigned Agent already sees and
 * works it through the existing rules (`leadScopeWhere` and `ResourceAccessService.assertLead` both
 * accept the assignee, and accept the assigned Team Lead).
 *
 * Every rule is checked here, on the server, before anything is written:
 *   - the caller is an active Team Lead
 *   - the lead exists and is that Team Lead's own, assigned to them by an Admin, or shared with
 *     their team — including one they already passed to one of their own Agents
 *   - the chosen user is an Agent (not a Team Lead, not any other role)
 *   - the Agent reports to that Team Lead
 *   - the Agent is Active
 *
 * The write reuses the Leads module's own record keeping: the assignment history row, the
 * "Lead updated" audit entry and the "lead assigned to you" notification the lead editor sends.
 */
@Injectable()
export class TeamLeadLeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: LeadAssignmentHistoryService,
    private readonly audit: LeadAuditService,
    private readonly crmEvents: CrmEventNotifier,
  ) {}

  /** The Team Lead's own leads, a page at a time, with who handles each and the Agents to choose from. */
  async list(user: AuthUserRecord | null, q: { page?: unknown; search?: unknown; filter?: unknown; source?: unknown } = {}): Promise<{
    leads: TeamLeadLeadRow[];
    total: number;
    page: number;
    per_page: number;
    agents: { id: number; name: string }[];
  }> {
    const lead = this.mustBeTeamLead(user);
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const search = String(q.search ?? '').trim();
    const filter = String(q.filter ?? '');
    const source = String(q.source ?? '');

    const team = await this.teamIds(lead);
    const where: Prisma.leadsWhereInput = {
      AND: [
        source === 'own' ? this.ownWhere(lead)
          : source === 'shared' ? this.sharedWhere(lead)
            : source === 'admin' ? this.adminWhere(lead, team)
              : this.eligibleWhere(lead, team),
      ],
      deleted_at: null,
      ...(filter === 'unassigned' ? { assigned_to: null } : {}),
      ...(filter === 'assigned' ? { assigned_to: { not: null } } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      } : {}),
    };

    const [rows, total, agents] = await Promise.all([
      this.prisma.leads.findMany({
        where,
        select: TeamLeadLeadsService.ROW,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.leads.count({ where }),
      this.assignableAgents(lead),
    ]);

    return { leads: await this.present(rows, lead), total, page, per_page: PAGE_SIZE, agents };
  }

  /**
   * One lead, for the Assign Agent control on the lead's own page: the same row and the same Agent
   * list the dashboard card shows. A lead the Team Lead may not assign answers not found, which is
   * how the page knows to show no control at all.
   */
  async forLead(user: AuthUserRecord | null, leadId: number): Promise<{ lead: TeamLeadLeadRow; agents: { id: number; name: string }[] }> {
    const lead = this.mustBeTeamLead(user);
    const row = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null, ...this.eligibleWhere(lead, await this.teamIds(lead)) },
      select: TeamLeadLeadsService.ROW,
    });
    if (!row) throw new NotFoundException({ message: 'Lead not found.' });
    const [presented, agents] = await Promise.all([this.present([row], lead), this.assignableAgents(lead)]);
    return { lead: presented[0], agents };
  }

  private static readonly ROW = {
    id: true, name: true, email: true, phone: true, lead_status: true, lead_source: true, created_at: true, assigned_to: true,
    owner_user_id: true, team_id: true, crm_teams: { select: { name: true } },
  } as const;

  /** Rows as the card and the lead page show them: who is assigned, whether they are Active and on the team. */
  private async present(rows: Prisma.leadsGetPayload<{ select: typeof TeamLeadLeadsService.ROW }>[], lead: number): Promise<TeamLeadLeadRow[]> {
    const ids = [...new Set(rows.map((r) => r.assigned_to).filter((n): n is number => n !== null))];
    const people = ids.length
      ? await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, role: true, is_team_lead: true, team_lead_id: true } })
      : [];
    const byId = new Map(people.map((p) => [p.id, p]));

    return rows.map((r) => {
      const a = r.assigned_to !== null ? byId.get(r.assigned_to) : undefined;
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        lead_status: r.lead_status,
        lead_source: r.lead_source,
        created_at: r.created_at ? r.created_at.toISOString() : null,
        assigned_to: r.assigned_to,
        assigned_name: a?.name ?? null,
        assigned_status: a ? (a.status ?? 'Active') : null,
        assigned_in_team: !!a && a.role === 'agent' && !a.is_team_lead && a.team_lead_id === lead,
        with_team_lead: r.assigned_to === lead,
        source: TeamLeadLeadsService.sourceOf(r, lead),
        team_name: TeamLeadLeadsService.sourceOf(r, lead) === 'shared' ? (r.crm_teams?.name ?? null) : null,
      };
    });
  }

  /** Assign or reassign one of the Team Lead's own leads to one of their own Active Agents. */
  async assign(user: AuthUserRecord | null, leadId: number, agentId: unknown): Promise<{ lead_id: number; assigned_to: number; assigned_name: string; owner_user_id: number | null }> {
    const lead = this.mustBeTeamLead(user);
    const actor = user as AuthUserRecord;

    // Own, Admin-assigned or team-shared — asked of the database in one predicate, so the list and
    // the check cannot disagree about which leads are eligible.
    const row = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null, ...this.eligibleWhere(lead, await this.teamIds(lead)) },
      select: { id: true, name: true, email: true, owner_user_id: true, assigned_to: true, team_id: true, crm_teams: { select: { name: true } } },
    });
    // Anybody else's lead answers exactly like a lead that does not exist.
    if (!row) throw new NotFoundException({ message: 'Lead not found.' });

    const id = Number(agentId);
    if (!Number.isInteger(id) || id <= 0) throw new UnprocessableEntityException({ message: 'Choose an Agent from your team.' });
    const agent = await this.prisma.users.findUnique({
      where: { id },
      select: { id: true, name: true, role: true, status: true, is_team_lead: true, team_lead_id: true },
    });
    if (!agent || agent.role !== 'agent' || agent.is_team_lead) {
      throw new UnprocessableEntityException({ message: 'Leads can only be assigned to an Agent.' });
    }
    if (agent.team_lead_id !== lead) {
      throw new UnprocessableEntityException({ message: `${agent.name} is not on your team.` });
    }
    if ((agent.status ?? 'Active') !== 'Active') {
      throw new UnprocessableEntityException({ message: `${agent.name} is inactive. Choose an active Agent.` });
    }

    if (row.assigned_to !== agent.id) {
      const previous = row.assigned_to !== null
        ? await this.prisma.users.findUnique({ where: { id: row.assigned_to }, select: { name: true } })
        : null;

      /*
       * The handling Agent — and, for a lead an Admin assigned to this Team Lead, the Team Lead level
       * of the assignment, so the lead stays theirs once it is with the Agent. Owner and team are
       * not in this write, so neither can move through it.
       */
      const viaAdmin = TeamLeadLeadsService.sourceOf(row, lead) === 'admin';
      await this.prisma.leads.update({
        where: { id: row.id },
        data: { assigned_to: agent.id, ...(viaAdmin ? { assigned_team_lead_id: lead } : {}), updated_at: new Date() },
      });

      await this.history.record(
        row.id,
        { team_id: row.team_id, team_name: row.crm_teams?.name ?? null, assigned_to: row.assigned_to, assigned_name: previous?.name ?? null },
        { team_id: row.team_id, team_name: row.crm_teams?.name ?? null, assigned_to: agent.id, assigned_name: agent.name },
        { id: actor.id ?? null, name: actor.name ?? null },
        previous ? 'Reassigned by the Team Lead' : 'Assigned by the Team Lead',
      );
      const from = previous?.name ?? '';
      await this.audit.record(
        actor, 'Lead updated', row.name,
        `Changed assignment: ${from || '(empty)'} to ${agent.name} (by the Team Lead; owner${row.team_id ? ' and team' : ''} unchanged)`,
        { field: 'assigned_to', old: from, new: agent.name },
      );
      void this.crmEvents.leadAssigned({ id: row.id, first_name: row.name, last_name: null, email: row.email }, agent.id, actor.id ?? null, actor.name);
    }

    return { lead_id: row.id, assigned_to: agent.id, assigned_name: agent.name, owner_user_id: row.owner_user_id };
  }

  /** The Team Lead's own leads. */
  private ownWhere(lead: number): Prisma.leadsWhereInput {
    return { owner_user_id: lead };
  }

  /**
   * Leads an Admin shared with this Team Lead: brokerage-owned, in an ACTIVE CRM team they lead.
   * The same team the Leads screen's "My Team Leads" view reads, so the two show the same leads.
   */
  private sharedWhere(lead: number): Prisma.leadsWhereInput {
    return { owner_user_id: null, team_id: { not: null }, crm_teams: { is: { team_lead_user_id: lead, is_active: true } } };
  }

  /**
   * A brokerage lead an Admin assigned to this Team Lead: no owner, no team, and either still with
   * the Team Lead, or already passed by them (`assigned_team_lead_id`) and now with one of their own
   * Agents — Active or not, so an Inactive Agent's lead can be reassigned — or with nobody.
   *
   * Held to the Team Lead's OWN Agents rather than trusting the stamp alone: if an Admin later
   * hands the lead to somebody outside the team, it stops being this Team Lead's to manage.
   */
  private adminWhere(lead: number, team: number[]): Prisma.leadsWhereInput {
    return {
      owner_user_id: null,
      team_id: null,
      OR: [
        { assigned_to: lead },
        { assigned_team_lead_id: lead, OR: [{ assigned_to: null }, { assigned_to: { in: team } }] },
      ],
    };
  }

  private eligibleWhere(lead: number, team: number[]): Prisma.leadsWhereInput {
    return { OR: [this.ownWhere(lead), this.adminWhere(lead, team), this.sharedWhere(lead)] };
  }

  /** Every Agent who reports to this Team Lead, Active or not. */
  private async teamIds(lead: number): Promise<number[]> {
    const rows = await this.prisma.users.findMany({ where: { team_lead_id: lead, role: 'agent', is_team_lead: false }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Which of the three ways a lead the Team Lead may assign reached them. */
  private static sourceOf(r: { owner_user_id: number | null; team_id: number | null }, lead: number): 'own' | 'admin' | 'shared' {
    if (r.owner_user_id === lead) return 'own';
    return r.team_id !== null ? 'shared' : 'admin';
  }

  /** Only the Team Lead's own Agents who are Agents and Active — the whole of the choice offered. */
  private assignableAgents(lead: number): Promise<{ id: number; name: string }[]> {
    return this.prisma.users.findMany({
      where: { team_lead_id: lead, role: 'agent', is_team_lead: false, status: 'Active' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private mustBeTeamLead(user: AuthUserRecord | null): number {
    const lead = teamLeadIdOf(user);
    if (lead === null) throw new ForbiddenException({ message: 'Only a Team Lead can assign leads here.' });
    return lead;
  }
}
