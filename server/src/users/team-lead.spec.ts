import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { OffboardingService } from './offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { PermissionService } from '../auth/permission.service';
import { PasswordHashService } from '../auth/password-hash.service';
import { ConfigService } from '@nestjs/config';
import { ModuleAccessService } from '../core/module-access.service';
import { TeamStructureService } from '../dashboard/team-structure.service';
import { UsersAccessGuard, teamLeadIdOf } from './team-lead';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * TEAM LEAD — Users and Dashboard only.
 *
 * The acceptance scenarios from "GHR Team Lead CRM Dashboard Users Only", section 12, against the
 * real tables inside a transaction that is rolled back. A Team Lead is `role: 'agent'` with
 * `is_team_lead`, so the last block also pins that nothing outside Users can see them as anything
 * but an Agent.
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

const svc = (tx: PrismaService) => new UsersService(
  tx,
  new PermissionService(),
  new ModuleAccessService(tx),
  noAudit,
  new OffboardingService(tx, new MetaConnectionService(tx, noGraph), new LeadTransferService(tx, noAudit)),
  new PasswordHashService(new ConfigService()),
);

const body = (over: Record<string, unknown> = {}) => {
  const t = tag();
  return {
    name: `TL Probe ${t}`, username: `tl-probe-${t}`, email: `tl-probe-${t}@example.test`,
    password: 'quarry lantern ninety', password_confirmation: 'quarry lantern ninety',
    role: 'agent', status: 'Active',
    profile: { mobile: '416-555-0100', gender: 'Other' },
    ...over,
  };
};

/** The signed-in record a Team Lead would carry, read back from the row. */
const asActor = async (tx: PrismaService, id: number): Promise<AuthUserRecord> =>
  (await tx.users.findUnique({ where: { id } })) as unknown as AuthUserRecord;

const row = (tx: PrismaService, id: number) => tx.users.findUnique({ where: { id } });

/** A Team Lead, created by the Super Admin, and their signed-in record. */
async function makeTeamLead(tx: PrismaService) {
  const s = svc(tx);
  const tl = await s.store(ADMIN, body({ is_team_lead: true })) as { id: number };
  return { id: tl.id, actor: await asActor(tx, tl.id) };
}

describe('Admin creates a Team Lead', () => {
  it('stores an Agent with the Team Lead flag, reporting to nobody', async () => {
    await inRollback(async (tx) => {
      const { id } = await makeTeamLead(tx);
      const r = await row(tx, id);
      expect(r).toMatchObject({ role: 'agent', is_team_lead: true, team_lead_id: null, created_by_id: ADMIN.id });
    });
  });

  it('does not make a non-Agent a Team Lead', async () => {
    await inRollback(async (tx) => {
      const m = await svc(tx).store(ADMIN, body({ role: 'manager', is_team_lead: true })) as { id: number };
      expect((await row(tx, m.id))?.is_team_lead).toBe(false);
    });
  });
});

describe('Team Lead creates an Agent', () => {
  it('is always an Agent on their own team, whatever the request asked for', async () => {
    await inRollback(async (tx) => {
      const { id: tlId, actor } = await makeTeamLead(tx);
      const other = await makeTeamLead(tx);
      const created = await svc(tx).store(actor, body({
        role: 'admin', is_team_lead: true, team_lead_id: other.id,
        permissions: { users: 'edit', settings: 'edit' }, modules: ['crm', 'desk'],
      })) as { id: number };

      const r = await row(tx, created.id);
      expect(r).toMatchObject({ role: 'agent', is_team_lead: false, team_lead_id: tlId, created_by_id: tlId, status: 'Active' });
      expect(await tx.user_permissions.count({ where: { user_id: created.id } })).toBe(0);
    });
  });
});

