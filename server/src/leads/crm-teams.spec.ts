import { PrismaClient } from '@prisma/client';
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { liveLeadWhere } from '../common/lead-scope';
import { ResourceAccessService } from '../core/resource-access.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { LeadAssignmentHistoryService } from './lead-assignment-history.service';
import { LeadTeamAssignmentService } from './lead-team-assignment.service';
import { LeadTransferService } from './lead-transfer.service';
import { CrmTeamsService } from './crm-teams.service';

/**
 * TEAM-LEVEL LEAD OWNERSHIP, end to end against the real schema.
 *
 * ================================================================================================
 *   team_id       the TEAM owns the lead            — changed only by an administrator
 *   assigned_to   the agent HANDLING it (nullable)  — changed by an administrator or the team lead
 * ================================================================================================
 *
 * One seeded world per test, inside a transaction that is always rolled back:
 *
 *   Pre-Con East   lead: Tina    members: Sarah, Mike
 *   Resale West    lead: Wendy   members: Rob
 *   plus Olga (agent in no team), a manager (Admin), and a Super Admin
 *
 *   3 leads owned by Pre-Con East  (one handled by Sarah, one by Mike, one unassigned)
 *   1 lead owned by Resale West    (unassigned)
 *   1 brokerage lead               (unassigned)
 *   1 private lead each for Sarah and Olga
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const as = (u: { id: number; name: string; role: string | null }): AuthUserRecord =>
  ({ id: u.id, name: u.name, role: u.role ?? 'agent', user_permissions: [] } as unknown as AuthUserRecord);

/** Silent audit, so a spec does not depend on the audit table's shape. */
const auditOf = (tx: PrismaService) => new LeadAuditService(tx);

function services(tx: PrismaService) {
  const audit = auditOf(tx);
  const history = new LeadAssignmentHistoryService(tx);
  const assign = new LeadTeamAssignmentService(tx, audit, history);
  const leads = new LeadsService(tx, audit, new LeadNotificationService(tx, null as never), undefined, assign, history);
  const teams = new CrmTeamsService(tx, audit, history);
  const transfer = new LeadTransferService(tx, audit, history);
  return { audit, history, assign, leads, teams, transfer };
}

