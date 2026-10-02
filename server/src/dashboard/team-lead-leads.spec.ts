import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { TeamLeadLeadsService } from './team-lead-leads.service';
import { LeadAssignmentHistoryService } from '../leads/lead-assignment-history.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { UsersService } from '../users/users.service';
import { OffboardingService } from '../users/offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { PermissionService } from '../auth/permission.service';
import { PasswordHashService } from '../auth/password-hash.service';
import { ConfigService } from '@nestjs/config';
import { ModuleAccessService } from '../core/module-access.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { leadScopeWhere } from '../common/lead-scope';

/**
 * TEAM LEAD LEAD ASSIGNMENT — the John / Sarah / Mike / David example from the requirement, against
 * the real tables inside a rolled-back transaction.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const noAudit = { logModule: async () => {}, record: async () => {} } as never;
const noGraph = { fetchPages: async () => [] } as never;
const ADMIN = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;
const sent: unknown[] = [];
const notifier = { leadAssigned: async (...a: unknown[]) => { sent.push(a); } } as never;

const users = (tx: PrismaService) => new UsersService(
  tx, new PermissionService(), new ModuleAccessService(tx), noAudit,
  new OffboardingService(tx, new MetaConnectionService(tx, noGraph), new LeadTransferService(tx, noAudit)),
  new PasswordHashService(new ConfigService()),
);
const assigner = (tx: PrismaService) => new TeamLeadLeadsService(tx, new LeadAssignmentHistoryService(tx), new LeadAuditService(tx), notifier);

const person = (name: string, over: Record<string, unknown> = {}) => {
  const t = tag();
  return {
    name: `${name} ${t}`, username: `tll-${t}`, email: `tll-${t}@example.test`,
    password: 'quarry lantern ninety', password_confirmation: 'quarry lantern ninety',
    role: 'agent', status: 'Active', profile: { mobile: '416-555-0100', gender: 'Other' }, ...over,
  };
};
const me = async (tx: PrismaService, id: number) => (await tx.users.findUnique({ where: { id } })) as unknown as AuthUserRecord;

/** John (Team Lead) with Sarah and Mike (Active) and David (Inactive), and Lead A / Lead B owned by John. */
async function johnsTeam(tx: PrismaService) {
  const u = users(tx);
  const johnId = (await u.store(ADMIN, person('John', { is_team_lead: true })) as { id: number }).id;
  const john = await me(tx, johnId);
  const sarah = (await u.store(john, person('Sarah')) as { id: number }).id;
  const mike = (await u.store(john, person('Mike')) as { id: number }).id;
  const david = (await u.store(john, person('David')) as { id: number }).id;
  await u.update(john, david, { status: 'Inactive' });
  const leadA = (await tx.leads.create({ data: { name: `Lead A ${tag()}`, owner_user_id: johnId } })).id;
  const leadB = (await tx.leads.create({ data: { name: `Lead B ${tag()}`, owner_user_id: johnId } })).id;
  return { johnId, john, sarah, mike, david, leadA, leadB };
}

const lead = (tx: PrismaService, id: number) => tx.leads.findUnique({ where: { id }, select: { owner_user_id: true, assigned_to: true } });

