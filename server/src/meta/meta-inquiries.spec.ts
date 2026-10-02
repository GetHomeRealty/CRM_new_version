import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaApiBudgetService } from './meta-api-budget.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaSyncService } from './meta-sync.service';
import { mapMetaInquiry, mapMetaLead } from './meta-lead-mapper';
import type { GraphLead } from './meta-graph.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { LeadAssignmentHistoryService } from '../leads/lead-assignment-history.service';
import { LeadNotificationService } from '../leads/lead-notification.service';
import { LeadTeamAssignmentService } from '../leads/lead-team-assignment.service';
import { LeadsService } from '../leads/leads.service';

/**
 * MULTIPLE META INQUIRIES FOR THE SAME LEAD: one person is one lead, and each unique Meta
 * submission is one inquiry under it, keeping its own address.
 *
 * Against the test database, each case in a transaction that is rolled back. The concurrency case
 * needs two real connections racing, so it uses the client directly and deletes what it made.
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

async function makeUser(db: PrismaService, role: string, label: string): Promise<U> {
  const now = new Date();
  const t = tag();
  return db.users.create({
    data: { name: `ZZ Inq ${label} ${t}`, email: `zz-inq-${label}-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

/** Real persistence; nothing emailed. */
const syncService = (db: PrismaService) => new MetaSyncService(
  db,
  new MetaConnectionService(db, { fetchPages: async () => [] } as never),
  {} as never,
  new LeadAuditService(db),
  { notifyNewLead: async () => {} } as never,
  new MetaApiBudgetService(db),
  { reconnectRequired: async () => {} } as never,
);

function leadsService(db: PrismaService) {
  const audit = new LeadAuditService(db);
  const history = new LeadAssignmentHistoryService(db);
  return new LeadsService(db, audit, new LeadNotificationService(db, null as never), undefined, new LeadTeamAssignmentService(db, audit, history), history);
}

function submission(id: string, email: string, answers: Record<string, string>, at: Date): GraphLead {
  return {
    id,
    created_time: at.toISOString(),
    field_data: [
      { name: 'full_name', values: ['John Smith'] },
      { name: 'email', values: [email] },
      ...Object.entries(answers).map(([name, v]) => ({ name, values: [v] })),
    ],
  } as GraphLead;
}

const ctxFor = (user: { id: number; name: string }, ownerId: number | null, form = 'Mississauga Homes') => ({
  userId: user.id, userName: user.name, pageId: 'page-ghr', pageName: 'Get Home Realty',
  formId: `form-${form.replace(/\W+/g, '-').toLowerCase()}`, formName: form, ownerId,
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15, 0, 0));
const inquiriesOf = (db: PrismaService, leadId: number) =>
  db.meta_lead_inquiries.findMany({ where: { lead_id: leadId }, orderBy: { submitted_at: 'asc' } });

