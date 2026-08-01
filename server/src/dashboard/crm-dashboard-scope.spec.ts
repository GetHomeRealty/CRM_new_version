import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AreaDashboardService } from './area-dashboard.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * What the CRM dashboard is allowed to count.
 *
 * Every case here is a defect a runtime audit found on the live screen, not a hypothetical. The
 * dashboard restated the Leads module's scoping rule from memory and got it wrong in both
 * directions at once, left the campaign aggregates unfiltered entirely, and counted deleted leads
 * for ever. They are cheap to reintroduce — a `where` dropped from one of eighteen parallel
 * queries is invisible in review — and each one shows a confident wrong number rather than failing.
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

async function makeUser(tx: PrismaService, role: string): Promise<AuthUserRecord> {
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `Dash ${role} ${tag()}`, email: `dash-${tag()}@example.test`, role, status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

async function makeLead(tx: PrismaService, over: Record<string, unknown> = {}): Promise<{ id: number }> {
  const now = new Date();
  return tx.leads.create({
    data: { name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`, lead_status: 'hot', lead_source: 'meta', company_id: 1, created_at: now, updated_at: now, ...over },
  });
}

const crmFor = (tx: PrismaService, user: AuthUserRecord) => new AreaDashboardService(tx).crm(user);

describe('CRM dashboard — lead counting', () => {
  it('leaves a deleted lead out of every lead figure', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'agent');
      await makeLead(tx, { owner_user_id: owner.id });
      const doomed = await makeLead(tx, { owner_user_id: owner.id });

      const before = await crmFor(tx, owner);
      expect(before.leads.total).toBe(2);

      await tx.leads.update({ where: { id: doomed.id }, data: { deleted_at: new Date() } });

      const after = await crmFor(tx, owner);
      expect(after.leads.total).toBe(1);
      // The breakdowns are the same query with a groupBy — they must not disagree with the total.
      expect(Object.values(after.leads.by_status).reduce((a, b) => a + b, 0)).toBe(1);
      expect(Object.values(after.leads.by_source).reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  it('counts a lead an agent OWNS but was never assigned', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      await makeLead(tx, { owner_user_id: agent.id, assigned_to: null });

      // Scoping by `assigned_to` alone made this read 0 — an agent handed a book saw none of it.
      expect((await crmFor(tx, agent)).leads.total).toBe(1);
    });
  });

  it('does not show one agent another agent\'s leads', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const theirs = await makeUser(tx, 'agent');
      await makeLead(tx, { owner_user_id: theirs.id, assigned_to: theirs.id });

      expect((await crmFor(tx, mine)).leads.total).toBe(0);
    });
  });

  it('does not hand a manager the whole brokerage', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const manager = await makeUser(tx, 'manager');
      await makeLead(tx, { owner_user_id: agent.id, assigned_to: agent.id });

      // A manager is not exempt from the Leads module's rule; their tile must say what their
      // Leads screen says, which is that another person's book is not theirs to read.
      expect((await crmFor(tx, manager)).leads.total).toBe(0);
    });
  });
});

describe('CRM dashboard — campaign counting', () => {
  it('counts only the campaigns the signed-in user created', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const theirs = await makeUser(tx, 'manager');
      const now = new Date();
      await tx.campaigns.create({
        data: { name: `Theirs ${tag()}`, created_by_id: theirs.id, subject: 'Theirs subject', content: 'body', sent: 40, opened: 10, failed: 1, company_id: 1, created_at: now, updated_at: now },
      });

      // Unfiltered, this read the brokerage's totals: an agent owning nothing still saw the count
      // and the send volumes of everybody else's campaigns.
      const dash = await crmFor(tx, mine);
      expect(dash.campaigns.total).toBe(0);
      expect(dash.campaigns.sent).toBe(0);
      expect(dash.campaigns.opened).toBe(0);
    });
  });

  it('counts a campaign the user did create', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const now = new Date();
      await tx.campaigns.create({
        data: { name: `Mine ${tag()}`, created_by_id: mine.id, subject: 'Mine subject', content: 'body', sent: 7, opened: 3, failed: 0, company_id: 1, created_at: now, updated_at: now },
      });

      const dash = await crmFor(tx, mine);
      expect(dash.campaigns.total).toBe(1);
      expect(dash.campaigns.sent).toBe(7);
    });
  });
});

describe('CRM dashboard — lead task counting', () => {
  it('ignores tasks whose lead has been deleted', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'agent');
      const lead = await makeLead(tx, { owner_user_id: owner.id });
      const now = new Date();
      await tx.lead_tasks.create({
        data: { lead_id: lead.id, title: 'Call back', status: 'pending', due_date: new Date(), user_id: owner.id, assigned_to: owner.id, company_id: 1, created_at: now, updated_at: now },
      });

      expect((await crmFor(tx, owner)).tasks.total).toBe(1);

      await tx.leads.update({ where: { id: lead.id }, data: { deleted_at: new Date() } });

      // The tile counted these and the Lead Tasks panel below it did not, so the two printed
      // different answers to the same question on one screen.
      expect((await crmFor(tx, owner)).tasks.total).toBe(0);
    });
  });

  it('ignores tasks on another person\'s lead', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const theirs = await makeUser(tx, 'agent');
      const lead = await makeLead(tx, { owner_user_id: theirs.id, assigned_to: theirs.id });
      const now = new Date();
      await tx.lead_tasks.create({
        data: { lead_id: lead.id, title: 'Not mine', status: 'pending', due_date: new Date(), user_id: theirs.id, assigned_to: theirs.id, company_id: 1, created_at: now, updated_at: now },
      });

      expect((await crmFor(tx, mine)).tasks.total).toBe(0);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