describe('Team Lead assigns their own leads to their own Active Agents', () => {
  it('Lead A -> Sarah, Lead B -> Mike; John stays the owner', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      await assigner(tx).assign(t.john, t.leadA, t.sarah);
      await assigner(tx).assign(t.john, t.leadB, t.mike);
      expect(await lead(tx, t.leadA)).toEqual({ owner_user_id: t.johnId, assigned_to: t.sarah });
      expect(await lead(tx, t.leadB)).toEqual({ owner_user_id: t.johnId, assigned_to: t.mike });
    });
  });

  it('offers only Sarah and Mike — never David, other teams, Team Leads or other roles', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const page = await assigner(tx).list(t.john);
      expect(page.agents.map((a) => a.id).sort()).toEqual([t.sarah, t.mike].sort());
      expect(page.leads.map((l) => l.id).sort()).toEqual([t.leadA, t.leadB].sort());
    });
  });

  it('reassigns Lead A from Sarah to Mike, recording history', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      await assigner(tx).assign(t.john, t.leadA, t.sarah);
      await assigner(tx).assign(t.john, t.leadA, t.mike);
      expect(await lead(tx, t.leadA)).toEqual({ owner_user_id: t.johnId, assigned_to: t.mike });
      expect(await tx.crm_lead_assignment_events.count({ where: { lead_id: t.leadA } })).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('the server refuses', () => {
  it('David, because he is Inactive', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      await expect(assigner(tx).assign(t.john, t.leadA, t.david)).rejects.toThrow(/inactive/i);
      expect((await lead(tx, t.leadA))?.assigned_to).toBeNull();
    });
  });

  it("another Team Lead's Agent, another Team Lead, and an admin", async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const mary = await me(tx, (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id);
      const marysAgent = (await users(tx).store(mary, person('Priya')) as { id: number }).id;
      const manager = (await users(tx).store(ADMIN, person('Manager', { role: 'manager' })) as { id: number }).id;

      await expect(assigner(tx).assign(t.john, t.leadA, marysAgent)).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(assigner(tx).assign(t.john, t.leadA, mary.id)).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(assigner(tx).assign(t.john, t.leadA, manager)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect((await lead(tx, t.leadA))?.assigned_to).toBeNull();
    });
  });

  it("another Team Lead's lead, which reads as not found", async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const mary = await me(tx, (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id);
      await expect(assigner(tx).assign(mary, t.leadA, t.sarah)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('anyone who is not a Team Lead', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      await expect(assigner(tx).assign(await me(tx, t.sarah), t.leadA, t.mike)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(assigner(tx).list(ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('an assigned Agent who becomes Inactive', () => {
  it('keeps the lead assigned and shown as Inactive; the Team Lead reassigns by hand', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      await assigner(tx).assign(t.john, t.leadA, t.sarah);

      await users(tx).update(t.john, t.sarah, { status: 'Inactive' });
      expect(await lead(tx, t.leadA)).toEqual({ owner_user_id: t.johnId, assigned_to: t.sarah });
      const row = (await assigner(tx).list(t.john)).leads.find((l) => l.id === t.leadA);
      expect(row).toMatchObject({ assigned_to: t.sarah, assigned_status: 'Inactive' });

      await assigner(tx).assign(t.john, t.leadA, t.mike);
      expect(await lead(tx, t.leadA)).toEqual({ owner_user_id: t.johnId, assigned_to: t.mike });
    });
  });

  it('still releases brokerage leads, exactly as before', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const brokerage = (await tx.leads.create({ data: { name: `Brokerage ${tag()}`, owner_user_id: null, assigned_to: t.sarah } })).id;
      await users(tx).update(t.john, t.sarah, { status: 'Inactive' });
      expect((await lead(tx, brokerage))?.assigned_to).toBeNull();
    });
  });
});

describe('the Assign Agent control on the lead page', () => {
  it('answers John for his own lead, with Sarah and Mike only', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const r = await assigner(tx).forLead(t.john, t.leadA);
      expect(r.lead).toMatchObject({ id: t.leadA, source: 'own' });
      expect(r.agents.map((a) => a.id).sort()).toEqual([t.sarah, t.mike].sort());
    });
  });

  it('answers not found for a lead he may not assign, and refuses a non-Team Lead', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const loose = (await tx.leads.create({ data: { name: `Brokerage ${tag()}`, owner_user_id: null } })).id;
      await expect(assigner(tx).forLead(t.john, loose)).rejects.toBeInstanceOf(NotFoundException);
      await expect(assigner(tx).forLead(await me(tx, t.sarah), t.leadA)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('Flow 2 — Admin assigns Lead B to John the existing way (Assigned To = John)', () => {
  /** A brokerage lead (no owner, no team) an Admin assigned to `to`. */
  const adminGives = async (tx: PrismaService, to: number) =>
    (await tx.leads.create({ data: { name: `Lead B ${tag()}`, owner_user_id: null, assigned_to: to } })).id;
  const full = (tx: PrismaService, id: number) =>
    tx.leads.findUnique({ where: { id }, select: { owner_user_id: true, team_id: true, assigned_to: true, assigned_team_lead_id: true } });

  it('John assigns Sarah, then reassigns Sarah -> Mike; brokerage stays owner, John stays the Team Lead level', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const b = await adminGives(tx, t.johnId);

      const before = (await assigner(tx).list(t.john)).leads.find((l) => l.id === b);
      expect(before).toMatchObject({ source: 'admin', with_team_lead: true });

      await assigner(tx).assign(t.john, b, t.sarah);
      expect(await full(tx, b)).toEqual({ owner_user_id: null, team_id: null, assigned_to: t.sarah, assigned_team_lead_id: t.johnId });

      // Condition C: John already passed it to Sarah and can still reassign it.
      await assigner(tx).assign(t.john, b, t.mike);
      expect(await full(tx, b)).toEqual({ owner_user_id: null, team_id: null, assigned_to: t.mike, assigned_team_lead_id: t.johnId });
    });
  });

  it('John keeps seeing Lead B in Leads after handing it to Sarah', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const b = await adminGives(tx, t.johnId);
      await assigner(tx).assign(t.john, b, t.sarah);
      expect(await tx.leads.count({ where: { id: b, ...leadScopeWhere(t.john) } })).toBe(1);
    });
  });

  it("refuses an Admin lead not given to John, and Michael's Agents' leads", async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const michael = await me(tx, (await users(tx).store(ADMIN, person('Michael', { is_team_lead: true })) as { id: number }).id);
      const alex = (await users(tx).store(michael, person('Alex')) as { id: number }).id;
      const toMichael = await adminGives(tx, michael.id);
      const toAlex = await adminGives(tx, alex);
      const toSarahDirect = await adminGives(tx, t.sarah); // Admin went straight to the Agent, not via John

      for (const id of [toMichael, toAlex, toSarahDirect]) {
        await expect(assigner(tx).assign(t.john, id, t.mike)).rejects.toBeInstanceOf(NotFoundException);
      }
      // And John cannot hand his own Admin lead to Michael's Agent.
      const b = await adminGives(tx, t.johnId);
      await expect(assigner(tx).assign(t.john, b, alex)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('when Sarah goes Inactive, Lead B stays with her (Inactive) and with John; John reassigns to Mike', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const b = await adminGives(tx, t.johnId);
      await assigner(tx).assign(t.john, b, t.sarah);
      await users(tx).update(t.john, t.sarah, { status: 'Inactive' });

      expect(await full(tx, b)).toEqual({ owner_user_id: null, team_id: null, assigned_to: t.sarah, assigned_team_lead_id: t.johnId });
      expect((await assigner(tx).list(t.john)).leads.find((l) => l.id === b)).toMatchObject({ assigned_status: 'Inactive' });

      await assigner(tx).assign(t.john, b, t.mike);
      expect(await full(tx, b)).toMatchObject({ assigned_to: t.mike, assigned_team_lead_id: t.johnId });
    });
  });

  it('a replacement Team Lead takes over John\'s Admin leads along with his Agents', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const b = await adminGives(tx, t.johnId);
      await assigner(tx).assign(t.john, b, t.sarah);
      const mary = (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id;
      const j = (await tx.users.findUnique({ where: { id: t.johnId } }))!;
      await users(tx).update(ADMIN, t.johnId, { name: j.name, email: j.email, role: 'agent', status: 'Inactive', reassign_agents_to: mary });

      expect(await full(tx, b)).toMatchObject({ assigned_to: t.sarah, assigned_team_lead_id: mary });
      await assigner(tx).assign(await me(tx, mary), b, t.mike);
      expect((await full(tx, b))?.assigned_to).toBe(t.mike);
    });
  });
});