describe('Team Lead opens Users', () => {
  it('lists their own Agents only', async () => {
    await inRollback(async (tx) => {
      const a = await makeTeamLead(tx);
      const b = await makeTeamLead(tx);
      const mine = await svc(tx).store(a.actor, body()) as { id: number };
      const theirs = await svc(tx).store(b.actor, body()) as { id: number };

      const ids = (await svc(tx).index({}, a.actor)).map((u) => u.id);
      expect(ids).toEqual([mine.id]);
      expect(ids).not.toContain(theirs.id);
      expect(ids).not.toContain(a.id);
    });
  });

  it("answers another team's Agent as not found, to view or to edit", async () => {
    await inRollback(async (tx) => {
      const a = await makeTeamLead(tx);
      const b = await makeTeamLead(tx);
      const theirs = await svc(tx).store(b.actor, body()) as { id: number };
      await expect(svc(tx).show(theirs.id, a.actor)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc(tx).update(a.actor, theirs.id, { status: 'Inactive' })).rejects.toBeInstanceOf(NotFoundException);
      expect((await row(tx, theirs.id))?.status).toBe('Active');
    });
  });

  it('is never sent the commission split', async () => {
    await inRollback(async (tx) => {
      const { actor } = await makeTeamLead(tx);
      const agent = await svc(tx).store(actor, body()) as { id: number };
      await tx.users.update({ where: { id: agent.id }, data: { profile: JSON.stringify({ mobile: '1', gender: 'Other', agent_comm_pct: 90, loan_amount: 5000 }) } });
      const shown = await svc(tx).show(agent.id, actor) as { profile: Record<string, unknown> };
      expect(shown.profile).toEqual({ mobile: '1', gender: 'Other' });
    });
  });
});

describe('Team Lead switches an Agent between Active and Inactive', () => {
  it('Active -> Inactive keeps the account; Inactive -> Active brings it back on the same team', async () => {
    await inRollback(async (tx) => {
      const { id: tlId, actor } = await makeTeamLead(tx);
      const agent = await svc(tx).store(actor, body()) as { id: number };

      await svc(tx).update(actor, agent.id, { status: 'Inactive' });
      expect(await row(tx, agent.id)).toMatchObject({ status: 'Inactive', team_lead_id: tlId });

      await svc(tx).update(actor, agent.id, { status: 'Active' });
      expect(await row(tx, agent.id)).toMatchObject({ status: 'Active', team_lead_id: tlId });
    });
  });

  it('cannot change role, permissions, password or team, and keeps the pay fields it never saw', async () => {
    await inRollback(async (tx) => {
      const { id: tlId, actor } = await makeTeamLead(tx);
      const other = await makeTeamLead(tx);
      const agent = await svc(tx).store(actor, body()) as { id: number };
      await tx.users.update({ where: { id: agent.id }, data: { profile: JSON.stringify({ mobile: '1', gender: 'Other', agent_comm_pct: 90 }) } });
      await tx.user_permissions.create({ data: { user_id: agent.id, screen: 'reports', level: 'none' } });
      const before = (await row(tx, agent.id))!.password;

      await svc(tx).update(actor, agent.id, {
        role: 'admin', is_team_lead: true, team_lead_id: other.id, reassign_agents_to: other.id,
        permissions: { users: 'edit' }, modules: [],
        password: 'another quarry lantern', password_confirmation: 'another quarry lantern',
        designation: 'Senior', profile: { mobile: '2' },
      });

      const r = await row(tx, agent.id);
      expect(r).toMatchObject({ role: 'agent', is_team_lead: false, team_lead_id: tlId, designation: 'Senior' });
      expect(r!.password).toBe(before);
      expect(JSON.parse(r!.profile!)).toMatchObject({ mobile: '2', gender: 'Other', agent_comm_pct: 90 });
      // The Super Admin's override survives a Team Lead's save.
      expect(await tx.user_permissions.count({ where: { user_id: agent.id } })).toBe(1);
    });
  });
});