describe('multiple Meta inquiries for the same lead', () => {
  it('1. a first submission makes one lead with Meta Inquiries 1', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const email = `john-${tag()}@probe.test`;
      const r = await syncService(tx).upsertLead(submission(`m-${tag()}`, email, { property: '123 Main St, Mississauga' }, day(2)), ctxFor(agent, agent.id));

      expect(r.outcome).toBe('imported');
      expect(await tx.leads.count({ where: { email } })).toBe(1);
      const detail = await leadsService(tx).get(r.leadId!, as(agent));
      expect(detail.meta_inquiry_count).toBe(1);
      expect(detail.meta_inquiries).toEqual([expect.objectContaining({ property_address: '123 Main St, Mississauga', form_name: 'Mississauga Homes' })]);
    });
  });

  it('2 & 5. the same submission synced repeatedly stays one inquiry', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const sync = syncService(tx);
      const s = submission(`m-${tag()}`, `john-${tag()}@probe.test`, { property: '123 Main St, Mississauga' }, day(2));
      const first = await sync.upsertLead(s, ctxFor(agent, agent.id));

      const outcomes: string[] = [];
      for (let i = 0; i < 10; i += 1) outcomes.push((await sync.upsertLead(s, ctxFor(agent, agent.id))).outcome);

      expect(new Set(outcomes)).toEqual(new Set(['updated']));
      expect(await inquiriesOf(tx, first.leadId!)).toHaveLength(1);
      expect((await leadsService(tx).get(first.leadId!, as(agent))).meta_inquiry_count).toBe(1);
    });
  });

  it('3 & 4. new submissions from the same person: still one lead, Meta Inquiries 2 then 3, every address kept', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const ids = [`m-${tag()}`, `m-${tag()}`, `m-${tag()}`];

      const one = await sync.upsertLead(submission(ids[0], email, { property: '123 Main St, Mississauga' }, day(2)), ctxFor(agent, agent.id, 'Mississauga Homes'));
      const first = (await inquiriesOf(tx, one.leadId!))[0];
      const two = await sync.upsertLead(submission(ids[1], email, { street_address: '55 Dundas St, Toronto' }, day(5)), ctxFor(agent, agent.id, 'Toronto Homes'));
      expect(two).toMatchObject({ outcome: 'duplicate', leadId: one.leadId });
      expect((await leadsService(tx).get(one.leadId!, as(agent))).meta_inquiry_count).toBe(2);

      const three = await sync.upsertLead(submission(ids[2], email, { address: '789 Kingston Rd, Pickering' }, day(8)), ctxFor(agent, agent.id, 'Pickering Homes'));
      expect(three).toMatchObject({ outcome: 'duplicate', leadId: one.leadId });
      expect(await tx.leads.count({ where: { email } })).toBe(1);

      const detail = await leadsService(tx).get(one.leadId!, as(agent));
      expect(detail.meta_inquiry_count).toBe(3);
      // Newest first, each with ITS OWN address.
      expect((detail.meta_inquiries as { property_address: string }[]).map((q) => q.property_address)).toEqual([
        '789 Kingston Rd, Pickering', '55 Dundas St, Toronto', '123 Main St, Mississauga',
      ]);
      // The first inquiry is unchanged by the two that followed.
      expect((await inquiriesOf(tx, one.leadId!))[0]).toEqual(first);
    });
  });

  it('6. another inquiry leaves the assigned agent, owner and status unchanged', async () => {
    await inRollback(async (tx) => {
      const agentA = await makeUser(tx, 'agent', 'a');
      const colleague = await makeUser(tx, 'agent', 'c');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const first = await sync.upsertLead(submission(`m-${tag()}`, email, {}, day(2)), ctxFor(agentA, agentA.id));
      await tx.leads.update({ where: { id: first.leadId! }, data: { assigned_to: colleague.id, lead_status: 'hot' } });
      const before = await tx.leads.findUniqueOrThrow({ where: { id: first.leadId! } });

      const again = await sync.upsertLead(submission(`m-${tag()}`, email, { property: '55 Dundas St' }, day(5)), ctxFor(agentA, agentA.id));

      expect(again).toMatchObject({ outcome: 'duplicate', leadId: first.leadId });
      const after = await tx.leads.findUniqueOrThrow({ where: { id: first.leadId! } });
      expect([after.owner_user_id, after.assigned_to, after.lead_status]).toEqual([before.owner_user_id, colleague.id, 'hot']);
    });
  });

  it('7. a brokerage lead handed Admin → Team Lead → Agent keeps that chain, and the inquiry is not lost', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin', 'admin');
      const teamLead = await makeUser(tx, 'agent', 'tl');
      const agentA = await makeUser(tx, 'agent', 'a');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const first = await sync.upsertLead(submission(`m-${tag()}`, email, {}, day(2)), ctxFor(admin, null));
      await tx.leads.update({ where: { id: first.leadId! }, data: { assigned_to: agentA.id, assigned_team_lead_id: teamLead.id } });
      const before = await tx.leads.findUniqueOrThrow({ where: { id: first.leadId! } });

      const again = await sync.upsertLead(submission(`m-${tag()}`, email, { property: '55 Dundas St' }, day(5)), ctxFor(admin, null, 'Toronto Homes'));

      expect(again).toMatchObject({ outcome: 'duplicate', leadId: first.leadId });
      const after = await tx.leads.findUniqueOrThrow({ where: { id: first.leadId! } });
      expect(after.owner_user_id).toBeNull();
      expect(after.assigned_to).toBe(agentA.id);
      expect(after.assigned_team_lead_id).toBe(teamLead.id);
      expect(after.team_id).toBe(before.team_id);
      expect(await tx.leads.count({ where: { email } })).toBe(1);
      expect(await inquiriesOf(tx, first.leadId!)).toHaveLength(2);
    });
  });

  it('agent intake still never writes into another agent\'s lead for the same person', async () => {
    await inRollback(async (tx) => {
      const agentA = await makeUser(tx, 'agent', 'a');
      const agentB = await makeUser(tx, 'agent', 'b');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const hers = await sync.upsertLead(submission(`m-${tag()}`, email, {}, day(2)), ctxFor(agentA, agentA.id));
      const his = await sync.upsertLead(submission(`m-${tag()}`, email, {}, day(5)), ctxFor(agentB, agentB.id));

      expect(his.outcome).toBe('imported');
      expect(his.leadId).not.toBe(hers.leadId);
      expect(await inquiriesOf(tx, hers.leadId!)).toHaveLength(1);
    });
  });

  it('8. a submission with no address is stored without one, never guessed', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const first = await sync.upsertLead(submission(`m-${tag()}`, email, { property: '123 Main St' }, day(2)), ctxFor(agent, agent.id));
      await sync.upsertLead(submission(`m-${tag()}`, email, { property_type: 'Condo' }, day(5)), ctxFor(agent, agent.id, 'Toronto Homes'));

      const [newest] = (await leadsService(tx).get(first.leadId!, as(agent))).meta_inquiries as { property_address: string | null }[];
      // Null is what the screen renders as "Not provided" — not the lead's 123 Main St, nor "Condo".
      expect(newest.property_address).toBeNull();
    });
  });

  it('9. inquiry history is returned only to someone who may view the lead', async () => {
    await inRollback(async (tx) => {
      const agentA = await makeUser(tx, 'agent', 'a');
      const agentB = await makeUser(tx, 'agent', 'b');
      const sync = syncService(tx);
      const email = `john-${tag()}@probe.test`;
      const first = await sync.upsertLead(submission(`m-${tag()}`, email, { property: '123 Main St' }, day(2)), ctxFor(agentA, agentA.id));
      await sync.upsertLead(submission(`m-${tag()}`, email, { property: '55 Dundas St' }, day(5)), ctxFor(agentA, agentA.id));

      expect((await leadsService(tx).get(first.leadId!, as(agentA))).meta_inquiry_count).toBe(2);
      await expect(leadsService(tx).get(first.leadId!, as(agentB))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('10. a non-Meta lead works as before and reports no inquiries', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const now = new Date();
      const manual = await tx.leads.create({
        data: { name: 'Walk-in', email: `walkin-${tag()}@probe.test`, source: 'manual', lead_source: 'walk_in', owner_user_id: agent.id, assigned_to: agent.id, created_at: now, updated_at: now },
      });
      const detail = await leadsService(tx).get(manual.id, as(agent));
      expect(detail.meta_inquiry_count).toBe(0);
      expect(detail.meta_inquiries).toEqual([]);
      expect(detail.meta).toBeNull();
    });
  });

  it('the migration backfill writes inquiry #1 per Meta lead, never guesses an address, and is safe to re-run', async () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261002200000_meta_lead_inquiries/migration.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO "meta_lead_inquiries"'));
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent', 'a');
      const at = new Date(Date.UTC(2026, 8, 1, 12, 0, 0));
      const later = new Date(Date.UTC(2026, 8, 9, 12, 0, 0));
      const base = { owner_user_id: agent.id, assigned_to: agent.id, source: 'facebook_meta', created_by: 'Meta · P', created_at: at, updated_at: at };
      // Created by the submission it still describes: that address is this submission's.
      const own = await tx.leads.create({ data: { ...base, name: 'A', email: `a-${tag()}@probe.test`, facebook_lead_id: `bf-${tag()}`, property: '9 King St', meta_created_at: at } });
      // Later overwritten by another submission: its address belongs to the first, so it is not copied.
      const moved = await tx.leads.create({ data: { ...base, name: 'B', email: `b-${tag()}@probe.test`, facebook_lead_id: `bf-${tag()}`, property: '1 Old Rd', meta_created_at: later } });

      await tx.$executeRawUnsafe(backfill);
      await tx.$executeRawUnsafe(backfill);

      const a = await inquiriesOf(tx, own.id);
      const b = await inquiriesOf(tx, moved.id);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toMatchObject({ facebook_lead_id: own.facebook_lead_id, property_address: '9 King St' });
      expect(b[0].property_address).toBeNull();
    });
  });
});

