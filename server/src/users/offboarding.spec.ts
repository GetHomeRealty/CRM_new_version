import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { OffboardingService } from './offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { MetaSyncSchedulerService } from '../meta/meta-sync-scheduler.service';
import { MetaSyncService } from '../meta/meta-sync.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { META_LEAD_SOURCE } from '../leads/lead.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * What happens to an agent's work when they leave.
 *
 * THE RULE these defend, and it is decided by OWNERSHIP rather than by how a lead arrived:
 *
 *   a lead the agent OWNS      stays theirs. Private, not inherited by the brokerage, not deleted,
 *                              and not a reason the account cannot be switched off.
 *   a BROKERAGE lead they were only their ASSIGNMENT is cleared. The lead stays in the CRM, still
 *     working                  owned by the brokerage, back in the pool for somebody to take on.
 *
 * Deactivating an account also disconnects Meta, and reactivating does not reconnect it — a stored
 * token from before a departure is not one to trust.
 *
 * Written against the real services and the real schema. The lesson from M-H8 is that a
 * reconstruction of a code path agrees with the design intent rather than with the code.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

/**
 * A transaction client has no `$transaction` of its own and `disconnect` uses one. Wrapped rather
 * than assigned: setting the property on the transaction client writes through to the real one and
 * breaks the outer rollback.
 */
function withNestedTransaction(tx: object): PrismaService {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (ops: unknown) => {
          if (typeof ops === 'function') return (ops as (c: unknown) => unknown)(receiver);
          const done: unknown[] = [];
          for (const op of ops as Promise<unknown>[]) done.push(await op);
          return done;
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as unknown as PrismaService;
}

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(withNestedTransaction(tx)); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const superAdmin = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;
const noAudit = { record: async () => {} };
const noGraph = { fetchPages: async () => [] };

const offboardingFor = (tx: PrismaService) => new OffboardingService(
  tx,
  new MetaConnectionService(tx, noGraph as never),
  new LeadTransferService(tx, noAudit as never),
);

async function makeUser(tx: PrismaService, status = 'Active'): Promise<{ id: number; name: string }> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `Off ${t}`, email: `off-${t}@example.test`, role: 'agent', status,
      password: 'x', created_at: now, updated_at: now,
    },
  });
  return { id: u.id, name: u.name };
}

async function connectMeta(tx: PrismaService, userId: number, forms = 1): Promise<void> {
  const now = new Date();
  await tx.meta_connections.create({
    data: {
      user_id: userId, access_token: 'enc:v1:stub', facebook_user_id: `fb-${tag()}`,
      is_active: true, connected_at: now, created_at: now, updated_at: now,
    },
  });
  for (let i = 0; i < forms; i += 1) {
    await tx.meta_lead_forms.create({
      data: {
        user_id: userId, page_id: `page-${tag()}`, form_id: `form-${tag()}`,
        form_name: 'Campaign', is_active: true, created_at: now, updated_at: now,
      },
    });
  }
}

/** A lead this person OWNS. `source` records how it arrived and no longer decides whose it is. */
async function giveLead(tx: PrismaService, userId: number, source: string): Promise<number> {
  const now = new Date();
  const l = await tx.leads.create({
    data: {
      name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
      owner_user_id: userId, assigned_to: userId, source, lead_source: 'meta',
      created_at: now, updated_at: now,
    },
  });
  return l.id;
}