describe('Admin changes the reporting line', () => {
  it("moves an Agent to another Team Lead, keeping the account", async () => {
    await inRollback(async (tx) => {
      const a = await makeTeamLead(tx);
      const b = await makeTeamLead(tx);
      const agent = await svc(tx).store(a.actor, body()) as { id: number };
      await svc(tx).update(ADMIN, agent.id, { ...body(), name: (await row(tx, agent.id))!.name, team_lead_id: b.id, password: undefined, password_confirmation: undefined });
      expect((await row(tx, agent.id))?.team_lead_id).toBe(b.id);
    });
  });

  it('refuses a Team Lead who is not one, or is inactive', async () => {
    await inRollback(async (tx) => {
      const plain = await svc(tx).store(ADMIN, body()) as { id: number };
      await expect(svc(tx).store(ADMIN, body({ team_lead_id: plain.id }))).rejects.toThrow();
      const tl = await makeTeamLead(tx);
      await tx.users.update({ where: { id: tl.id }, data: { status: 'Inactive' } });
      await expect(svc(tx).store(ADMIN, body({ team_lead_id: tl.id }))).rejects.toThrow();
    });
  });

  it('hands a leaving Team Lead\'s Agents to a replacement, or to nobody when they step down', async () => {
    await inRollback(async (tx) => {
      const a = await makeTeamLead(tx);
      const b = await makeTeamLead(tx);
      const one = await svc(tx).store(a.actor, body()) as { id: number };
      const two = await svc(tx).store(a.actor, body()) as { id: number };
      const aRow = (await row(tx, a.id))!;
      const same = { name: aRow.name, email: aRow.email, role: 'agent' };

      await svc(tx).update(ADMIN, a.id, { ...same, status: 'Inactive', reassign_agents_to: b.id });
      expect((await row(tx, one.id))?.team_lead_id).toBe(b.id);
      expect((await row(tx, two.id))?.team_lead_id).toBe(b.id);
      // The accounts were moved, not recreated.
      expect((await row(tx, one.id))?.created_by_id).toBe(a.id);

      const bRow = (await row(tx, b.id))!;
      await svc(tx).update(ADMIN, b.id, { name: bRow.name, email: bRow.email, role: 'agent', is_team_lead: false, reassign_agents_to: null });
      expect((await row(tx, one.id))?.team_lead_id).toBeNull();
    });
  });
});

describe('Admin must assign a replacement Team Lead', () => {
  /** The field names a validation failure named. */
  const errorsFrom = async (fn: () => Promise<unknown>): Promise<Record<string, string[]>> => {
    try { await fn(); return {}; } catch (e) {
      return ((e as { getResponse?: () => { errors?: Record<string, string[]> } }).getResponse?.()?.errors) ?? {};
    }
  };

  it('refuses to deactivate John while his agents have nowhere to go', async () => {
    await inRollback(async (tx) => {
      const john = await makeTeamLead(tx);
      await makeTeamLead(tx); // another active Team Lead exists
      const agent = await svc(tx).store(john.actor, body()) as { id: number };
      const j = (await row(tx, john.id))!;
      const same = { name: j.name, email: j.email, role: 'agent' };

      // Neither saying nothing nor "no Team Lead" is accepted while a replacement could be chosen.
      expect(await errorsFrom(() => svc(tx).update(ADMIN, john.id, { ...same, status: 'Inactive' }))).toHaveProperty('reassign_agents_to');
      expect(await errorsFrom(() => svc(tx).update(ADMIN, john.id, { ...same, status: 'Inactive', reassign_agents_to: null }))).toHaveProperty('reassign_agents_to');
      expect(await errorsFrom(() => svc(tx).update(ADMIN, john.id, { ...same, is_team_lead: false }))).toHaveProperty('reassign_agents_to');

      expect(await row(tx, john.id)).toMatchObject({ status: 'Active', is_team_lead: true });
      expect((await row(tx, agent.id))?.team_lead_id).toBe(john.id);
    });
  });

  it('accepts "no Team Lead for now" only when there is nobody else to choose', async () => {
    await inRollback(async (tx) => {
      // Every other active Team Lead is out of the way for this check.
      await tx.users.updateMany({ where: { is_team_lead: true, status: 'Active' }, data: { status: 'Inactive' } });
      const john = await makeTeamLead(tx);
      const agent = await svc(tx).store(john.actor, body()) as { id: number };
      const j = (await row(tx, john.id))!;

      await svc(tx).update(ADMIN, john.id, { name: j.name, email: j.email, role: 'agent', status: 'Inactive', reassign_agents_to: null });
      expect(await row(tx, agent.id)).toMatchObject({ team_lead_id: null, status: 'Active' });
    });
  });

  it('does not ask when the Team Lead has no agents, or is only being edited', async () => {
    await inRollback(async (tx) => {
      const empty = await makeTeamLead(tx);
      const e = (await row(tx, empty.id))!;
      await svc(tx).update(ADMIN, empty.id, { name: e.name, email: e.email, role: 'agent', status: 'Inactive' });
      expect((await row(tx, empty.id))?.status).toBe('Inactive');

      const john = await makeTeamLead(tx);
      await svc(tx).store(john.actor, body());
      const j = (await row(tx, john.id))!;
      await svc(tx).update(ADMIN, john.id, { name: j.name, email: j.email, role: 'agent', designation: 'Senior Team Lead' });
      expect((await row(tx, john.id))?.designation).toBe('Senior Team Lead');
    });
  });
});

