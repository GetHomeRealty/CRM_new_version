import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { can, isAdminOrAbove } from '../core/authz';
import { hasBrokerageLeadScope, liveLeadWhere, myTeamLeadsWhere, teamReaderWhere } from '../common/lead-scope';
import { throwValidation } from '../common/laravel-exceptions';
import { LeadAuditService } from './lead-audit.service';
import { LeadAssignmentHistoryService } from './lead-assignment-history.service';

const str = (v: unknown): string => String(v ?? '').trim();

/** A team as the Settings → Teams screen shows it. */
export interface TeamRecord {
  id: number;
  name: string;
  description: string | null;
  team_lead_user_id: number | null;
  team_lead_name: string | null;
  team_lead_active: boolean;
  is_active: boolean;
  members: { user_id: number; name: string; role: string; is_active: boolean; user_active: boolean }[];
  lead_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** One team's line in the team report. */
export interface TeamReportRow {
  team_id: number;
  team_name: string;
  team_lead_name: string | null;
  is_active: boolean;
  total: number;
  assigned: number;
  unassigned: number;
  converted: number;
  conversion_rate: number;
  agents: {
    user_id: number;
    name: string;
    is_member: boolean;
    assigned: number;
    converted: number;
    conversion_rate: number;
  }[];
}

const rate = (converted: number, total: number): number => (total ? Math.round((converted / total) * 1000) / 10 : 0);

/**
 * CRM TEAMS — CRM → Settings → Teams, plus the team views the Leads screen and dashboard read.
 *
 * WHO MAY DO WHAT
 *
 *   Admin / Super Admin (`isAdminOrAbove`)  create, edit, (de)activate teams and manage members;
 *                                           see every team's report and activity.
 *   A Team Lead                             see their own team's report and activity. They route
 *                                           leads through `LeadTeamAssignmentService`, not here.
 *   Everybody else                          the lookup only — the teams they belong to, for filters
 *                                           and dropdowns.
 *
 * Team management follows the people-management ladder rather than `settings` edit, because
 * choosing who is in a team decides whose leads a person can read.
 */
@Injectable()
export class CrmTeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
    private readonly history: LeadAssignmentHistoryService,
  ) {}

  mayManage(user: AuthUserRecord): boolean {
    return isAdminOrAbove(user);
  }

  private assertManage(user: AuthUserRecord): void {
    if (!this.mayManage(user)) {
      throw new ForbiddenException({ message: 'Only an administrator can manage teams.' });
    }
  }

  // --------------------------------------------------------------------- read
  /** Every team, with members and how many live leads each owns. Administrators only. */
  async list(user: AuthUserRecord): Promise<TeamRecord[]> {
    this.assertManage(user);
    return this.load({});
  }

  private async load(where: Prisma.crm_teamsWhereInput): Promise<TeamRecord[]> {
    const teams = await this.prisma.crm_teams.findMany({
      where,
      orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
      include: {
        team_lead: { select: { name: true, status: true } },
        crm_team_members: {
          include: { users: { select: { name: true, role: true, status: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });
    const counts = await this.prisma.leads.groupBy({
      by: ['team_id'], where: { deleted_at: null, team_id: { in: teams.map((t) => t.id) } }, _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [c.team_id as number, c._count._all]));
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      team_lead_user_id: t.team_lead_user_id,
      team_lead_name: t.team_lead?.name ?? null,
      team_lead_active: (t.team_lead?.status ?? 'Active') !== 'Inactive',
      is_active: t.is_active,
      members: t.crm_team_members.map((m) => ({
        user_id: m.user_id,
        name: m.users.name,
        role: m.users.role ?? 'agent',
        is_active: m.is_active,
        user_active: (m.users.status ?? 'Active') !== 'Inactive',
      })),
      lead_count: countOf.get(t.id) ?? 0,
      created_at: t.created_at?.toISOString() ?? null,
      updated_at: t.updated_at?.toISOString() ?? null,
    }));
  }

  /**
   * What the Leads screen, the lead form and the dashboard need to draw team controls — and no
   * more than the caller may know.
   *
   *   administrators and brokerage staff   every team (they can already see every team's leads)
   *   everybody else                       only the teams they lead or belong to
   *
   * Each team carries its ACTIVE, ASSIGNABLE members: the only people its leads may be handed to.
   */
  async lookup(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const me = user.id ?? -1;
    const seesAll = this.mayManage(user) || hasBrokerageLeadScope(user);
    const teams = await this.prisma.crm_teams.findMany({
      where: seesAll ? {} : teamReaderWhere(me),
      orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
      include: {
        team_lead: { select: { id: true, name: true, status: true } },
        crm_team_members: {
          where: { is_active: true, users: { status: { not: 'Inactive' } } },
          include: { users: { select: { id: true, name: true } } },
        },
      },
    });

    return {
      teams: teams.map((t) => {
        const members = new Map<number, string>();
        if (t.team_lead && (t.team_lead.status ?? 'Active') !== 'Inactive') members.set(t.team_lead.id, t.team_lead.name);
        for (const m of t.crm_team_members) members.set(m.users.id, m.users.name);
        return {
          id: t.id,
          name: t.name,
          is_active: t.is_active,
          team_lead_user_id: t.team_lead_user_id,
          team_lead_name: t.team_lead?.name ?? null,
          members: [...members].map(([user_id, name]) => ({ user_id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        };
      }),
      led_team_ids: teams.filter((t) => t.is_active && t.team_lead_user_id === me).map((t) => t.id),
      member_team_ids: teams
        .filter((t) => t.is_active && (t.team_lead_user_id === me || t.crm_team_members.some((m) => m.user_id === me)))
        .map((t) => t.id),
      can_manage: this.mayManage(user),
      can_move_teams: can(user, 'leads.rewrite-identity'),
      sees_brokerage: hasBrokerageLeadScope(user),
    };
  }

  // -------------------------------------------------------------------- write
  private async validateTeam(body: Record<string, unknown>, selfId: number | null, partial: boolean): Promise<Prisma.crm_teamsUncheckedUpdateInput> {
    const errors: Record<string, string[]> = {};
    const add = (f: string, m: string) => { (errors[f] ??= []).push(m); };
    const out: Prisma.crm_teamsUncheckedUpdateInput = {};
    const has = (k: string) => body[k] !== undefined;

    if (!partial || has('name')) {
      const name = str(body.name);
      if (!name) add('name', 'A team name is required.');
      else if (name.length > 120) add('name', 'The team name must be 120 characters or fewer.');
      else {
        const clash = await this.prisma.crm_teams.findFirst({
          where: { name: { equals: name, mode: 'insensitive' }, ...(selfId ? { id: { not: selfId } } : {}) },
          select: { id: true },
        });
        if (clash) add('name', 'Another team already has that name.');
        else out.name = name;
      }
    }
    if (has('description')) {
      const d = str(body.description);
      if (d.length > 2000) add('description', 'The description must be 2,000 characters or fewer.');
      else out.description = d || null;
    }
    if (has('team_lead_user_id')) {
      const raw = body.team_lead_user_id;
      if (raw === null || raw === '') out.team_lead_user_id = null;
      else {
        const id = Number(raw);
        const u = Number.isInteger(id) && id > 0
          ? await this.prisma.users.findFirst({ where: { id }, select: { id: true, name: true, status: true } })
          : null;
        if (!u) add('team_lead_user_id', 'Choose a team lead who exists.');
        else if ((u.status ?? 'Active') === 'Inactive') add('team_lead_user_id', `${u.name}’s account is inactive.`);
        else out.team_lead_user_id = u.id;
      }
    }
    if (has('is_active')) out.is_active = body.is_active === true || body.is_active === 'true' || body.is_active === 1;

    if (Object.keys(errors).length) throwValidation(errors);
    return out;
  }

  /** The member ids a body asks for, validated as real, active users. */
  private async validateMemberIds(raw: unknown): Promise<number[]> {
    if (!Array.isArray(raw)) throwValidation({ member_ids: ['Members must be a list of users.'] });
    const ids = [...new Set((raw as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    const users = await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true } });
    const missing = ids.filter((id) => !users.some((u) => u.id === id));
    if (missing.length) throwValidation({ member_ids: ['One or more of those people no longer exist.'] });
    const inactive = users.filter((u) => (u.status ?? 'Active') === 'Inactive');
    if (inactive.length) throwValidation({ member_ids: [`${inactive.map((u) => u.name).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} inactive and cannot join a team.`] });
    return ids;
  }

  async create(body: Record<string, unknown>, user: AuthUserRecord): Promise<TeamRecord> {
    this.assertManage(user);
    const data = await this.validateTeam(body ?? {}, null, false);
    const memberIds = body?.member_ids !== undefined ? await this.validateMemberIds(body.member_ids) : [];
    const lead = (data.team_lead_user_id as number | null | undefined) ?? null;
    const now = new Date();
    const team = await this.prisma.crm_teams.create({
      data: {
        name: data.name as string,
        description: (data.description as string | null | undefined) ?? null,
        team_lead_user_id: lead,
        is_active: (data.is_active as boolean | undefined) ?? true,
        created_at: now,
        updated_at: now,
      },
    });
    // The team lead is a member of their own team — they are one of the people its leads go to.
    const everyone = [...new Set([...memberIds, ...(lead ? [lead] : [])])];
    if (everyone.length) {
      await this.prisma.crm_team_members.createMany({
        data: everyone.map((user_id) => ({ team_id: team.id, user_id, is_active: true, created_at: now })),
        skipDuplicates: true,
      });
    }
    await this.audit.record(user, 'Team created', team.name, `${everyone.length} member(s)`);
    return this.one(team.id);
  }

  async update(id: number, body: Record<string, unknown>, user: AuthUserRecord): Promise<TeamRecord> {
    this.assertManage(user);
    const existing = await this.prisma.crm_teams.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: 'Team not found.' });
    const data = await this.validateTeam(body ?? {}, id, true);
    const now = new Date();
    await this.prisma.crm_teams.update({ where: { id }, data: { ...data, updated_at: now } });

    const newLead = data.team_lead_user_id !== undefined ? (data.team_lead_user_id as number | null) : existing.team_lead_user_id;
    if (body?.member_ids !== undefined) {
      const wanted = await this.validateMemberIds(body.member_ids);
      await this.setMembers(id, [...new Set([...wanted, ...(newLead ? [newLead] : [])])], user);
    } else if (newLead && newLead !== existing.team_lead_user_id) {
      await this.addMember(id, newLead, user);
    }

    const changes: string[] = [];
    if (data.name !== undefined && data.name !== existing.name) changes.push(`renamed from ${existing.name}`);
    if (data.is_active !== undefined && data.is_active !== existing.is_active) changes.push(data.is_active ? 'activated' : 'deactivated');
    if (data.team_lead_user_id !== undefined && data.team_lead_user_id !== existing.team_lead_user_id) changes.push('team lead changed');
    await this.audit.record(user, 'Team updated', String(data.name ?? existing.name), changes.join('; ') || 'Details saved');
    return this.one(id);
  }

  /**
   * Replace a team's membership with exactly this set. People left out are DEACTIVATED, not
   * deleted, so the team's history of who was in it survives — and each is taken off any of the
   * team's leads they were handling (see `removeMember`).
   */
  private async setMembers(teamId: number, wanted: number[], user: AuthUserRecord): Promise<void> {
    const current = await this.prisma.crm_team_members.findMany({ where: { team_id: teamId } });
    for (const uid of wanted) {
      const row = current.find((m) => m.user_id === uid);
      if (!row || !row.is_active) await this.addMember(teamId, uid, user, true);
    }
    for (const row of current) {
      if (row.is_active && !wanted.includes(row.user_id)) await this.removeMember(teamId, row.user_id, user, true);
    }
  }

  async addMember(teamId: number, userId: number, user: AuthUserRecord, quiet = false): Promise<TeamRecord | null> {
    this.assertManage(user);
    const team = await this.prisma.crm_teams.findUnique({ where: { id: teamId }, select: { id: true, name: true } });
    if (!team) throw new NotFoundException({ message: 'Team not found.' });
    const [id] = await this.validateMemberIds([userId]);
    if (!id) throwValidation({ user_id: ['Choose somebody to add.'] });
    await this.prisma.crm_team_members.upsert({
      where: { team_id_user_id: { team_id: teamId, user_id: id } },
      create: { team_id: teamId, user_id: id, is_active: true, created_at: new Date() },
      update: { is_active: true },
    });
    if (!quiet) await this.audit.record(user, 'Team member added', team.name, `User #${id}`);
    return quiet ? null : this.one(teamId);
  }

  /**
   * Take somebody out of a team. The TEAM KEEPS ITS LEADS: any of them this person was handling
   * becomes unassigned within the team — the same outcome as deactivating them — so their team lead
   * can route it to somebody still in the team. A handler outside the team would be working a lead
   * the team owns with no team rule governing them.
   */
  async removeMember(teamId: number, userId: number, user: AuthUserRecord, quiet = false): Promise<TeamRecord | null> {
    this.assertManage(user);
    const team = await this.prisma.crm_teams.findUnique({ where: { id: teamId }, select: { id: true, name: true, team_lead_user_id: true } });
    if (!team) throw new NotFoundException({ message: 'Team not found.' });
    if (team.team_lead_user_id === userId) {
      throwValidation({ user_id: ['This person is the team lead. Choose a different team lead before removing them.'] });
    }
    await this.prisma.crm_team_members.updateMany({ where: { team_id: teamId, user_id: userId }, data: { is_active: false } });

    const handled = await this.prisma.leads.findMany({
      where: { team_id: teamId, assigned_to: userId, deleted_at: null }, select: { id: true },
    });
    if (handled.length) {
      await this.prisma.leads.updateMany({
        where: { id: { in: handled.map((l) => l.id) } }, data: { assigned_to: null, updated_at: new Date() },
      });
      const person = await this.prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
      await this.history.write(handled.flatMap((l) => this.history.build(
        l.id,
        { team_id: teamId, team_name: team.name, assigned_to: userId, assigned_name: person?.name ?? null },
        { team_id: teamId, team_name: team.name, assigned_to: null },
        { id: user.id ?? null, name: user.name ?? null },
        `${person?.name ?? 'they'} left ${team.name}`,
      )));
    }
    if (!quiet) await this.audit.record(user, 'Team member removed', team.name, `User #${userId}; ${handled.length} lead(s) returned to the team unassigned`);
    return quiet ? null : this.one(teamId);
  }

  /** Delete a team that has never owned a lead. One that has is deactivated instead. */
  async remove(id: number, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    this.assertManage(user);
    const team = await this.prisma.crm_teams.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!team) throw new NotFoundException({ message: 'Team not found.' });
    const owned = await this.prisma.leads.count({ where: { team_id: id } });
    if (owned) {
      throwValidation({ team: [`${team.name} owns ${owned} lead${owned === 1 ? '' : 's'} (including any in Recently Deleted), so it cannot be deleted. Deactivate it instead, or move its leads first.`] });
    }
    await this.prisma.crm_teams.delete({ where: { id } });
    await this.audit.record(user, 'Team deleted', team.name, '');
    return { deleted: true };
  }

  /** One team in the list's shape, so the screen receives one kind of team everywhere. */
  private async one(id: number): Promise<TeamRecord> {
    const [row] = await this.load({ id });
    if (!row) throw new NotFoundException({ message: 'Team not found.' });
    return row;
  }

  // ---------------------------------------------------------------- dashboard
  /**
   * The team cards on the CRM dashboard. Every figure is a count of LEADS, answered by the same
   * predicate the Leads screen's filter uses — so a card opens a list with exactly that many rows.
   */
  async dashboard(user: AuthUserRecord): Promise<Record<string, unknown>> {
    const me = user.id ?? -1;
    const scope = liveLeadWhere(user);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const within = (extra: Prisma.leadsWhereInput): Prisma.leadsWhereInput => ({ AND: [scope, extra] });

    const [myTeams, led] = await Promise.all([
      this.prisma.crm_teams.findMany({ where: teamReaderWhere(me), select: { id: true, name: true } }),
      this.prisma.crm_teams.findMany({ where: { is_active: true, team_lead_user_id: me }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    const [mine, myTeam, unassigned, dueLeads, newToday] = await Promise.all([
      this.prisma.leads.count({ where: within({ OR: [{ owner_user_id: me }, { assigned_to: me }] }) }),
      this.prisma.leads.count({ where: within(myTeamLeadsWhere(me)) }),
      this.prisma.leads.count({ where: within({ owner_user_id: null, team_id: { not: null }, assigned_to: null }) }),
      this.prisma.leads.count({ where: within({ lead_tasks: { some: { status: 'pending', due_date: { lte: today } } } }) }),
      this.prisma.leads.count({ where: within({ created_at: { gte: today } }) }),
    ]);

    const teamLead = await Promise.all(led.map(async (t) => {
      const base: Prisma.leadsWhereInput = { deleted_at: null, team_id: t.id };
      const [total, assigned, overdue, converted] = await Promise.all([
        this.prisma.leads.count({ where: base }),
        this.prisma.leads.count({ where: { ...base, assigned_to: { not: null } } }),
        this.prisma.leads.count({ where: { ...base, lead_tasks: { some: { status: 'pending', due_date: { lt: today } } } } }),
        this.prisma.leads.count({ where: { ...base, lead_conversion: 'converted' } }),
      ]);
      return { team_id: t.id, team_name: t.name, total, assigned, unassigned: total - assigned, overdue_follow_ups: overdue, converted };
    }));

    return {
      in_team: myTeams.length > 0,
      teams: myTeams,
      cards: { my_leads: mine, my_team_leads: myTeam, unassigned_team_leads: unassigned, follow_ups_due: dueLeads, new_today: newToday },
      team_lead: teamLead,
    };
  }

  // ------------------------------------------------------------------ report
  /** Which teams this person may report on: all for an administrator, their own for a team lead. */
  private async reportableTeams(user: AuthUserRecord, teamId?: number): Promise<{ id: number; name: string; is_active: boolean; team_lead_user_id: number | null }[]> {
    const where: Prisma.crm_teamsWhereInput = this.mayManage(user)
      ? {}
      : { team_lead_user_id: user.id ?? -1, is_active: true };
    const teams = await this.prisma.crm_teams.findMany({
      where: { ...where, ...(teamId ? { id: teamId } : {}) },
      select: { id: true, name: true, is_active: true, team_lead_user_id: true },
      orderBy: { name: 'asc' },
    });
    if (!teams.length && !this.mayManage(user)) {
      throw new ForbiddenException({ message: 'Team reports are available to administrators and to team leads for their own team.' });
    }
    return teams;
  }

  /**
   * Team report: for each team, who owns what and who is handling it.
   *
   * OWNER AND HANDLER ARE REPORTED SEPARATELY. A team's totals count every lead the TEAM owns;
   * the per-agent lines count the leads each person is HANDLING inside that team. Reassigning a
   * handler moves a lead between agent lines and leaves the team's totals exactly where they were.
   */
  async report(user: AuthUserRecord, teamIdRaw?: string): Promise<{ teams: TeamReportRow[]; totals: Record<string, number> }> {
    const teamId = Number(str(teamIdRaw));
    const teams = await this.reportableTeams(user, Number.isInteger(teamId) && teamId > 0 ? teamId : undefined);
    const ids = teams.map((t) => t.id);
    const grouped = ids.length ? await this.prisma.leads.groupBy({
      by: ['team_id', 'assigned_to', 'lead_conversion'],
      where: { deleted_at: null, team_id: { in: ids } },
      _count: { _all: true },
    }) : [];

    const [members, people] = await Promise.all([
      this.prisma.crm_team_members.findMany({ where: { team_id: { in: ids }, is_active: true }, select: { team_id: true, user_id: true } }),
      this.prisma.users.findMany({
        where: { id: { in: [...new Set([...grouped.map((g) => g.assigned_to), ...teams.map((t) => t.team_lead_user_id)].filter((n): n is number => !!n))] } },
        select: { id: true, name: true },
      }),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, p.name]));

    const rows = teams.map((t): TeamReportRow => {
      const mine = grouped.filter((g) => g.team_id === t.id);
      const total = mine.reduce((n, g) => n + g._count._all, 0);
      const assigned = mine.filter((g) => g.assigned_to !== null).reduce((n, g) => n + g._count._all, 0);
      const converted = mine.filter((g) => g.lead_conversion === 'converted').reduce((n, g) => n + g._count._all, 0);
      const agentIds = [...new Set(mine.map((g) => g.assigned_to).filter((n): n is number => n !== null))];
      const memberIds = new Set(members.filter((m) => m.team_id === t.id).map((m) => m.user_id));
      if (t.team_lead_user_id) memberIds.add(t.team_lead_user_id);
      return {
        team_id: t.id,
        team_name: t.name,
        team_lead_name: t.team_lead_user_id ? nameOf.get(t.team_lead_user_id) ?? null : null,
        is_active: t.is_active,
        total,
        assigned,
        unassigned: total - assigned,
        converted,
        conversion_rate: rate(converted, total),
        agents: agentIds.map((uid) => {
          const theirs = mine.filter((g) => g.assigned_to === uid);
          const a = theirs.reduce((n, g) => n + g._count._all, 0);
          const c = theirs.filter((g) => g.lead_conversion === 'converted').reduce((n, g) => n + g._count._all, 0);
          return { user_id: uid, name: nameOf.get(uid) ?? `User #${uid}`, is_member: memberIds.has(uid), assigned: a, converted: c, conversion_rate: rate(c, a) };
        }).sort((x, y) => y.assigned - x.assigned || x.name.localeCompare(y.name)),
      };
    });

    const sum = (k: 'total' | 'assigned' | 'unassigned' | 'converted') => rows.reduce((n, r) => n + r[k], 0);
    const totals = { total: sum('total'), assigned: sum('assigned'), unassigned: sum('unassigned'), converted: sum('converted') };
    return { teams: rows, totals: { ...totals, conversion_rate: rate(totals.converted, totals.total) } };
  }

  // ---------------------------------------------------------------- activity
  /**
   * What has happened on a team's leads lately, and WHO did it — each entry names the person who
   * actually made the call, wrote the note, scheduled the follow-up or moved the lead.
   *
   * Administrators, or the team's own lead.
   */
  async activity(teamId: number, user: AuthUserRecord, limitRaw?: string): Promise<Record<string, unknown>[]> {
    const team = await this.prisma.crm_teams.findUnique({ where: { id: teamId }, select: { id: true, team_lead_user_id: true } });
    if (!team) throw new NotFoundException({ message: 'Team not found.' });
    if (!this.mayManage(user) && team.team_lead_user_id !== (user.id ?? -1)) {
      throw new ForbiddenException({ message: 'Only this team’s lead or an administrator can see its activity.' });
    }
    const limit = Math.min(200, Math.max(1, Number(limitRaw ?? 50) || 50));
    const onTeam = { leads: { is: { team_id: teamId, deleted_at: null } } };
    const lead = { select: { id: true, name: true } } as const;

    const [events, notes, calls, tasks] = await Promise.all([
      this.prisma.crm_lead_assignment_events.findMany({ where: onTeam, include: { leads: lead }, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.lead_notes.findMany({ where: onTeam, include: { leads: lead }, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.lead_calls.findMany({ where: onTeam, include: { leads: lead }, orderBy: { called_at: 'desc' }, take: limit }),
      this.prisma.lead_tasks.findMany({ where: onTeam, include: { leads: lead }, orderBy: { created_at: 'desc' }, take: limit }),
    ]);

    const items = [
      ...events.map((e) => ({ type: 'assignment', lead_id: e.lead_id, lead_name: e.leads.name, actor: e.actor_name ?? 'System', summary: e.description, at: e.created_at })),
      ...notes.map((n) => ({ type: 'note', lead_id: n.lead_id, lead_name: n.leads.name, actor: n.created_by ?? 'Unknown', summary: `added a note: ${n.content.slice(0, 140)}`, at: n.created_at })),
      ...calls.map((c) => ({ type: 'call', lead_id: c.lead_id, lead_name: c.leads.name, actor: c.created_by ?? 'Unknown', summary: `called the lead${c.outcome ? ` — ${c.outcome}` : ''}`, at: c.called_at })),
      ...tasks.map((t) => ({ type: 'task', lead_id: t.lead_id, lead_name: t.leads.name, actor: t.created_by ?? 'Unknown', summary: `scheduled a follow-up: ${t.title} (due ${t.due_date.toISOString().slice(0, 10)})`, at: t.created_at })),
    ];
    return items
      .filter((i) => i.at)
      .sort((a, b) => (b.at as Date).getTime() - (a.at as Date).getTime())
      .slice(0, limit)
      .map((i) => ({ ...i, at: (i.at as Date).toISOString() }));
  }
}