async function world(tx: PrismaService) {
  const now = new Date();
  const tag = `teams-${Date.now()}-${++seq}`;
  const mk = async (role: string, label: string) => tx.users.create({
    data: { name: `${label} ${tag}`, email: `${label}-${tag}@x.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
  });
  const tina = await mk('agent', 'tina');
  const sarah = await mk('agent', 'sarah');
  const mike = await mk('agent', 'mike');
  const wendy = await mk('agent', 'wendy');
  const rob = await mk('agent', 'rob');
  const olga = await mk('agent', 'olga');
  const manager = await mk('manager', 'manager');
  const superAdmin = await mk('admin', 'super');

  const { teams } = services(tx);
  const east = await teams.create({ name: `Pre-Con East ${tag}`, team_lead_user_id: tina.id, member_ids: [sarah.id, mike.id] }, as(manager));
  const west = await teams.create({ name: `Resale West ${tag}`, team_lead_user_id: wendy.id, member_ids: [rob.id] }, as(manager));

  const lead = async (label: string, data: { owner?: number | null; team?: number | null; assigned?: number | null }) => tx.leads.create({
    data: {
      name: `${label} ${tag}`, email: `${label}-${tag}@x.test`, phone: '4165550100',
      owner_user_id: data.owner ?? null, team_id: data.team ?? null, assigned_to: data.assigned ?? null,
      lead_status: 'warm', tags: '[]', unsubscribed: false, created_at: now, updated_at: now,
    },
  });
  const eastSarah = await lead('east-sarah', { team: east.id, assigned: sarah.id });
  const eastMike = await lead('east-mike', { team: east.id, assigned: mike.id });
  const eastFree = await lead('east-free', { team: east.id });
  const westFree = await lead('west-free', { team: west.id });
  const brokerage = await lead('brokerage', {});
  const sarahPrivate = await lead('sarah-private', { owner: sarah.id, assigned: sarah.id });
  const olgaPrivate = await lead('olga-private', { owner: olga.id, assigned: olga.id });

  return {
    tag, tina, sarah, mike, wendy, rob, olga, manager, superAdmin, east, west,
    eastSarah, eastMike, eastFree, westFree, brokerage, sarahPrivate, olgaPrivate,
  };
}

/** The ids this person can see among this run's leads. */
async function visibleIds(tx: PrismaService, user: AuthUserRecord, tag: string): Promise<number[]> {
  const rows = await tx.leads.findMany({ where: { AND: [liveLeadWhere(user), { email: { contains: tag } }] }, select: { id: true } });
  return rows.map((r) => r.id).sort((a, b) => a - b);
}
const ids = (...rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

// =================================================================================== teams module
describe('creating and editing teams', () => {
  it('an administrator creates a team; the team lead is made a member automatically', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      expect(w.east.name).toContain('Pre-Con East');
      expect(w.east.team_lead_user_id).toBe(w.tina.id);
      expect(w.east.is_active).toBe(true);
      expect(w.east.members.map((m) => m.user_id).sort()).toEqual([w.tina.id, w.sarah.id, w.mike.id].sort());
      expect(w.east.lead_count).toBe(0); // counted when created, before the leads were seeded
    });
  });

  it('edits name, description and status, and refuses a duplicate name case-insensitively', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      const edited = await teams.update(w.east.id, { name: `Pre-Con East North ${w.tag}`, description: 'Condos east of Yonge', is_active: false }, as(w.manager));
      expect(edited.name).toBe(`Pre-Con East North ${w.tag}`);
      expect(edited.description).toBe('Condos east of Yonge');
      expect(edited.is_active).toBe(false);
      await expect(teams.update(w.west.id, { name: `pre-con east north ${w.tag}`.toUpperCase() }, as(w.manager)))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(teams.create({ name: '' }, as(w.manager))).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('only an administrator may manage teams', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      await expect(teams.create({ name: `Rogue ${w.tag}` }, as(w.tina))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(teams.update(w.east.id, { name: 'x' }, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(teams.list(as(w.tina))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('a team that owns leads cannot be deleted — it is deactivated instead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      await expect(teams.remove(w.east.id, as(w.manager))).rejects.toBeInstanceOf(UnprocessableEntityException);
      const empty = await teams.create({ name: `Empty ${w.tag}` }, as(w.manager));
      expect(await teams.remove(empty.id, as(w.manager))).toEqual({ deleted: true });
    });
  });
});

describe('adding and removing team members', () => {
  it('adds a member, and removing one keeps the row but deactivates it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      const added = await teams.addMember(w.east.id, w.olga.id, as(w.manager));
      expect(added!.members.find((m) => m.user_id === w.olga.id)?.is_active).toBe(true);
      const removed = await teams.removeMember(w.east.id, w.olga.id, as(w.manager));
      expect(removed!.members.find((m) => m.user_id === w.olga.id)?.is_active).toBe(false);
    });
  });

  it('removing a member returns the team leads they handled to the team, unassigned, with history', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams, history } = services(tx);
      await teams.removeMember(w.east.id, w.sarah.id, as(w.manager));
      const row = await tx.leads.findUniqueOrThrow({ where: { id: w.eastSarah.id } });
      expect(row.team_id).toBe(w.east.id);
      expect(row.assigned_to).toBeNull();
      const [event] = await history.list(w.eastSarah.id);
      expect(event.action).toBe('agent_unassigned');
      // And Sarah no longer sees the team's leads.
      expect(await visibleIds(tx, as(w.sarah), w.tag)).toEqual(ids(w.sarahPrivate));
    });
  });

  it('the team lead cannot be removed while they lead the team, and inactive users cannot join', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      await expect(teams.removeMember(w.east.id, w.tina.id, as(w.manager))).rejects.toBeInstanceOf(UnprocessableEntityException);
      await tx.users.update({ where: { id: w.olga.id }, data: { status: 'Inactive' } });
      await expect(teams.addMember(w.east.id, w.olga.id, as(w.manager))).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});

// ================================================================================== assignment
describe('assigning a lead to a team, and a team lead to an agent', () => {
  it('an administrator puts a brokerage lead in a team and chooses its handler', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      const r = await assign.assign(w.brokerage.id, { team_id: w.east.id, assigned_to: w.sarah.id }, as(w.manager));
      expect(r).toMatchObject({ team_id: w.east.id, assigned_to_user_id: w.sarah.id, ownership_type: 'TEAM' });
      const row = await tx.leads.findUniqueOrThrow({ where: { id: w.brokerage.id } });
      expect(row.owner_user_id).toBeNull();
      expect(row.ownership_type).toBe('TEAM'); // generated by the database
    });
  });

  it('a team lead can be left Unassigned — the team still owns it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      const r = await assign.assign(w.brokerage.id, { team_id: w.east.id, assigned_to: null }, as(w.manager));
      expect(r).toMatchObject({ team_id: w.east.id, assigned_to: null, ownership_type: 'TEAM' });
    });
  });

  it('the handler must be an active member of the team', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      await expect(assign.assign(w.eastFree.id, { assigned_to: w.rob.id }, as(w.manager)))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
      await tx.users.update({ where: { id: w.mike.id }, data: { status: 'Inactive' } });
      await expect(assign.assign(w.eastFree.id, { assigned_to: w.mike.id }, as(w.manager)))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('a private lead can never be given to a team — private rules are unchanged', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      // Sarah can see her own lead, but not route it into a team.
      await expect(assign.assign(w.sarahPrivate.id, { team_id: w.east.id }, as(w.sarah))).rejects.toThrow();
      // The database refuses it too.
      await expect(tx.$executeRawUnsafe(`UPDATE leads SET team_id = ${w.east.id} WHERE id = ${w.sarahPrivate.id}`)).rejects.toThrow();
    });
  });

  it('moving a lead to a new team keeps the handler only if they are a member there', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      const r = await assign.assign(w.eastSarah.id, { team_id: w.west.id }, as(w.manager));
      expect(r).toMatchObject({ team_id: w.west.id, assigned_to: null });
    });
  });

  it('creating a lead straight into a team through the lead form', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      const created = await leads.create({ name: `new ${w.tag}`, phone: '4165550199', email: `new-${w.tag}@x.test`, team_id: w.east.id, assigned_to: w.mike.id }, as(w.manager));
      expect(created).toMatchObject({ team_id: w.east.id, team_name: w.east.name, assigned_to_user_id: w.mike.id, ownership_type: 'TEAM' });
      // An agent's new lead is their PRIVATE lead (the unchanged intake rule), so it cannot be a team's.
      await expect(leads.create({ name: `new2 ${w.tag}`, phone: '4165550198', team_id: w.east.id }, as(w.tina)))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});

// ================================================================================== visibility
describe('who sees which leads', () => {
  it('a team member sees their private leads, their assigned leads and their team’s leads — including unassigned ones', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      expect(await visibleIds(tx, as(w.sarah), w.tag)).toEqual(ids(w.eastSarah, w.eastMike, w.eastFree, w.sarahPrivate));
    });
  });

  it('private-lead isolation: nobody sees another agent’s private lead, including their own team lead and managers', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (const u of [w.tina, w.mike, w.manager, w.superAdmin, w.olga]) {
        expect(await visibleIds(tx, as(u), w.tag)).not.toContain(w.sarahPrivate.id);
      }
      for (const u of [w.tina, w.sarah, w.manager, w.superAdmin]) {
        expect(await visibleIds(tx, as(u), w.tag)).not.toContain(w.olgaPrivate.id);
      }
    });
  });

  it('cross-team restriction: an agent never sees another team’s leads, and cannot open or act on them', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      expect(await visibleIds(tx, as(w.rob), w.tag)).toEqual(ids(w.westFree));
      await expect(leads.get(w.eastFree.id, as(w.rob))).rejects.toBeInstanceOf(NotFoundException);
      await expect(new ResourceAccessService(tx).assertLead(as(w.rob), w.eastFree.id)).rejects.toBeInstanceOf(NotFoundException);
      // But a member of the team passes the activity guard (notes, calls, tasks).
      await expect(new ResourceAccessService(tx).assertLead(as(w.mike), w.eastFree.id)).resolves.toBeUndefined();
    });
  });

  it('an agent in no team sees only their own leads; an administrator keeps seeing team and brokerage leads', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      expect(await visibleIds(tx, as(w.olga), w.tag)).toEqual(ids(w.olgaPrivate));
      expect(await visibleIds(tx, as(w.manager), w.tag)).toEqual(ids(w.eastSarah, w.eastMike, w.eastFree, w.westFree, w.brokerage));
    });
  });

  it('a deactivated TEAM stops granting visibility through membership', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await services(tx).teams.update(w.east.id, { is_active: false }, as(w.manager));
      // Sarah keeps the lead she is handling, and her own private one.
      expect(await visibleIds(tx, as(w.sarah), w.tag)).toEqual(ids(w.eastSarah, w.sarahPrivate));
    });
  });
});

// ================================================================================ team lead
describe('what a team lead may do', () => {
  it('assigns, reassigns and removes the handler — and the team stays the owner throughout', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      const lead = as(w.tina);
      expect(await assign.assign(w.eastFree.id, { assigned_to: w.sarah.id }, lead)).toMatchObject({ team_id: w.east.id, assigned_to: w.sarah.id });
      expect(await assign.assign(w.eastFree.id, { assigned_to: w.mike.id }, lead)).toMatchObject({ team_id: w.east.id, assigned_to: w.mike.id });
      expect(await assign.assign(w.eastFree.id, { assigned_to: null }, lead)).toMatchObject({ team_id: w.east.id, assigned_to: null });
    });
  });

  it('cannot move a lead to another team, or route another team’s leads', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign } = services(tx);
      await expect(assign.assign(w.eastFree.id, { team_id: w.west.id }, as(w.tina))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(assign.assign(w.westFree.id, { assigned_to: w.rob.id }, as(w.tina))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('regular agents cannot reassign or move team leads, by either route', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign, leads } = services(tx);
      await expect(assign.assign(w.eastFree.id, { assigned_to: w.sarah.id }, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(assign.assign(w.eastFree.id, { team_id: w.west.id }, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(leads.update(w.eastFree.id, { assigned_to: w.sarah.id }, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(leads.update(w.eastFree.id, { team_id: w.west.id }, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      // They can still work the lead: an ordinary field edit goes through.
      const edited = await leads.update(w.eastFree.id, { lead_status: 'hot' }, as(w.sarah));
      expect(edited).toMatchObject({ lead_status: 'hot', team_id: w.east.id });
    });
  });

  it('the lead detail tells each person what they may change', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      expect((await leads.get(w.eastFree.id, as(w.tina))).assignment_permissions).toEqual({ change_team: false, change_agent: true });
      expect((await leads.get(w.eastFree.id, as(w.sarah))).assignment_permissions).toEqual({ change_team: false, change_agent: false });
      expect((await leads.get(w.eastFree.id, as(w.manager))).assignment_permissions).toEqual({ change_team: true, change_agent: true });
    });
  });

  it('views team activity and team performance for their own team only', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      await tx.lead_notes.create({ data: { lead_id: w.eastFree.id, content: 'Called about the launch', created_by: w.mike.name, user_id: w.mike.id, created_at: new Date() } });
      const feed = await teams.activity(w.east.id, as(w.tina));
      expect(feed[0]).toMatchObject({ type: 'note', actor: w.mike.name, lead_id: w.eastFree.id });
      await expect(teams.activity(w.west.id, as(w.tina))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(teams.activity(w.east.id, as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
      const report = await teams.report(as(w.tina));
      expect(report.teams.map((t) => t.team_id)).toEqual([w.east.id]);
      await expect(teams.report(as(w.sarah))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// ================================================================================ deactivation
describe('when a handling agent is deactivated', () => {
  it('their team leads keep the team and become unassigned; private leads are untouched', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { transfer, history } = services(tx);
      await tx.users.update({ where: { id: w.sarah.id }, data: { status: 'Inactive' } });
      await transfer.returnToBrokerage(w.sarah.id);

      const team = await tx.leads.findUniqueOrThrow({ where: { id: w.eastSarah.id } });
      expect(team).toMatchObject({ team_id: w.east.id, assigned_to: null, owner_user_id: null, ownership_type: 'TEAM' });
      const priv = await tx.leads.findUniqueOrThrow({ where: { id: w.sarahPrivate.id } });
      expect(priv.owner_user_id).toBe(w.sarah.id);
      expect(priv.ownership_type).toBe('PRIVATE');

      // Still available to the team, in its Unassigned list.
      expect(await visibleIds(tx, as(w.mike), w.tag)).toContain(w.eastSarah.id);
      const [event] = await history.list(w.eastSarah.id);
      expect(event).toMatchObject({ action: 'agent_unassigned', actor_name: null });
      expect(event.description).toContain('deactivated');
    });
  });

  it('Lead Books never hands out a team’s unassigned lead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const preview = await services(tx).transfer.preview(as(w.superAdmin));
      const moving = preview.moving.map((m) => m.id);
      expect(moving).toContain(w.brokerage.id);
      expect(moving).not.toContain(w.eastFree.id);
      expect(moving).not.toContain(w.westFree.id);
    });
  });
});

// ================================================================================== filters
describe('lead list filters', () => {
  const listIds = async (svc: LeadsService, user: AuthUserRecord, tag: string, q: Record<string, string>) => {
    const res = await svc.list(user, { ...q, search: tag, limit: '100' });
    return (res.data as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
  };

  it('My Leads, My Team Leads, Unassigned Team Leads, Brokerage and All — each inside the caller’s scope', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      const sarah = as(w.sarah);
      expect(await listIds(leads, sarah, w.tag, { view: 'mine' })).toEqual(ids(w.eastSarah, w.sarahPrivate));
      expect(await listIds(leads, sarah, w.tag, { view: 'my_team' })).toEqual(ids(w.eastSarah, w.eastMike, w.eastFree));
      expect(await listIds(leads, sarah, w.tag, { view: 'team_unassigned' })).toEqual(ids(w.eastFree));
      // A view never widens: Sarah asking for brokerage leads gets none she cannot already see.
      expect(await listIds(leads, sarah, w.tag, { view: 'brokerage' })).toEqual([]);
      expect(await listIds(leads, sarah, w.tag, { view: 'all' })).toEqual(ids(w.eastSarah, w.eastMike, w.eastFree, w.sarahPrivate));

      const mgr = as(w.manager);
      expect(await listIds(leads, mgr, w.tag, { view: 'team_unassigned' })).toEqual(ids(w.eastFree, w.westFree));
      expect(await listIds(leads, mgr, w.tag, { view: 'brokerage' })).toEqual(ids(w.brokerage));
    });
  });

  it('Team and Assigned Agent filters', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      expect(await listIds(leads, as(w.manager), w.tag, { teamId: String(w.west.id) })).toEqual(ids(w.westFree));
      expect(await listIds(leads, as(w.manager), w.tag, { teamId: String(w.east.id), assignedTo: String(w.mike.id) })).toEqual(ids(w.eastMike));
      expect(await listIds(leads, as(w.manager), w.tag, { teamId: String(w.east.id), assignedTo: 'unassigned' })).toEqual(ids(w.eastFree));
      expect(await listIds(leads, as(w.manager), w.tag, { teamId: String(w.east.id), assignedTo: 'assigned' })).toEqual(ids(w.eastSarah, w.eastMike));
      // An agent filtering on another team gets nothing, not that team's leads.
      expect(await listIds(leads, as(w.sarah), w.tag, { teamId: String(w.west.id) })).toEqual([]);
    });
  });

  it('rows carry the owner and the handler separately', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { leads } = services(tx);
      const res = await leads.list(as(w.tina), { search: `east-sarah ${w.tag}` });
      expect((res.data as Record<string, unknown>[])[0]).toMatchObject({
        team_id: w.east.id, team_name: w.east.name, ownership_type: 'TEAM',
        assigned_to_user_id: w.sarah.id, assigned_to_name: w.sarah.name,
      });
    });
  });
});

// ================================================================================ dashboard
describe('dashboard cards', () => {
  it('each card counts exactly what its filtered list shows', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams, leads } = services(tx);
      await tx.lead_tasks.create({ data: { lead_id: w.eastFree.id, title: 'Follow up', due_date: new Date('2020-01-01T00:00:00Z'), status: 'pending', created_at: new Date() } });

      const dash = await teams.dashboard(as(w.tina));
      const count = async (q: Record<string, string>) => (await leads.list(as(w.tina), { ...q, limit: '100' })).meta as { total: number };
      // The card counts every lead in scope; compare within this run's rows by using the same filters.
      expect(dash.in_team).toBe(true);
      const cards = dash.cards as Record<string, number>;
      expect(cards.my_team_leads).toBe((await count({ view: 'my_team' })).total);
      expect(cards.unassigned_team_leads).toBe((await count({ view: 'team_unassigned' })).total);
      expect(cards.follow_ups_due).toBe((await count({ followUps: 'due' })).total);
      expect(cards.new_today).toBe((await count({ newToday: 'true' })).total);

      const east = (dash.team_lead as Record<string, number>[]).find((t) => t.team_id === w.east.id)!;
      expect(east).toMatchObject({ total: 3, assigned: 2, unassigned: 1, overdue_follow_ups: 1, converted: 0 });
    });
  });

  it('an agent in no team gets no team cards', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const dash = await services(tx).teams.dashboard(as(w.olga));
      expect(dash.in_team).toBe(false);
      expect(dash.team_lead).toEqual([]);
    });
  });
});

// ================================================================================== reporting
describe('team reporting', () => {
  it('reports owner and handler separately, with conversion by team and by agent', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams } = services(tx);
      await tx.leads.update({ where: { id: w.eastSarah.id }, data: { lead_conversion: 'converted' } });
      const { teams: rows } = await teams.report(as(w.manager), String(w.east.id));
      expect(rows).toHaveLength(1);
      const east = rows[0];
      expect(east).toMatchObject({ team_name: w.east.name, team_lead_name: w.tina.name, total: 3, assigned: 2, unassigned: 1, converted: 1, conversion_rate: 33.3 });
      expect(east.agents.find((a) => a.user_id === w.sarah.id)).toMatchObject({ assigned: 1, converted: 1, conversion_rate: 100 });
      expect(east.agents.find((a) => a.user_id === w.mike.id)).toMatchObject({ assigned: 1, converted: 0, conversion_rate: 0 });
    });
  });

  it('reassigning the handler moves the agent line and leaves the team owner and totals untouched', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { teams, assign } = services(tx);
      await assign.assign(w.eastSarah.id, { assigned_to: w.mike.id }, as(w.tina));
      const [east] = (await teams.report(as(w.manager), String(w.east.id))).teams;
      expect(east).toMatchObject({ total: 3, assigned: 2, unassigned: 1 });
      expect(east.agents.find((a) => a.user_id === w.mike.id)?.assigned).toBe(2);
      expect(east.agents.find((a) => a.user_id === w.sarah.id)).toBeUndefined();
    });
  });
});

// ============================================================================ activity history
describe('activity history records the person who acted', () => {
  it('records team assignment, handler assignment, reassignment and removal, each with the actor', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign, leads } = services(tx);
      await assign.assign(w.brokerage.id, { team_id: w.east.id }, as(w.manager));
      await assign.assign(w.brokerage.id, { assigned_to: w.sarah.id }, as(w.tina));
      await assign.assign(w.brokerage.id, { assigned_to: w.mike.id }, as(w.tina));
      await assign.assign(w.brokerage.id, { assigned_to: null }, as(w.tina));

      const detail = await leads.get(w.brokerage.id, as(w.manager));
      const events = (detail.assignment_history as { action: string; description: string; actor_name: string }[]).slice().reverse();
      expect(events.map((e) => e.action)).toEqual(['team_assigned', 'agent_assigned', 'agent_reassigned', 'agent_unassigned']);
      expect(events[0]).toMatchObject({ actor_name: w.manager.name });
      expect(events[0].description).toBe(`Lead assigned to ${w.east.name}`);
      expect(events[1].description).toBe(`${w.sarah.name} assigned as handling agent`);
      expect(events[2].description).toBe(`Lead reassigned from ${w.sarah.name} to ${w.mike.name}`);
      expect(events[3].description).toContain('Agent assignment removed');
      expect(events.slice(1).every((e) => e.actor_name === w.tina.name)).toBe(true);
    });
  });

  it('a no-op assignment writes nothing', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { assign, history } = services(tx);
      const r = await assign.assign(w.eastSarah.id, { assigned_to: w.sarah.id }, as(w.tina));
      expect(r.changed).toBe(false);
      expect(await history.list(w.eastSarah.id)).toEqual([]);
    });
  });
});