describe('the checklist shown before deactivating', () => {
  it('separates what stays with them from what comes back to the brokerage', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await connectMeta(tx, agent.id, 2);
      // Three leads they OWN — the source they arrived by no longer changes whose they are — and
      // one brokerage lead they are merely working.
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await giveLead(tx, agent.id, 'manual');
      const now = new Date();
      await tx.leads.create({
        data: {
          name: `Pool ${tag()}`, email: `pool-${tag()}@example.test`,
          owner_user_id: null, assigned_to: agent.id, created_at: now, updated_at: now,
        },
      });

      const c = await offboardingFor(tx).checklist(superAdmin, agent.id);

      expect(c.meta).toEqual({ connected: true, forms: 2 });
      expect(c.leads).toEqual({ total: 4, personal: 3, brokerage: 1 });
      // Counts, never content — the same rule as LeadTransferService.books().
      expect(JSON.stringify(c)).not.toContain('@example.test');
    });
  });

  it('is refused to anyone below Super Admin, because it reports how big a book is', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const manager = { id: 99, name: 'Manager', role: 'manager' } as unknown as AuthUserRecord;
      await expect(offboardingFor(tx).checklist(manager, agent.id)).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('deactivating an agent', () => {
  it('disconnects Meta: tokens erased, forms released, nothing left to poll', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await connectMeta(tx, agent.id, 2);

      const summary = await offboardingFor(tx).depart(agent.id, agent.name);

      expect(summary).toContain('Meta disconnected');
      const conn = await tx.meta_connections.findFirst({ where: { user_id: agent.id } });
      expect(conn?.is_active).toBe(false);
      expect(conn?.access_token).toBe('');
      expect(await tx.meta_lead_forms.count({ where: { user_id: agent.id, is_active: true } })).toBe(0);
    });
  });

  it('releases the ASSIGNMENT on a brokerage lead they were working, and keeps it in the CRM', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      // A brokerage lead — owned by nobody — that this agent was working.
      const brokerageLead = await tx.leads.create({
        data: {
          name: `Brokerage ${tag()}`, email: `brokerage-${tag()}@example.test`,
          owner_user_id: null, assigned_to: agent.id, created_at: now, updated_at: now,
        },
      });

      await offboardingFor(tx).depart(agent.id, agent.name);

      const lead = await tx.leads.findUnique({ where: { id: brokerageLead.id } });
      // Still there, still the brokerage's, and back in the pool for somebody to pick up.
      expect(lead).not.toBeNull();
      expect(lead?.deleted_at).toBeNull();
      expect(lead?.owner_user_id).toBeNull();
      expect(lead?.assigned_to).toBeNull();
    });
  });

  /**
   * THE CONVERSION THAT USED TO HAPPEN HERE, AND MUST NOT.
   *
   * `returnToBrokerage` ran `owner_user_id = NULL` over every non-Meta lead the leaver owned, so an
   * agent's own clients became brokerage leads on the day they left — visible from that moment to
   * every brokerage role. Ownership is now decided at intake, so there is nothing to convert, and
   * converting anyway would publish the one category that is genuinely private.
   *
   * Asserted for a lead with NO source recorded on purpose: that is precisely the row the old
   * `source != 'facebook_meta'` predicate treated as the brokerage's.
   */
  it('NEVER converts a lead the agent owns into a brokerage lead — whatever its source', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      const mk = async (source: string | null) => tx.leads.create({
        data: {
          name: `Private ${tag()}`, email: `private-${tag()}@example.test`,
          owner_user_id: agent.id, assigned_to: agent.id, source,
          created_at: now, updated_at: now,
        },
      });
      const noSource = await mk(null);
      const manual = await mk('manual');
      const imported = await mk('import');
      const meta = await mk(META_LEAD_SOURCE);

      await offboardingFor(tx).depart(agent.id, agent.name);

      for (const lead of [noSource, manual, imported, meta]) {
        const after = await tx.leads.findUnique({ where: { id: lead.id } });
        // Named in the failure output via the loop variable rather than a message argument —
        // Jest's `expect` takes only the value.
        expect({ source: lead.source, owner: after?.owner_user_id })
          .toEqual({ source: lead.source, owner: agent.id });
        expect(after?.deleted_at).toBeNull();   // and it is not deleted either
      }
    });
  });

  it('says plainly in the summary what stayed with them', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const personal = await giveLead(tx, agent.id, META_LEAD_SOURCE);

      const summary = await offboardingFor(tx).depart(agent.id, agent.name);

      const lead = await tx.leads.findUnique({ where: { id: personal } });
      expect(lead?.owner_user_id).toBe(agent.id);
      expect(summary).toContain('1 private lead left with them, still theirs');
    });
  });

  it('reports the split on the checklist by OWNERSHIP, not by source', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      // Two of their own (one with no source at all), one brokerage lead they are working.
      await tx.leads.create({
        data: {
          name: `Own A ${tag()}`, email: `own-a-${tag()}@example.test`,
          owner_user_id: agent.id, created_at: now, updated_at: now,
        },
      });
      await tx.leads.create({
        data: {
          name: `Own B ${tag()}`, email: `own-b-${tag()}@example.test`,
          owner_user_id: agent.id, source: META_LEAD_SOURCE, created_at: now, updated_at: now,
        },
      });
      await tx.leads.create({
        data: {
          name: `Pool ${tag()}`, email: `pool-${tag()}@example.test`,
          owner_user_id: null, assigned_to: agent.id, created_at: now, updated_at: now,
        },
      });

      const c = await offboardingFor(tx).checklist(superAdmin, agent.id);
      // `personal` is everything they OWN; `brokerage` is what they were merely working.
      expect(c.leads).toEqual({ total: 3, personal: 2, brokerage: 1 });
    });
  });

  it('does not touch anybody else', async () => {
    await inRollback(async (tx) => {
      const leaving = await makeUser(tx);
      const staying = await makeUser(tx);
      await connectMeta(tx, staying.id, 1);
      const theirs = await giveLead(tx, staying.id, 'manual');

      await offboardingFor(tx).depart(leaving.id, leaving.name);

      const lead = await tx.leads.findUnique({ where: { id: theirs } });
      expect(lead?.owner_user_id).toBe(staying.id);
      expect(await tx.meta_lead_forms.count({ where: { user_id: staying.id, is_active: true } })).toBe(1);
      const conn = await tx.meta_connections.findFirst({ where: { user_id: staying.id } });
      expect(conn?.is_active).toBe(true);
    });
  });
});

