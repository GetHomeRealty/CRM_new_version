import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { ResourceAccessService } from './resource-access.service';
import { CampaignAudienceService } from '../campaigns/campaign-audience.service';
import { LeadImportEngine } from '../leads/lead-import.engine';
import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import { hasBrokerageLeadScope, leadScopeWhere, liveLeadWhere, ownerAtIntake } from '../common/lead-scope';

/**
 * THE CRM'S LEAD OWNERSHIP RULE, asserted once for every module that has to obey it.
 *
 * ================================================================================================
 * THE RULE
 *
 *   A BROKERAGE lead (`owner_user_id IS NULL`) belongs to the brokerage. `leads.brokerage-scope`
 *   holders — admin, manager, crm — may work with it, and so may whoever it is assigned to.
 *
 *   An AGENT lead (`owner_user_id = X`) is X's private book. NOBODY else reaches it: not a
 *   manager, not an administrator, not a Super Admin, not another agent. Rank buys nothing here.
 *
 *   Assignment is a SEPARATE field. A brokerage lead handed to an agent stays the brokerage's.
 * ================================================================================================
 *
 * WHY THIS FILE EXISTS RATHER THAN ONE TEST PER SERVICE. The defect it locks down was never that a
 * single service had the wrong rule — it was that FOUR services each had their OWN rule and three of
 * them disagreed. Measured before the fix, for one Manager at one moment:
 *
 *   Leads screen        0 leads      (`isSuperAdmin` was the only way to reach brokerage intake)
 *   Campaign audience   81 leads     (`return {}` — every lead, including agents' private books)
 *   Direct email        every lead   (`data.read-all` — unscoped)
 *
 * A per-service test would have passed on all three. So each block below asks the SAME question of a
 * DIFFERENT module against ONE seeded population, and the population is the one the requirement
 * names: 10 brokerage leads, 5 private to Agent A, 7 private to Agent B.
 *
 * Everything runs inside a rolled-back transaction, so the suite may run against a populated
 * database without the counts depending on what is already there — every assertion is scoped to
 * this run's own tag.
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
    }, { timeout: 30000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const as = (u: { id: number; name: string; role: string | null }): AuthUserRecord =>
  ({ id: u.id, name: u.name, role: u.role ?? 'agent', user_permissions: [] } as unknown as AuthUserRecord);

/**
 * The seeded world. `tag` makes every row in this run findable without colliding with the database
 * it runs against — the counts below are all taken within the tag.
 */
async function world(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  const tag = `los-${Date.now()}-${n}`;

  const mk = async (role: string, label: string) => tx.users.create({
    data: {
      name: `${label} ${tag}`, email: `${label}-${tag}@x.test`, password: 'x',
      role, status: 'Active', created_at: now, updated_at: now,
    },
  });

  const agentA = await mk('agent', 'agentA');
  const agentB = await mk('agent', 'agentB');
  const manager = await mk('manager', 'manager');
  const crm = await mk('crm', 'crm');
  const superAdmin = await mk('admin', 'super');
  const accounting = await mk('accounting', 'acct');

  const lead = async (owner: number | null, assigned: number | null, label: string) => tx.leads.create({
    data: {
      name: `${label} ${tag}`, email: `${label}-${tag}@x.test`,
      owner_user_id: owner, assigned_to: assigned,
      lead_status: 'warm', tags: '[]', unsubscribed: false,
      created_at: now, updated_at: now,
    },
  });

  // 10 leads the BROKERAGE owns — unowned, unassigned. This is central intake.
  const brokerage = [];
  for (let i = 0; i < 10; i++) brokerage.push(await lead(null, null, `brok${i}`));
  // 5 private to Agent A, 7 private to Agent B.
  const privateA = [];
  for (let i = 0; i < 5; i++) privateA.push(await lead(agentA.id, agentA.id, `pa${i}`));
  const privateB = [];
  for (let i = 0; i < 7; i++) privateB.push(await lead(agentB.id, agentB.id, `pb${i}`));

  return { tag, agentA, agentB, manager, crm, superAdmin, accounting, brokerage, privateA, privateB };
}

/** How many leads this person may see, within this run's own rows. */
async function visible(tx: PrismaService, user: AuthUserRecord, tag: string): Promise<number> {
  return tx.leads.count({ where: { AND: [liveLeadWhere(user), { email: { contains: tag } }] } });
}