describe('the same submission processed concurrently (real connections, cleaned up)', () => {
  const made = { users: [] as number[], email: '' };
  afterAll(async () => {
    const ids = (await prisma.leads.findMany({ where: { email: made.email }, select: { id: true } })).map((l) => l.id);
    if (ids.length) await prisma.leads.deleteMany({ where: { id: { in: ids } } }); // inquiries cascade
    if (made.users.length) await prisma.users.deleteMany({ where: { id: { in: made.users } } });
  });

  it('two workers on one submission write one lead and one inquiry', async () => {
    const db = prisma as unknown as PrismaService;
    const agent = await makeUser(db, 'agent', 'race');
    made.users.push(agent.id);
    made.email = `race-${tag()}@probe.test`;
    const [a, b] = [syncService(db), syncService(db)];

    const s1 = submission(`race-${tag()}`, made.email, { property: '123 Main St' }, day(2));
    const r1 = await Promise.all([a.upsertLead(s1, ctxFor(agent, agent.id)), b.upsertLead(s1, ctxFor(agent, agent.id))]);
    expect(r1.map((r) => r.outcome).sort()).toEqual(['imported', 'updated']);

    const s2 = submission(`race-${tag()}`, made.email, { property: '55 Dundas St' }, day(5));
    const r2 = await Promise.all([a.upsertLead(s2, ctxFor(agent, agent.id)), b.upsertLead(s2, ctxFor(agent, agent.id))]);
    expect(r2.map((r) => r.outcome).sort()).toEqual(['duplicate', 'updated']);

    const leads = await prisma.leads.findMany({ where: { email: made.email } });
    expect(leads).toHaveLength(1);
    expect(await prisma.meta_lead_inquiries.count({ where: { lead_id: leads[0].id } })).toBe(2);
  });
});

describe('mapMetaInquiry', () => {
  const fields = (o: Record<string, string>) => Object.entries(o).map(([name, v]) => ({ name, values: [v] }));

  it('reads the address through the existing field mapping, under whatever the form called it', () => {
    for (const key of ['property', 'property_interest', 'street_address', 'Property Address']) {
      const f = fields({ [key]: '123 Main St' });
      expect(mapMetaInquiry(f, mapMetaLead(f)).property_address).toBe('123 Main St');
    }
  });

  it('never takes the property TYPE for an address', () => {
    const f = fields({ property_type: 'Condo' });
    expect(mapMetaInquiry(f, mapMetaLead(f)).property_address).toBeNull();
  });

  it('reads a project from a project question, not from an address question', () => {
    const p = fields({ which_project_are_you_interested_in: 'Pickering Pre-Construction' });
    expect(mapMetaInquiry(p, mapMetaLead(p)).project_name).toBe('Pickering Pre-Construction');
    const a = fields({ project_address: '1 Lake Rd' });
    expect(mapMetaInquiry(a, mapMetaLead(a))).toMatchObject({ project_name: null, property_address: '1 Lake Rd' });
  });
});