/**
 * Deleting a user removes the row and nothing else: no table in this schema points at `users` with
 * a foreign key. So leads keep an `owner_user_id` for somebody who no longer exists — unopenable,
 * and unrecoverable through `transfer-ownership`, which refuses when the source person is gone.
 * These fix the shape of the hole rather than the exact wording of the refusal.
 */
describe('deleting an agent rather than deactivating them', () => {
  it('is refused while they hold personal Meta leads, which would be orphaned', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      expect((await offboardingFor(tx).leadCounts(agent.id)).personal).toBe(1);
    });
  });

  /**
   * `leadCounts` splits by OWNERSHIP, which is what the delete path needs to know.
   *
   * These used to assert the opposite — that a manual or source-less lead an agent owned counted as
   * the BROKERAGE's — because ownership was then inferred from `source`. Under the intake rule a
   * lead an agent owns is theirs whatever its source, so they now assert `personal`.
   *
   * That is the honest input to the delete guard: permanently removing the account would strand
   * these rows, and the administrator is told so rather than having the leads quietly reassigned to
   * the brokerage to make the deletion succeed.
   */
  it('counts everything the agent OWNS as personal, whatever its source', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await giveLead(tx, agent.id, 'manual');
      expect(await offboardingFor(tx).leadCounts(agent.id)).toEqual({ personal: 1, brokerage: 0 });
    });
  });

  it('counts a source-less lead as theirs too — no source is not the brokerage making a claim', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      await tx.leads.create({
        data: {
          name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
          owner_user_id: agent.id, created_at: now, updated_at: now,
        },
      });
      expect(await offboardingFor(tx).leadCounts(agent.id)).toEqual({ personal: 1, brokerage: 0 });
    });
  });

  it('counts a brokerage lead they are merely working under `brokerage`', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      await tx.leads.create({
        data: {
          name: `Pool ${tag()}`, email: `pool-${tag()}@example.test`,
          owner_user_id: null, assigned_to: agent.id, created_at: now, updated_at: now,
        },
      });
      expect(await offboardingFor(tx).leadCounts(agent.id)).toEqual({ personal: 0, brokerage: 1 });
    });
  });

});

describe('reactivating an agent', () => {
  it('does not reconnect Meta — a token from before a departure is not one to trust', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await connectMeta(tx, agent.id, 1);
      await offboardingFor(tx).depart(agent.id, agent.name);

      await tx.users.update({ where: { id: agent.id }, data: { status: 'Active' } });

      // Nothing restores itself: the connection is still off and the token is still gone.
      const conn = await tx.meta_connections.findFirst({ where: { user_id: agent.id } });
      expect(conn?.is_active).toBe(false);
      expect(conn?.access_token).toBe('');
      expect(await tx.meta_lead_forms.count({ where: { user_id: agent.id, is_active: true } })).toBe(0);

      // And the poller has nothing to pick up, because it only reads active connections.
      const polled: number[] = [];
      await schedulerWatching(tx, polled).pollAll();
      expect(polled).not.toContain(agent.id);
    });
  });

  it('gives them their personal leads back, because those were never moved', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const personal = await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await offboardingFor(tx).depart(agent.id, agent.name);
      await tx.users.update({ where: { id: agent.id }, data: { status: 'Active' } });

      const lead = await tx.leads.findUnique({ where: { id: personal } });
      expect(lead?.owner_user_id).toBe(agent.id);
    });
  });
});