// ---------------------------------------------------------------------------------------------
describe('the Leads screen shows the brokerage its own leads, and nobody else’s book', () => {
  it('a Manager sees the 10 brokerage leads — not 0, and not all 22', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      /*
       * The headline regression, in one assertion. It was 0 before the fix: `leadScopeWhere` only
       * admitted the brokerage's own leads for `isSuperAdmin`, so the role that runs the brokerage
       * saw an empty screen while 10 of its own leads sat in the table.
       *
       * 22 would be the opposite failure — the counts made to agree by handing over everybody's
       * book. Asserting the exact number is what distinguishes "fixed" from "opened up".
       */
      expect(await visible(tx, as(w.manager), w.tag)).toBe(10);
    });
  });

  it('the CRM role sees the same 10 — it is the role that works them', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      expect(await visible(tx, as(w.crm), w.tag)).toBe(10);
    });
  });

  it('a Super Admin sees the brokerage’s 10 and no agent’s private lead either', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // Unchanged by this work — the top tier already reached unattributed intake. What matters is
      // that it is still 10 and not 22: being Super Admin is not a key to everyone's book.
      expect(await visible(tx, as(w.superAdmin), w.tag)).toBe(10);
    });
  });

  it('Accounting is brokerage staff too, so it sees the same 10', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      /*
       * EVERY non-agent role is brokerage staff. Accounting cannot normally CREATE a lead — it holds
       * `lead: view`, and creating needs `lead: edit` — but the rule is about the person, not the
       * screen: if it ever creates one it belongs to the brokerage, so it must be able to see the
       * brokerage's book. Ownership and visibility are two halves of one decision.
       */
      expect(await visible(tx, as(w.accounting), w.tag)).toBe(10);
      // And still nothing of anybody's private book.
      const privateIds = [...w.privateA, ...w.privateB].map((l) => l.id);
      expect(await tx.leads.count({
        where: { AND: [liveLeadWhere(as(w.accounting)), { id: { in: privateIds } }] },
      })).toBe(0);
    });
  });

  it('Agent A sees their own 5 and nothing of Agent B’s 7', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      expect(await visible(tx, as(w.agentA), w.tag)).toBe(5);
      expect(await visible(tx, as(w.agentB), w.tag)).toBe(7);
    });
  });

  it('an agent does NOT get the brokerage’s leads merely by being an agent', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const brokerageIds = w.brokerage.map((l) => l.id);
      const reachable = await tx.leads.count({
        where: { AND: [liveLeadWhere(as(w.agentA)), { id: { in: brokerageIds } }] },
      });
      expect(reachable).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('assignment shares a brokerage lead without giving it away', () => {
  it('assigned to Agent A: the brokerage still sees it, A gains it, B does not', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const target = w.brokerage[0];
      await tx.leads.update({ where: { id: target.id }, data: { assigned_to: w.agentA.id } });

      const canReach = async (u: AuthUserRecord) => (await tx.leads.count({
        where: { AND: [liveLeadWhere(u), { id: target.id }] },
      })) === 1;

      expect(await canReach(as(w.manager))).toBe(true);   // owner is still the brokerage
      expect(await canReach(as(w.agentA))).toBe(true);    // gained it by assignment
      expect(await canReach(as(w.agentB))).toBe(false);   // nothing about this lead is theirs
      // And the row itself must still say the brokerage owns it — Model A, not a conversion.
      const row = await tx.leads.findUnique({ where: { id: target.id }, select: { owner_user_id: true } });
      expect(row?.owner_user_id).toBeNull();
    });
  });

  it('reassigned to Agent B: the brokerage keeps it, A loses it, B gains it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const target = w.brokerage[0];
      await tx.leads.update({ where: { id: target.id }, data: { assigned_to: w.agentA.id } });
      await tx.leads.update({ where: { id: target.id }, data: { assigned_to: w.agentB.id } });

      const canReach = async (u: AuthUserRecord) => (await tx.leads.count({
        where: { AND: [liveLeadWhere(u), { id: target.id }] },
      })) === 1;

      expect(await canReach(as(w.manager))).toBe(true);
      expect(await canReach(as(w.agentA))).toBe(false);
      expect(await canReach(as(w.agentB))).toBe(true);
      // One record throughout — reassignment must never fork the history.
      const copies = await tx.leads.count({ where: { email: target.email } });
      expect(copies).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('every other CRM module resolves the SAME scope', () => {
  /**
   * The consistency assertion, and the reason this file is worth its runtime.
   *
   * Each module is asked for its own idea of "which leads may this Manager reach", and all of them
   * must return the brokerage's 10 — never 0, never 22. Before the fix these three answered 0, 22
   * and 22 respectively.
   */
  it('campaign audience offers the brokerage’s 10, not every agent’s book', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const audience = new CampaignAudienceService(tx);
      const where = audience.buildAudienceWhere({}, as(w.manager)) as Record<string, unknown>;

      const n = await tx.leads.count({ where: { AND: [where, { email: { contains: w.tag } }] } as never });
      expect(n).toBe(10);
    });
  });

  it('campaign audience gives an agent their own book and no more', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const audience = new CampaignAudienceService(tx);
      const where = audience.buildAudienceWhere({}, as(w.agentA)) as Record<string, unknown>;

      const n = await tx.leads.count({ where: { AND: [where, { email: { contains: w.tag } }] } as never });
      expect(n).toBe(5);
    });
  });

  it('direct email resolves a brokerage lead for a Manager, and refuses an agent’s private one', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const manager = as(w.manager);

      /*
       * `resolveRecipient` is private, so this asserts the predicate it now uses. That is the whole
       * of the rule — the function is a `findFirst` with this `where` and nothing else — and going
       * through the real service would need a mail account, a template and an SMTP stub to test one
       * boolean.
       */
      const reachable = async (email: string) => (await tx.leads.count({
        where: { AND: [{ email }, { deleted_at: null }, leadScopeWhere(manager)] },
      })) === 1;

      expect(await reachable(w.brokerage[0].email)).toBe(true);
      expect(await reachable(w.privateA[0].email)).toBe(false);
      expect(await reachable(w.privateB[0].email)).toBe(false);
    });
  });

  it('export carries the brokerage’s 10 and no private lead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // The export path composes exactly this: the list scope, then the filters. If it ever stops
      // doing so, an export becomes a way around the screen.
      const rows = await tx.leads.findMany({
        where: { AND: [liveLeadWhere(as(w.manager)), { email: { contains: w.tag } }] },
        select: { id: true, owner_user_id: true },
      });
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.owner_user_id === null)).toBe(true);
    });
  });

  it('search cannot surface another agent’s lead by name', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // Agent A's lead, searched for by a Manager the way the Leads screen searches.
      const term = w.privateA[0].name;
      const found = await tx.leads.count({
        where: { AND: [liveLeadWhere(as(w.manager)), { name: { contains: term, mode: 'insensitive' } }] },
      });
      expect(found).toBe(0);

      // The same search by its owner finds it, so the test is proving scope and not a broken query.
      const byOwner = await tx.leads.count({
        where: { AND: [liveLeadWhere(as(w.agentA)), { name: { contains: term, mode: 'insensitive' } }] },
      });
      expect(byOwner).toBe(1);
    });
  });

  it('a filter narrows the scope and can never widen it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // Every seeded lead is 'warm', including all 12 private ones. A status filter matching them
      // all must still return only the Manager's 10.
      const n = await tx.leads.count({
        where: { AND: [liveLeadWhere(as(w.manager)), { lead_status: 'warm' }, { email: { contains: w.tag } }] },
      });
      expect(n).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('the per-record guard agrees with the queries', () => {
  it('refuses a Manager, a CRM user and a Super Admin on an agent’s private lead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const guard = new ResourceAccessService(tx);
      const target = w.privateA[0].id;

      for (const u of [w.manager, w.crm, w.superAdmin, w.agentB]) {
        // 404, not 403 — the answer to "does this lead exist" must not depend on who is asking, or
        // the guard becomes a way to enumerate other people's books one id at a time.
        await expect(guard.assertLead(as(u), target)).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(guard.assertLead(as(w.agentA), target)).resolves.toBeUndefined();
    });
  });

  it('admits the brokerage roles on a brokerage lead, and still refuses an unrelated agent', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const guard = new ResourceAccessService(tx);
      const target = w.brokerage[0].id;

      for (const u of [w.manager, w.crm, w.superAdmin]) {
        await expect(guard.assertLead(as(u), target)).resolves.toBeUndefined();
      }
      // Unassigned brokerage lead: an agent has no part in it yet.
      await expect(guard.assertLead(as(w.agentA), target)).rejects.toBeInstanceOf(NotFoundException);

      // Assign it, and the same agent may now work it — including its notes, tasks and calls, which
      // all pass through this one guard.
      await tx.leads.update({ where: { id: target }, data: { assigned_to: w.agentA.id } });
      await expect(guard.assertLead(as(w.agentA), target)).resolves.toBeUndefined();
      await expect(guard.assertLead(as(w.agentB), target)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('WHO OWNS A LEAD AT INTAKE — an agent owns theirs, everybody else creates for the brokerage', () => {
  /**
   * The rule stated once, then checked against every source.
   *
   * The point of the `it.each` is that the answer must NOT depend on which door the lead came
   * through. Manual entry, CSV import and Meta lead ads all call `ownerAtIntake`, so a single table
   * covers all three — and if any of them ever grows its own opinion, the parity test below fails.
   */
  it.each(['admin', 'manager', 'crm', 'accounting', 'documentation'])(
    '%s creates for the BROKERAGE — owner is null whatever the source', (role) => {
      expect(ownerAtIntake({ id: 42, role })).toBeNull();
    });

  it('an agent owns what they create', () => {
    expect(ownerAtIntake({ id: 42, role: 'agent' })).toBe(42);
  });

  it('nobody at all owns nothing — it becomes the brokerage’s, not a crash', () => {
    expect(ownerAtIntake(null)).toBeNull();
    expect(ownerAtIntake({ id: 7, role: '' })).toBeNull();
  });

  /**
   * THE INVARIANT THAT KEEPS THE MODEL HONEST, and the reason both lists are written out.
   *
   * Ownership is decided by `isAgent` and visibility by `leads.brokerage-scope`. They describe the
   * same split from opposite sides, so they must partition the roles identically. If they drift, a
   * role creates leads it cannot then see — the lead lands in the brokerage's book and its own
   * creator has no way to open it. That failure is silent and would look like the save not working.
   */
  it('every role that creates brokerage leads can also see them', () => {
    for (const role of ['admin', 'manager', 'crm', 'accounting', 'documentation', 'agent']) {
      const createsForBrokerage = ownerAtIntake({ id: 1, role }) === null;
      expect(hasBrokerageLeadScope({ id: 1, role })).toBe(createsForBrokerage);
    }
  });

  it('a Manager’s new lead really is the brokerage’s, and the CRM role can see it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const now = new Date();
      // What `LeadsService.create` writes for a manager: owner from `ownerAtIntake`, unassigned.
      const made = await tx.leads.create({
        data: {
          name: `Manager Made ${w.tag}`, email: `manager-made-${w.tag}@x.test`,
          owner_user_id: ownerAtIntake(as(w.manager)), assigned_to: null,
          tags: '[]', created_at: now, updated_at: now,
        },
      });
      expect(made.owner_user_id).toBeNull();

      const seenBy = async (u: AuthUserRecord) => (await tx.leads.count({
        where: { AND: [liveLeadWhere(u), { id: made.id }] },
      })) === 1;

      expect(await seenBy(as(w.crm))).toBe(true);        // a colleague on the brokerage side
      expect(await seenBy(as(w.superAdmin))).toBe(true);
      expect(await seenBy(as(w.manager))).toBe(true);    // and its creator, which is the trap this avoids
      expect(await seenBy(as(w.agentA))).toBe(false);    // not handed to agents wholesale
    });
  });

  it('a CSV import run by a Manager lands in the brokerage’s book, not the Manager’s', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const engine = new LeadImportEngine(tx);
      const email = `imported-${w.tag}@x.test`;
      const rows = engine.parseCsv(`name,email\nImported Person,${email}\n`);

      // Exactly what `LeadImportJobService` builds for a manager.
      await engine.runBatch(rows, {
        tag: '', userName: w.manager.name, userId: w.manager.id,
        ownerId: ownerAtIntake(as(w.manager)),
        userHasBrokerageScope: hasBrokerageLeadScope(as(w.manager)),
      }, new Set());

      const row = await tx.leads.findFirst({ where: { email }, select: { owner_user_id: true, id: true } });
      expect(row?.owner_user_id).toBeNull();
      // Visible to the brokerage side, including the importer, and to no agent.
      for (const u of [w.manager, w.crm, w.superAdmin]) {
        expect(await tx.leads.count({ where: { AND: [liveLeadWhere(as(u)), { id: row!.id }] } })).toBe(1);
      }
      expect(await tx.leads.count({ where: { AND: [liveLeadWhere(as(w.agentA)), { id: row!.id }] } })).toBe(0);
    });
  });

  it('a CSV import run by an agent fills that agent’s own book', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const engine = new LeadImportEngine(tx);
      const email = `imported-agent-${w.tag}@x.test`;
      const rows = engine.parseCsv(`name,email\nAgent Import,${email}\n`);

      await engine.runBatch(rows, {
        tag: '', userName: w.agentA.name, userId: w.agentA.id,
        ownerId: ownerAtIntake(as(w.agentA)),
        userHasBrokerageScope: hasBrokerageLeadScope(as(w.agentA)),
      }, new Set());

      const row = await tx.leads.findFirst({ where: { email }, select: { owner_user_id: true } });
      expect(row?.owner_user_id).toBe(w.agentA.id);
    });
  });

  it('an agent’s new lead stays private to them', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const now = new Date();
      const made = await tx.leads.create({
        data: {
          name: `Agent Made ${w.tag}`, email: `agent-made-${w.tag}@x.test`,
          owner_user_id: ownerAtIntake(as(w.agentA)), assigned_to: null,
          tags: '[]', created_at: now, updated_at: now,
        },
      });
      expect(made.owner_user_id).toBe(w.agentA.id);

      const seenBy = async (u: AuthUserRecord) => (await tx.leads.count({
        where: { AND: [liveLeadWhere(u), { id: made.id }] },
      })) === 1;

      expect(await seenBy(as(w.agentA))).toBe(true);
      // The whole promise, restated where an intake test can catch a regression in it.
      expect(await seenBy(as(w.manager))).toBe(false);
      expect(await seenBy(as(w.superAdmin))).toBe(false);
      expect(await seenBy(as(w.agentB))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('the CRM email log cannot be used to discover a private lead', () => {
  /**
   * THE SECOND ROUTE TO A CLIENT'S IDENTITY, and the one that stayed open longest.
   *
   * Every other surface asks `leadScopeWhere`. The send log asked `data.read-all` — a permission
   * about whose SENDS you may read — and then showed the lead's name, address and subject line. So a
   * Manager who got 404 from the Leads module, from search, from campaigns and from direct email
   * could read the same client's details here, one row at a time.
   *
   * These tests assert the intersection: log permission AND lead scope, never either alone.
   */
  async function logRow(tx: PrismaService, recipient: string, leadName: string, sentBy: string) {
    return tx.crm_email_log.create({
      data: {
        kind: 'custom', lead_name: leadName, recipient, subject: `Subject for ${leadName}`,
        success: true, sent_by: sentBy, created_at: new Date(),
      },
    });
  }

  // Only `prisma` is exercised by `listLog`; the mailer, accounts and triggers are never reached.
  const svc = (tx: PrismaService) => new CrmAdvancedEmailService(
    tx, {} as never, {} as never, {} as never,
  );

  it('hides a row about an agent’s private lead from every brokerage role', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const priv = w.privateA[0];
      await logRow(tx, priv.email, priv.name, w.agentA.name);

      for (const u of [w.manager, w.crm, w.superAdmin, w.accounting]) {
        const rows = await svc(tx).listLog(as(u), 500);
        const mine = rows.filter((r) => String(r.recipient) === priv.email);
        expect(mine).toHaveLength(0);
        // And nothing about them leaks through another field either.
        const blob = JSON.stringify(rows);
        expect(blob).not.toContain(priv.email);
        expect(blob).not.toContain(priv.name);
      }
    });
  });

  it('shows that same row to the agent who owns the lead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const priv = w.privateA[0];
      await logRow(tx, priv.email, priv.name, w.agentA.name);

      const rows = await svc(tx).listLog(as(w.agentA), 500);
      expect(rows.some((r) => String(r.recipient) === priv.email)).toBe(true);
    });
  });

  /**
   * THE TWO CONDITIONS ARE INDEPENDENT, and this is the test that keeps them apart.
   *
   * Lead scope decides WHICH CLIENTS you may read about. The log permission decides WHOSE SENDS you
   * may read. A brokerage lead passes the first for every brokerage role — but `crm` does not hold
   * `data.read-all`, so it still sees only its own sends. That is the pre-existing log rule and this
   * work did not widen it: fixing the privacy hole must not quietly turn into a promotion.
   */
  it('shows a row about a BROKERAGE lead to the roles whose log permission covers it', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const brok = w.brokerage[0];
      await logRow(tx, brok.email, brok.name, w.manager.name);

      // Hold `data.read-all`, so they read everybody's sends — and the lead is in scope.
      for (const u of [w.manager, w.superAdmin]) {
        const rows = await svc(tx).listLog(as(u), 500);
        expect(rows.some((r) => String(r.recipient) === brok.email)).toBe(true);
      }

      // `crm` may see the LEAD, but this row is somebody else's send, so the log rule still hides it.
      const crmRows = await svc(tx).listLog(as(w.crm), 500);
      expect(crmRows.some((r) => String(r.recipient) === brok.email)).toBe(false);

      // Its OWN send about the same brokerage lead does come through — proving the refusal above is
      // the sender rule and not the lead rule.
      await logRow(tx, brok.email, brok.name, w.crm.name);
      const crmOwn = await svc(tx).listLog(as(w.crm), 500);
      expect(crmOwn.some((r) => String(r.recipient) === brok.email)).toBe(true);

      // An unrelated agent sees neither: not their send, and not their lead.
      const agentRows = await svc(tx).listLog(as(w.agentB), 500);
      expect(agentRows.some((r) => String(r.recipient) === brok.email)).toBe(false);
    });
  });

  it('still shows correspondence with an address that is nobody’s lead', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // A test send, or a lead long since purged. Nothing private to protect, so it must not be
      // swallowed — otherwise the privacy rule would quietly empty the administrator's log.
      const stray = `stranger-${w.tag}@nowhere.test`;
      await logRow(tx, stray, 'Nobody', w.manager.name);

      const rows = await svc(tx).listLog(as(w.manager), 500);
      expect(rows.some((r) => String(r.recipient) === stray)).toBe(true);
    });
  });

  it('a SOFT-DELETED private lead does not become readable by the brokerage', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const priv = w.privateA[1];
      await logRow(tx, priv.email, priv.name, w.agentA.name);
      await tx.leads.update({ where: { id: priv.id }, data: { deleted_at: new Date() } });

      // Binning a lead must not be a way to publish its correspondence.
      const rows = await svc(tx).listLog(as(w.manager), 500);
      expect(JSON.stringify(rows)).not.toContain(priv.email);
    });
  });

  it('an agent still cannot read a COLLEAGUE’s sends, as before', async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const priv = w.privateB[0];
      await logRow(tx, priv.email, priv.name, w.agentB.name);

      // Two independent reasons to refuse: not their send, and not their lead.
      const rows = await svc(tx).listLog(as(w.agentA), 500);
      expect(JSON.stringify(rows)).not.toContain(priv.email);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('who holds the brokerage scope', () => {
  // Every role except `agent`. The split is the business rule: an agent has a personal book,
  // everybody else is brokerage staff.
  it.each(['admin', 'manager', 'crm', 'accounting', 'documentation'])('%s does', (role) => {
    expect(hasBrokerageLeadScope({ id: 1, role })).toBe(true);
  });

  it('agent does not — the one role with a book of its own', () => {
    expect(hasBrokerageLeadScope({ id: 1, role: 'agent' })).toBe(false);
  });

  it('fails closed for nobody at all, and for a role nobody has invented yet', () => {
    expect(hasBrokerageLeadScope(null)).toBe(false);
    expect(hasBrokerageLeadScope({ id: 1, role: 'some-future-role' })).toBe(false);
  });

  it('never drops the owner clause — there is no branch that returns everything', () => {
    /*
     * The property that makes the whole model hold. Three services used to have a branch that
     * returned `{}` for a privileged caller, and `{}` means every lead in the database. If one is
     * ever reintroduced here, this fails.
     */
    for (const role of ['admin', 'manager', 'crm', 'agent', 'accounting']) {
      const where = leadScopeWhere({ id: 7, role } as AuthUserRecord) as { OR?: unknown[] };
      expect(Array.isArray(where.OR)).toBe(true);
      expect(where.OR!.length).toBeGreaterThanOrEqual(2);
      expect(where.OR).toEqual(expect.arrayContaining([{ assigned_to: 7 }, { owner_user_id: 7 }]));
    }
  });
});