describe('Dashboard', () => {
  it('a Team Lead counts their own team; an Agent gets nothing', async () => {
    await inRollback(async (tx) => {
      const { actor } = await makeTeamLead(tx);
      const one = await svc(tx).store(actor, body()) as { id: number };
      await svc(tx).store(actor, body());
      await svc(tx).update(actor, one.id, { status: 'Inactive' });

      const dash = new TeamStructureService(tx);
      expect(await dash.forUser(actor)).toMatchObject({ scope: 'team_lead', agents: { total: 2, active: 1, inactive: 1 } });
      expect(await dash.forUser(await asActor(tx, one.id))).toEqual({ scope: 'none' });
    });
  });

  it('a Super Admin sees the Team Lead among the teams', async () => {
    await inRollback(async (tx) => {
      const { id, actor } = await makeTeamLead(tx);
      await svc(tx).store(actor, body());
      const dash = await new TeamStructureService(tx).forUser(ADMIN);
      expect(dash.scope).toBe('admin');
      const team = (dash as { teams: { team_lead_id: number | null; agents: { total: number } }[] }).teams.find((t) => t.team_lead_id === id);
      expect(team?.agents.total).toBe(1);
    });
  });
});

describe('Team Lead removes an Agent who did not work out', () => {
  it('removes their own Agent who holds nothing', async () => {
    await inRollback(async (tx) => {
      const { actor } = await makeTeamLead(tx);
      const agent = await svc(tx).store(actor, body()) as { id: number };
      await svc(tx).destroy(actor, agent.id);
      expect(await row(tx, agent.id)).toBeNull();
    });
  });

  it('refuses an Agent who has a deal (and so its documents), and says to set them Inactive', async () => {
    await inRollback(async (tx) => {
      const { actor } = await makeTeamLead(tx);
      const agent = await svc(tx).store(actor, body()) as { id: number; name: string };
      await tx.transactions.create({ data: { trade_no: `TL-${tag()}`, type: 'Resale', agent: agent.name, agent_user_id: agent.id } });

      await expect(svc(tx).destroy(actor, agent.id)).rejects.toThrow(/deal.*Inactive/s);
      expect(await row(tx, agent.id)).not.toBeNull();
    });
  });

  it("cannot remove another team's Agent", async () => {
    await inRollback(async (tx) => {
      const a = await makeTeamLead(tx);
      const b = await makeTeamLead(tx);
      const theirs = await svc(tx).store(b.actor, body()) as { id: number };
      await expect(svc(tx).destroy(a.actor, theirs.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(await row(tx, theirs.id)).not.toBeNull();
    });
  });
});

describe('the Users door', () => {
  const ctx = (user: unknown, handler: (...a: unknown[]) => unknown) => ({
    switchToHttp: () => ({ getRequest: () => ({ authUser: user }) }),
    getHandler: () => handler,
    getClass: () => UsersController,
  }) as never;
  const guard = new UsersAccessGuard(new Reflector());
  const teamLead = { id: 50, role: 'agent', status: 'Active', is_team_lead: true };

  it('lets a Team Lead list, create and edit, and nothing else', () => {
    const p = UsersController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const h of ['index', 'show', 'store', 'update', 'updatePatch', 'catalog', 'destroy']) {
      expect(guard.canActivate(ctx(teamLead, p[h]))).toBe(true);
    }
    for (const h of ['dealHistory', 'offboarding']) {
      expect(() => guard.canActivate(ctx(teamLead, p[h]))).toThrow(ForbiddenException);
    }
  });

  it('keeps an ordinary Agent, and an inactive Team Lead, out entirely', () => {
    const index = (UsersController.prototype as unknown as Record<string, () => unknown>).index;
    expect(() => guard.canActivate(ctx({ id: 51, role: 'agent', status: 'Active', is_team_lead: false }, index))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({ ...teamLead, status: 'Inactive' }, index))).toThrow(ForbiddenException);
  });

  it('a Team Lead is an Agent to every other module', () => {
    // Every other module asks `role === 'agent'`; the flag is read only by Users and Dashboard.
    expect(teamLeadIdOf(teamLead)).toBe(50);
    expect(teamLead.role).toBe('agent');
    expect(teamLeadIdOf({ id: 52, role: 'manager', status: 'Active', is_team_lead: true })).toBeNull();
  });
});

afterAll(async () => { await prisma.$disconnect(); });