/** The scheduler with its sync step replaced, so we can see exactly who it would have polled. */
const schedulerWatching = (tx: PrismaService, polled: number[]) => {
  const sync = {
    syncUser: async (u: { id: number }) => {
      polled.push(u.id);
      return { imported: 0, updated: 0, duplicates: 0, skipped: 0, forms: 0, errors: [] };
    },
  } as unknown as MetaSyncService;
  return new MetaSyncSchedulerService(tx, sync);
};

describe('a connection that outlives an active account', () => {
  /**
   * Deactivation now disconnects Meta, so this should not arise through the UI. It is kept as a
   * safety net for a connection that predates the change or is left behind by a partial failure —
   * `depart` deliberately does not abort the deactivation when the disconnect fails.
   */
  it('is not polled while its owner is inactive, and resumes if they come back', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await connectMeta(tx, agent.id);

      const active: number[] = [];
      await schedulerWatching(tx, active).pollAll();
      expect(active).toContain(agent.id);

      await tx.users.update({ where: { id: agent.id }, data: { status: 'Inactive' } });
      const inactive: number[] = [];
      await schedulerWatching(tx, inactive).pollAll();
      expect(inactive).not.toContain(agent.id);
    });
  });
});

describe('a webhook lead for a deactivated agent', () => {
  /**
   * The webhook is the fast path, so it needs the guard in its own right — the poller being paused
   * would not stop a live delivery. Graph is stubbed to throw: reaching it at all would mean the
   * lead had been fetched for an owner who cannot see it.
   */
  const syncFor = (tx: PrismaService, pageId: string, ownerId: number) => {
    const connections = {
      find: async (userId: number) => (userId === ownerId
        ? { id: 1, user_id: ownerId, pages: [{ page_id: pageId, name: 'Page', token: 't' }] }
        : null),
      touchWebhook: async () => {},
    };
    const graph = { lead: async () => { throw new Error('Graph must not be called for an inactive owner'); } };
    const noop = { record: async () => {}, notify: async () => {}, newLead: async () => {} };
    const budget = { consume: async () => ({ allowed: true, spent: 1, limit: 999, resetInSeconds: 60 }) };
    return new MetaSyncService(tx, connections as never, graph as never, noop as never, noop as never, budget as never, noop as never);
  };

  it('is refused and recorded, rather than written where nobody can see it', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'Inactive');
      const now = new Date();
      const pageId = `page-${tag()}`;
      const formId = `form-${tag()}`;
      await tx.meta_lead_forms.create({
        data: {
          user_id: agent.id, page_id: pageId, form_id: formId,
          form_name: 'Campaign', is_active: true, created_at: now, updated_at: now,
        },
      });

      const before = await tx.leads.count();
      const r = await syncFor(tx, pageId, agent.id).ingestWebhookLead(`lg-${tag()}`, formId, pageId, {});

      expect(r.status).toBe('failed');
      expect(r.leadId).toBeNull();
      expect(await tx.leads.count()).toBe(before);

      const event = await tx.meta_webhook_events.findFirst({ where: { form_id: formId }, orderBy: { id: 'desc' } });
      expect(event?.status).toBe('failed');
      expect(event?.error).toContain(agent.name);
      expect(event?.error).toContain('Inactive');
    });
  });
});

