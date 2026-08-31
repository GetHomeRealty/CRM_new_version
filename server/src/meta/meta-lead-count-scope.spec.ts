import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { liveLeadWhere } from '../common/lead-scope';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The Meta page's lead tiles must count the leads Meta actually delivered.
 *
 * THE DEFECT, seen live. The three tiles — Meta leads, Today, This week — and the list beneath them
 * all asked for `owner_user_id = you`. A Meta lead does not necessarily arrive owned: the importer
 * writes brokerage-owned rows and records an ASSIGNEE, so a lead handed straight to the person
 * looking at the screen matched nothing.
 *
 * "Misha Abayev" landed at 01:12 with `owner_user_id = null, assigned_to = 10108`. A browser
 * notification told that user the lead had arrived; the Lead page listed it; every tile on the Meta
 * page stayed at 0. Two live Meta leads existed and the card read zero for every user in the
 * brokerage.
 *
 * THE RULE NOW. `liveLeadWhere` — assigned to you, or owned by you, plus the brokerage's own when
 * your role includes them. It is the same rule the Lead list, the CRM dashboard and the lead-task
 * counters already use, borrowed rather than restated so this card cannot drift from the page it
 * links to. These tests assert the SHAPE of the rule, not a hard-coded number, so they still hold
 * when the scope rule legitimately changes.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data.
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
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Exactly what the controller now runs for the tiles and the list. */
const metaWhere = (user: AuthUserRecord) => ({ AND: [{ source: 'facebook_meta' }, liveLeadWhere(user)] });
const countFor = (tx: PrismaService, user: AuthUserRecord) => tx.leads.count({ where: metaWhere(user) });

/** What the card used to ask for — kept so the tests can show the difference, not just the result. */
const oldCountFor = (tx: PrismaService, user: AuthUserRecord) =>
  tx.leads.count({ where: { source: 'facebook_meta', deleted_at: null, owner_user_id: user.id ?? -1 } });

async function makeUser(tx: PrismaService, role: string): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Meta ${role} ${t}`, email: `meta-${t}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

/** A lead exactly as the Meta importer writes it. */
async function metaLead(
  tx: PrismaService,
  over: { owner_user_id?: number | null; assigned_to?: number | null; deleted?: boolean; source?: string } = {},
) {
  const now = new Date();
  const t = tag();
  return tx.leads.create({
    data: {
      name: `Meta probe ${t}`, email: `meta-lead-${t}@example.test`,
      source: over.source ?? 'facebook_meta',
      owner_user_id: over.owner_user_id ?? null,
      assigned_to: over.assigned_to ?? null,
      deleted_at: over.deleted ? now : null,
      created_at: now, updated_at: now,
    },
  });
}

// =================================================================================================

describe('a Meta lead assigned to you', () => {
  it('THE DEFECT: is counted, even though the brokerage owns it', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const before = await countFor(tx, agent);

      // The exact shape that arrived live: brokerage-owned, assigned to this person.
      await metaLead(tx, { owner_user_id: null, assigned_to: agent.id });

      expect(await countFor(tx, agent)).toBe(before + 1);
      // And the proof the test is about the fix: the old predicate still cannot see it.
      expect(await oldCountFor(tx, agent)).toBe(0);
    });
  });

  it('is counted when it is owned by you outright', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const before = await countFor(tx, agent);

      await metaLead(tx, { owner_user_id: agent.id, assigned_to: agent.id });

      expect(await countFor(tx, agent)).toBe(before + 1);
    });
  });
});

describe('what must still be excluded', () => {
  it('a deleted Meta lead is not counted', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const before = await countFor(tx, agent);

      await metaLead(tx, { owner_user_id: null, assigned_to: agent.id, deleted: true });

      // Recently Deleted is not the Meta page's business — 505 deleted imports sit in this
      // database and none of them belong on this card.
      expect(await countFor(tx, agent)).toBe(before);
    });
  });

  it('a lead from another source is not counted', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const before = await countFor(tx, agent);

      await metaLead(tx, { owner_user_id: null, assigned_to: agent.id, source: 'website' });

      expect(await countFor(tx, agent)).toBe(before);
    });
  });

  it('another agent\'s Meta lead stays out of an agent\'s count', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx, 'agent');
      const theirs = await makeUser(tx, 'agent');
      const before = await countFor(tx, mine);

      // Owned by, and assigned to, somebody else — no claim on it in either column.
      await metaLead(tx, { owner_user_id: theirs.id, assigned_to: theirs.id });

      expect(await countFor(tx, mine)).toBe(before);
    });
  });
});

describe('the tiles and the list agree', () => {
  it('the count matches the rows the list would return', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      await metaLead(tx, { owner_user_id: null, assigned_to: agent.id });
      await metaLead(tx, { owner_user_id: agent.id });
      await metaLead(tx, { owner_user_id: null, assigned_to: agent.id, deleted: true });

      // One predicate feeds both, so "3 leads" over a list of 2 is not expressible any more.
      const rows = await tx.leads.findMany({ where: metaWhere(agent), select: { id: true } });
      expect(await countFor(tx, agent)).toBe(rows.length);
    });
  });

  it('counting writes nothing', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      const lead = await metaLead(tx, { owner_user_id: null, assigned_to: agent.id });

      const before = await tx.leads.count({ where: { source: 'facebook_meta' } });
      await countFor(tx, agent);
      expect(await tx.leads.count({ where: { source: 'facebook_meta' } })).toBe(before);
      expect((await tx.leads.findUnique({ where: { id: lead.id } }))!.deleted_at).toBeNull();
    });
  });
});