describe('Workflow 2 — a lead an Admin shared with the Team Lead', () => {
  /** A brokerage lead (no owner) placed in a CRM team led by `leaderId` — how an Admin shares one. */
  async function shared(tx: PrismaService, leaderId: number, over: { is_active?: boolean } = {}) {
    const team = await tx.crm_teams.create({ data: { name: `Team ${tag()}`, team_lead_user_id: leaderId, is_active: over.is_active ?? true } });
    const id = (await tx.leads.create({ data: { name: `Shared ${tag()}`, owner_user_id: null, team_id: team.id } })).id;
    return { id, teamId: team.id };
  }
  const full = (tx: PrismaService, id: number) => tx.leads.findUnique({ where: { id }, select: { owner_user_id: true, team_id: true, assigned_to: true } });

  it('John assigns Lead A to Sarah, then reassigns Sarah -> Mike; brokerage stays owner, John\'s team stays', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const a = await shared(tx, t.johnId);

      const page = await assigner(tx).list(t.john);
      expect(page.leads.find((l) => l.id === a.id)).toMatchObject({ source: 'shared' });

      await assigner(tx).assign(t.john, a.id, t.sarah);
      expect(await full(tx, a.id)).toEqual({ owner_user_id: null, team_id: a.teamId, assigned_to: t.sarah });
      await assigner(tx).assign(t.john, a.id, t.mike);
      expect(await full(tx, a.id)).toEqual({ owner_user_id: null, team_id: a.teamId, assigned_to: t.mike });
    });
  });

  it('refuses leads not shared with John: another Team Lead\'s team, no team at all, or a switched-off team', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const mary = (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id;
      const marys = await shared(tx, mary);
      const loose = (await tx.leads.create({ data: { name: `Brokerage ${tag()}`, owner_user_id: null } })).id;
      const off = await shared(tx, t.johnId, { is_active: false });

      for (const id of [marys.id, loose, off.id]) {
        await expect(assigner(tx).assign(t.john, id, t.sarah)).rejects.toBeInstanceOf(NotFoundException);
        expect((await full(tx, id))?.assigned_to).toBeNull();
      }
      const ids = (await assigner(tx).list(t.john)).leads.map((l) => l.id);
      expect(ids).not.toContain(marys.id);
      expect(ids).not.toContain(loose);
      expect(ids).not.toContain(off.id);
    });
  });

  it('applies the same agent rules: never David, never another team\'s agent', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const a = await shared(tx, t.johnId);
      await expect(assigner(tx).assign(t.john, a.id, t.david)).rejects.toThrow(/inactive/i);
      const mary = await me(tx, (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id);
      const priya = (await users(tx).store(mary, person('Priya')) as { id: number }).id;
      await expect(assigner(tx).assign(t.john, a.id, priya)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  it('when Sarah goes Inactive the shared lead stays hers, marked Inactive; other teams\' leads clear as before', async () => {
    await inRollback(async (tx) => {
      const t = await johnsTeam(tx);
      const a = await shared(tx, t.johnId);
      await assigner(tx).assign(t.john, a.id, t.sarah);
      const mary = (await users(tx).store(ADMIN, person('Mary', { is_team_lead: true })) as { id: number }).id;
      const elsewhere = await shared(tx, mary);
      await tx.leads.update({ where: { id: elsewhere.id }, data: { assigned_to: t.sarah } });

      await users(tx).update(t.john, t.sarah, { status: 'Inactive' });

      expect(await full(tx, a.id)).toEqual({ owner_user_id: null, team_id: a.teamId, assigned_to: t.sarah });
      expect((await assigner(tx).list(t.john)).leads.find((l) => l.id === a.id)).toMatchObject({ assigned_status: 'Inactive' });
      expect((await full(tx, elsewhere.id))?.assigned_to).toBeNull();
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
