import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { PermissionService } from '../auth/permission.service';
import { RolePermissionStore } from '../core/role-permission.store';
import { RecruitmentReferralService } from './recruitment-referral.service';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { RecruitmentReferralController } from './recruitment-referral.controller';
import { RecruitmentNoAgentsGuard } from './recruitment-no-agents.guard';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

/**
 * "Refer a Candidate": an agent may SUBMIT a referral, and nothing else in Recruitment.
 *
 * Against the test database, each case in a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

type U = { id: number; name: string; role: string };
const as = (u: U): AuthUserRecord => ({ id: u.id, name: u.name, role: u.role, user_permissions: [] } as unknown as AuthUserRecord);

async function makeUser(tx: PrismaService, role: string): Promise<U> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `ZZ Ref ${role} ${t}`, email: `zz-ref-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

const findByName = (tx: PrismaService, name: string) =>
  tx.recruitment_candidates.findFirst({ where: { name }, include: { notes: true, events: true } });

describe('an agent referring a candidate', () => {
  it('creates a new, unassigned referral recorded against the agent, with the note and the date', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const name = `Priya Candidate ${tag()}`;
      const before = Date.now();

      const res = await new RecruitmentReferralService(tx).refer(as(agent), {
        name, phone: '416-555-0199', email: 'Priya@Example.com', note: 'Met her at an open house; licensed in 2024.',
      });

      // A confirmation only — no id, no status, nothing to look the record up by.
      expect(Object.keys(res)).toEqual(['message']);
      expect(res.message).toContain(name);

      const row = await findByName(tx, name);
      expect(row).toMatchObject({
        source: 'referral', referred_by_user_id: agent.id, assigned_recruiter_id: null, status: 'new',
        phone: '416-555-0199', email: 'priya@example.com', created_by: agent.name,
      });
      expect(row!.created_at!.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(row!.notes.map((n) => [n.body, n.user_id])).toEqual([['Met her at an open house; licensed in 2024.', agent.id]]);
      expect(row!.events.map((e) => [e.action, e.actor_id])).toEqual([['referred', agent.id]]);
    });
  });

  it('records the agent from the session, never from the request', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const someoneElse = await makeUser(tx, 'agent');
      const name = `Spoof ${tag()}`;
      await new RecruitmentReferralService(tx).refer(as(agent), {
        name, phone: '4165550100', referred_by_user_id: someoneElse.id, assigned_recruiter_id: someoneElse.id, status: 'approved', source: 'website',
      });
      expect(await findByName(tx, name)).toMatchObject({
        referred_by_user_id: agent.id, assigned_recruiter_id: null, status: 'new', source: 'referral',
      });
    });
  });

  it('accepts a referral without an email or a note', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const name = `No Email ${tag()}`;
      await new RecruitmentReferralService(tx).refer(as(agent), { name, phone: '(905) 555-0123' });
      const row = await findByName(tx, name);
      expect(row).toMatchObject({ email: '', phone: '(905) 555-0123' });
      expect(row!.notes).toEqual([]);
    });
  });

  it('requires a name and a phone number, and a well-formed email when one is given', async () => {
    await inRollback(async (tx) => {
      const svc = new RecruitmentReferralService(tx);
      const agent = as(await makeUser(tx, 'agent'));
      await expect(svc.refer(agent, { name: '', phone: '4165550100' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.refer(agent, { name: 'A', phone: '' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.refer(agent, { name: 'A', phone: '12' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.refer(agent, { name: 'A', phone: '4165550100', email: 'not-an-email' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.refer(agent, { name: 'A', phone: '4165550100', note: 'x'.repeat(2001) })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('is for agents: other roles are refused (they use the Recruitment screen)', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      await expect(new RecruitmentReferralService(tx).refer(as(admin), { name: 'A', phone: '4165550100' }))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('the agent still cannot read, change or delete recruitment records', () => {
  it('the agent role holds no Recruitment screen permission, so every Recruitment route refuses them', async () => {
    // The stored role matrix the running app uses (seeded by the recruitment migration), not the
    // compiled fallback that applies only when no store is wired in.
    const store = new RolePermissionStore(prisma as unknown as PrismaService);
    await store.reload();
    expect(store.defaultsFor('agent')).not.toBeNull();
    const permissions = new PermissionService();
    permissions.useStore(store);
    for (const level of ['view', 'edit'] as const) {
      expect(permissions.can('agent', [], 'recruitment', level)).toBe(false);
    }
  });

  it('even past the screen guard, the agent sees none of it — not even their own referral', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const name = `Hidden ${tag()}`;
      await new RecruitmentReferralService(tx).refer(as(agent), { name, phone: '4165550100' });
      const id = (await findByName(tx, name))!.id;
      const recruitment = new RecruitmentService(tx);

      const list = await recruitment.list(as(agent), {}) as { data: { id: number }[] };
      expect(list.data.map((c) => c.id)).not.toContain(id);
      await expect(recruitment.show(as(agent), id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(recruitment.update(as(agent), id, { name: 'Changed' })).rejects.toBeInstanceOf(NotFoundException);
      // Delete is refused even earlier: only a decider may archive, so the agent is Forbidden first.
      const archived = recruitment.archive(as(agent), id);
      await expect(archived).rejects.toThrow();
      await archived.catch((e: unknown) => expect(e instanceof NotFoundException || e instanceof ForbiddenException).toBe(true));
      expect((await tx.recruitment_candidates.findUniqueOrThrow({ where: { id } })).deleted_at).toBeNull();
    });
  });

  it('the referral reaches the existing Admin / Recruiter queue', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const admin = await makeUser(tx, 'admin');
      const name = `Queue ${tag()}`;
      await new RecruitmentReferralService(tx).refer(as(agent), { name, phone: '4165550100' });

      const list = await new RecruitmentService(tx).list(as(admin), { q: name }) as { data: { name: string }[] };
      expect(list.data.map((c) => c.name)).toContain(name);
    });
  });
});

describe('agents are refused on every Recruitment route, even on the fallback permission defaults', () => {
  const contextFor = (role: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 1, name: 'x', role, user_permissions: [] } }) }),
  }) as never;

  it('the compiled defaults alone WOULD let an agent past ScreenGuard — which is the gap the guard closes', () => {
    // No store wired in: this is the fallback the app uses if role permissions fail to load.
    expect(new PermissionService().can('agent', [], 'recruitment', 'view')).toBe(true);
  });

  it('the guard refuses an agent and lets Admin, Manager and Recruiter through unchanged', () => {
    const guard = new RecruitmentNoAgentsGuard();
    expect(() => guard.canActivate(contextFor('agent'))).toThrow(ForbiddenException);
    for (const role of ['admin', 'manager', 'recruiter']) expect(guard.canActivate(contextFor(role))).toBe(true);
  });

  it('it guards the whole RecruitmentController — every read, update, delete, interview, document and approval route', () => {
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, RecruitmentController) ?? []) as unknown[];
    expect(classGuards).toContain(RecruitmentNoAgentsGuard);
    // Every route on the controller inherits the class guards; count them so a route moved to a new
    // controller (and out from under this guard) shows up here.
    const proto = RecruitmentController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[m] as object) !== undefined);
    expect(routes.length).toBe(22);
    // The referral route is the only one outside it, and it is the agents' submission door.
    expect((Reflect.getMetadata(GUARDS_METADATA, RecruitmentReferralController) ?? []) as unknown[]).not.toContain(RecruitmentNoAgentsGuard);
  });
});

describe('a referral is saved atomically: candidate, note and history together or not at all', () => {
  const marker = `ZZ Atomic ${Date.now()}`;
  const made: number[] = [];
  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS zz_referral_atomic ON recruitment_events');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS zz_referral_atomic_fail()');
    await prisma.recruitment_candidates.deleteMany({ where: { name: { startsWith: marker } } });
    if (made.length) await prisma.users.deleteMany({ where: { id: { in: made } } });
  });

  it('a failure writing the history leaves no candidate and no note behind', async () => {
    const db = prisma as unknown as PrismaService;
    const agent = await makeUser(db, 'agent');
    made.push(agent.id);
    // A test-only trigger that rejects this one history row, so the LAST part of the write fails.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION zz_referral_atomic_fail() RETURNS trigger AS $$
      BEGIN IF NEW.actor_id = ${agent.id} THEN RAISE EXCEPTION 'zz forced failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER zz_referral_atomic BEFORE INSERT ON recruitment_events FOR EACH ROW EXECUTE FUNCTION zz_referral_atomic_fail()');

    await expect(new RecruitmentReferralService(db).refer(as(agent), { name: `${marker} A`, phone: '4165550100', note: 'should not survive' }))
      .rejects.toThrow();

    expect(await prisma.recruitment_candidates.count({ where: { name: { startsWith: marker } } })).toBe(0);
    expect(await prisma.recruitment_notes.count({ where: { user_id: agent.id } })).toBe(0);

    // And with the trigger gone the same submission goes through whole.
    await prisma.$executeRawUnsafe('DROP TRIGGER zz_referral_atomic ON recruitment_events');
    await new RecruitmentReferralService(db).refer(as(agent), { name: `${marker} B`, phone: '4165550100', note: 'kept' });
    const row = await prisma.recruitment_candidates.findFirst({ where: { name: `${marker} B` }, include: { notes: true, events: true } });
    expect([row?.notes.length, row?.events.length]).toEqual([1, 1]);
  });
});