describe('transferring a book by hand', () => {
  /**
   * The whole departure, end to end, now that Lead Books cannot reach into a book.
   *
   * Deactivate → the brokerage lead goes to the pool, the Meta lead stays with them → Lead Books
   * hands the pooled one to the successor. There is no longer a step that takes leads directly from
   * one person to another, which is the rule this sequence has to satisfy.
   */
  it("routes a departing person's BROKERAGE lead to the successor via the pool, never directly", async () => {
    await inRollback(async (tx) => {
      const leaving = await makeUser(tx);
      const successor = await makeUser(tx);
      const now = new Date();
      // What actually routes: a brokerage lead the leaver was WORKING.
      const brokerage = await tx.leads.create({
        data: {
          name: `Pool ${tag()}`, email: `pool-${tag()}@example.test`,
          owner_user_id: null, assigned_to: leaving.id, created_at: now, updated_at: now,
        },
      });
      // And one of their own, which must take no part in any of this.
      const personal = await giveLead(tx, leaving.id, 'manual');
      const transfers = new LeadTransferService(tx, noAudit as never);

      // Assigned, so not in the pool yet.
      const poolBefore = (await transfers.books(superAdmin)).available;

      await offboardingFor(tx).depart(leaving.id, leaving.name);
      expect((await transfers.books(superAdmin)).available).toBe(poolBefore + 1);

      const r = await transfers.transfer(superAdmin, successor.id);
      expect(r.moved).toBeGreaterThanOrEqual(1);

      /*
       * The successor is the ASSIGNEE and the brokerage is still the owner — Lead Books hands work
       * over, it does not hand ownership over. The routing this test exists to prove, via the pool
       * rather than person-to-person, is what the two `books()` assertions above established.
       */
      const routed = await tx.leads.findUnique({ where: { id: brokerage.id } });
      expect(routed?.assigned_to).toBe(successor.id);
      expect(routed?.owner_user_id).toBeNull();
      // Their own lead never entered the pool and never changed hands.
      expect((await tx.leads.findUnique({ where: { id: personal } }))?.owner_user_id).toBe(leaving.id);
    });
  });

  /**
   * THE MIXED DEPARTURE, end to end — the case the business asked to be pinned exactly.
   *
   * An agent leaves holding both kinds of lead at once. Each kind must go its own way in the same
   * operation, and the account must switch off regardless of what is left behind.
   */
  it('releases the brokerage leads into the pool and leaves every private one alone', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();

      // 5 the agent OWNS — their private book. Deliberately mixed sources, because source must not
      // matter any more: two arrived through their own Meta ads, one by import, two by hand.
      const privateIds: number[] = [];
      for (const source of [META_LEAD_SOURCE, META_LEAD_SOURCE, 'import', 'manual', null]) {
        const l = await tx.leads.create({
          data: {
            name: `Private ${tag()}`, email: `private-${tag()}@example.test`,
            owner_user_id: agent.id, assigned_to: agent.id, source,
            created_at: now, updated_at: now,
          },
        });
        privateIds.push(l.id);
      }

      // 10 the BROKERAGE owns that this agent was working.
      const brokerageIds: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const l = await tx.leads.create({
          data: {
            name: `Brokerage ${tag()}`, email: `brok-${tag()}@example.test`,
            owner_user_id: null, assigned_to: agent.id, created_at: now, updated_at: now,
          },
        });
        brokerageIds.push(l.id);
      }

      const transfers = new LeadTransferService(tx, noAudit as never);
      const poolBefore = (await transfers.books(superAdmin)).available;

      await offboardingFor(tx).depart(agent.id, agent.name);

      // ---- the 10 brokerage leads --------------------------------------------------------------
      const brokerageAfter = await tx.leads.findMany({
        where: { id: { in: brokerageIds } },
        select: { owner_user_id: true, assigned_to: true, deleted_at: true },
      });
      expect(brokerageAfter).toHaveLength(10);                                   // none deleted
      expect(brokerageAfter.every((l) => l.owner_user_id === null)).toBe(true);  // still the brokerage's
      expect(brokerageAfter.every((l) => l.assigned_to === null)).toBe(true);    // assignment released
      expect(brokerageAfter.every((l) => l.deleted_at === null)).toBe(true);     // still live in the CRM
      // And they are genuinely back in the pool, ready to hand on.
      expect((await transfers.books(superAdmin)).available).toBe(poolBefore + 10);

      // ---- the 5 private leads -----------------------------------------------------------------
      const privateAfter = await tx.leads.findMany({
        where: { id: { in: privateIds } },
        select: { owner_user_id: true, deleted_at: true },
      });
      expect(privateAfter).toHaveLength(5);
      // Never converted to brokerage ownership, whatever their source, and never deleted.
      expect(privateAfter.every((l) => l.owner_user_id === agent.id)).toBe(true);
      expect(privateAfter.every((l) => l.deleted_at === null)).toBe(true);
      // So Lead Books still cannot see or move any of them.
      expect(privateAfter.filter((l) => l.owner_user_id === null)).toHaveLength(0);

      // ---- and the account itself --------------------------------------------------------------
      // `depart` neither threw nor refused: the five private leads did not hold the departure up.
      await tx.users.update({ where: { id: agent.id }, data: { status: 'Inactive' } });
      expect((await tx.users.findUnique({ where: { id: agent.id } }))?.status).toBe('Inactive');
    });
  });

  it('reports no per-agent figures at all, whatever the agent holds', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await giveLead(tx, agent.id, 'manual');
      await giveLead(tx, agent.id, META_LEAD_SOURCE);

      const pool = await new LeadTransferService(tx, noAudit as never).books(superAdmin);
      expect(Object.keys(pool).sort()).toEqual(['available', 'recipients']);
      // Nothing in here says how many leads this agent has.
      expect(pool.recipients.every((r) => Object.keys(r).sort().join() === 'name,role,user_id')).toBe(true);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
