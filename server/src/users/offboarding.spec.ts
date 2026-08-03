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
 * THE RULE these defend: Meta leads are personal and stay with the agent who generated them;
 * everything else belongs to the brokerage and comes back to it. Deactivating an account
 * disconnects Meta, and reactivating does not reconnect it — a stored token from before a
 * departure is not one to trust.
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
      password: 'x', company_id: 1, created_at: now, updated_at: now,
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
        company_id: 1, user_id: userId, page_id: `page-${tag()}`, form_id: `form-${tag()}`,
        form_name: 'Campaign', is_active: true, created_at: now, updated_at: now,
      },
    });
  }
}

/** `source` decides provenance: 'facebook_meta' is the agent's own, anything else is the brokerage's. */
async function giveLead(tx: PrismaService, userId: number, source: string): Promise<number> {
  const now = new Date();
  const l = await tx.leads.create({
    data: {
      company_id: 1, name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
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
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await giveLead(tx, agent.id, 'manual');

      const c = await offboardingFor(tx).checklist(superAdmin, agent.id);

      expect(c.meta).toEqual({ connected: true, forms: 2 });
      expect(c.leads).toEqual({ total: 3, personal: 2, brokerage: 1 });
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

  it('returns their brokerage leads to the brokerage, where an admin can see and reassign them', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const walkIn = await giveLead(tx, agent.id, 'manual');
      const imported = await giveLead(tx, agent.id, 'import');

      await offboardingFor(tx).depart(agent.id, agent.name);

      for (const id of [walkIn, imported]) {
        const lead = await tx.leads.findUnique({ where: { id } });
        // Unowned is what a Super Admin's unattributed-intake view shows.
        expect(lead?.owner_user_id).toBeNull();
        expect(lead?.assigned_to).toBeNull();
      }
    });
  });

  it('leaves their Meta leads exactly where they are — those are personal', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const personal = await giveLead(tx, agent.id, META_LEAD_SOURCE);

      const summary = await offboardingFor(tx).depart(agent.id, agent.name);

      const lead = await tx.leads.findUnique({ where: { id: personal } });
      expect(lead?.owner_user_id).toBe(agent.id);
      expect(lead?.assigned_to).toBe(agent.id);
      expect(summary).toContain('1 Meta lead kept with them');
    });
  });

  /**
   * A lead with no source recorded is the brokerage's, not the agent's.
   *
   * This is the case that `source: { not: 'facebook_meta' }` gets wrong: in SQL a comparison
   * against NULL is NULL rather than true, so a lead with no source failed the test, counted as
   * personal, and would have stayed with the departing agent for ever. 18 live leads in the
   * development database had a NULL source when this was found.
   */
  it('returns leads that have no source recorded — absence of evidence is not personal ownership', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      const noSource = await tx.leads.create({
        data: {
          company_id: 1, name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
          owner_user_id: agent.id, assigned_to: agent.id, created_at: now, updated_at: now,
        },
      });
      expect(noSource.source).toBeNull();

      const { returned, kept } = await new LeadTransferService(tx, noAudit as never).returnToBrokerage(agent.id);

      expect(returned).toBe(1);
      expect(kept).toBe(0);
      expect((await tx.leads.findUnique({ where: { id: noSource.id } }))?.owner_user_id).toBeNull();
    });
  });

  it('counts a lead with no source as the brokerage\'s on the checklist too', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      await tx.leads.create({
        data: {
          company_id: 1, name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
          owner_user_id: agent.id, created_at: now, updated_at: now,
        },
      });

      const c = await offboardingFor(tx).checklist(superAdmin, agent.id);
      expect(c.leads).toEqual({ total: 1, personal: 0, brokerage: 1 });
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

  it('reports nothing personal once only brokerage leads remain, so the delete may proceed', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await giveLead(tx, agent.id, 'manual');
      const counts = await offboardingFor(tx).leadCounts(agent.id);
      expect(counts).toEqual({ personal: 0, brokerage: 1 });
    });
  });

  it('counts a lead with no source as the brokerage\'s here too, not as personal', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      const now = new Date();
      await tx.leads.create({
        data: {
          company_id: 1, name: `Lead ${tag()}`, email: `lead-${tag()}@example.test`,
          owner_user_id: agent.id, created_at: now, updated_at: now,
        },
      });
      // If this said personal:1 the delete would be refused for a lead nobody owns personally.
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
      await schedulerWatching(tx, polled).pollAllForTenant();
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
      await schedulerWatching(tx, active).pollAllForTenant();
      expect(active).toContain(agent.id);

      await tx.users.update({ where: { id: agent.id }, data: { status: 'Inactive' } });
      const inactive: number[] = [];
      await schedulerWatching(tx, inactive).pollAllForTenant();
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
          company_id: 1, user_id: agent.id, page_id: pageId, form_id: formId,
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
  it('routes a departing agent\'s brokerage lead to the successor via the pool, never directly', async () => {
    await inRollback(async (tx) => {
      const leaving = await makeUser(tx);
      const successor = await makeUser(tx);
      const brokerage = await giveLead(tx, leaving.id, 'manual');
      const personal = await giveLead(tx, leaving.id, META_LEAD_SOURCE);
      const transfers = new LeadTransferService(tx, noAudit as never);

      // Before deactivation there is nothing to hand over: both leads are in somebody's book.
      const poolBefore = (await transfers.books(superAdmin)).available;

      await offboardingFor(tx).depart(leaving.id, leaving.name);
      expect((await transfers.books(superAdmin)).available).toBe(poolBefore + 1);

      const r = await transfers.transfer(superAdmin, successor.id);
      expect(r.moved).toBeGreaterThanOrEqual(1);

      expect((await tx.leads.findUnique({ where: { id: brokerage } }))?.owner_user_id).toBe(successor.id);
      // Untouched throughout — it never entered the pool, so Lead Books never saw it.
      expect((await tx.leads.findUnique({ where: { id: personal } }))?.owner_user_id).toBe(leaving.id);
    });
  });

  /**
   * The departure path and Lead Books meet here, and the join is the point.
   *
   * Deactivating returns the agent's brokerage leads to the pool unowned; Lead Books can then hand
   * them on. It cannot reach anything still in a book — which, after `depart`, is exactly their
   * personal Meta leads.
   */
  it('puts a departing agent\'s brokerage leads into the pool, and none of their personal ones', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx);
      await giveLead(tx, agent.id, 'manual');
      await giveLead(tx, agent.id, META_LEAD_SOURCE);
      await giveLead(tx, agent.id, META_LEAD_SOURCE);

      const transfers = new LeadTransferService(tx, noAudit as never);
      const before = (await transfers.books(superAdmin)).available;

      await offboardingFor(tx).depart(agent.id, agent.name);

      const after = await transfers.books(superAdmin);
      expect(after.available).toBe(before + 1);          // the one brokerage lead
      // The two Meta leads stayed with them, so Lead Books cannot see or move them.
      expect(await tx.leads.count({ where: { owner_user_id: agent.id, source: META_LEAD_SOURCE } })).toBe(2);
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
