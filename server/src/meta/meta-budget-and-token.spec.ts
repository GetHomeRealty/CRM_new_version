import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaApiBudgetService } from './meta-api-budget.service';
import { MetaConnectionService } from './meta-connection.service';
import { MetaSyncService } from './meta-sync.service';
import { MetaSyncSchedulerService } from './meta-sync-scheduler.service';
import { GraphError } from './meta-graph.service';
import { META_BUDGET_PER_WINDOW } from './meta.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The two things that were left: a ceiling everybody shares, and a token that dies quietly.
 *
 * **The shared budget.** `META_SYNC_LIMIT` throttles one person's presses of Sync, but Meta enforces
 * its limits per APP — twenty agents each within their personal allowance still add up, and when the
 * app hits Meta's ceiling every agent sees failures none of them caused.
 *
 * **The dead token.** A long-lived token lasts about sixty days, and is also killed early by the
 * user removing the app or changing their password. Every sync then failed, the failure was written
 * to `last_error`, and nothing else happened: no email, no pause, and a scheduler that retried a
 * dead credential every fifteen minutes for ever. An agent not looking at the Meta screen saw only
 * an absence of leads, which is indistinguishable from a quiet week — while the brokerage went on
 * paying per click.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

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
const asUser = (id: number, name: string): AuthUserRecord => ({ id, name, role: 'agent' } as unknown as AuthUserRecord);

async function makeUser(tx: PrismaService): Promise<{ id: number; name: string; email: string }> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `Bud ${t}`, email: `bud-${t}@example.test`, role: 'agent', status: 'Active',
      password: 'x', company_id: 1, created_at: now, updated_at: now,
    },
  });
  return { id: u.id, name: u.name, email: u.email };
}

async function connect(tx: PrismaService, userId: number, forms = 1): Promise<void> {
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
        form_name: `Form ${i}`, is_active: true, created_at: now, updated_at: now,
      },
    });
  }
}

/**
 * Start this window's allowance from zero.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT CHEATING. The budget is keyed by window — epoch
 * milliseconds rounded to the window size — and that row is written by the running application, not
 * only by tests. Anything that consumed Graph budget in the same window leaves a committed row, and
 * a rolled-back transaction cannot undo a commit that happened before it started. Three of these
 * tests then failed for a reason that had nothing to do with the code: the FIRST `consume()` of a
 * full allowance hit `existing + 600 <= 600` and was refused.
 *
 * Deleting the row INSIDE the test's transaction rolls back with everything else, so the real
 * window is untouched. What is being asserted is the arithmetic — collective draw-down, refusal at
 * the ceiling, partial spends — and that arithmetic needs a known starting point, not whatever the
 * application happened to spend a minute ago.
 *
 * The failure also cost an hour to find because `.env` points jest at the DEVELOPMENT database
 * while the end-to-end suite uses `myapp_test`; checking the wrong one showed an empty table and
 * ruled out pollution incorrectly.
 */
async function clearWindow(tx: PrismaService): Promise<void> {
  await tx.$executeRawUnsafe('DELETE FROM meta_api_budget');
}

describe('the Graph budget everybody shares', () => {
  it('is spent collectively, so two agents draw down one allowance', async () => {
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const budget = new MetaApiBudgetService(tx);
      const before = await budget.remaining();

      await budget.consume(5);   // agent A
      await budget.consume(3);   // agent B

      // The point: B's spending reduced what is left for A, which a per-user limit cannot express.
      expect(await budget.remaining()).toBe(before - 8);
    });
  });

  it('refuses once the window is spent, and says when it resets', async () => {
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const budget = new MetaApiBudgetService(tx);
      const first = await budget.consume(META_BUDGET_PER_WINDOW);
      expect(first.allowed).toBe(true);

      const second = await budget.consume(1);
      expect(second.allowed).toBe(false);
      expect(second.limit).toBe(META_BUDGET_PER_WINDOW);
      expect(second.resetInSeconds).toBeGreaterThan(0);
      // A refusal must not consume anything, or a busy window could never recover.
      expect(await budget.remaining()).toBe(0);
    });
  });

  it('lets a partial spend through and refuses only what exceeds the ceiling', async () => {
    await inRollback(async (tx) => {
      await clearWindow(tx);
      const budget = new MetaApiBudgetService(tx);
      await budget.consume(META_BUDGET_PER_WINDOW - 2);
      expect((await budget.consume(2)).allowed).toBe(true);   // exactly fills it
      expect((await budget.consume(1)).allowed).toBe(false);  // one past
    });
  });

  it('stops a sync before it fans out, and says leads are not lost', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 3);

      await clearWindow(tx);
      const spent = new MetaApiBudgetService(tx);
      // Only fills the window because it starts empty — otherwise this "spend the budget" step
      // silently spends nothing and the sync below is refused for an unrelated reason.
      await spent.consume(META_BUDGET_PER_WINDOW);

      const graph = { formLeads: async () => { throw new Error('Graph must not be called once the budget is spent'); } };
      const sync = new MetaSyncService(
        tx,
        new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
        graph as never,
        { record: async () => {} } as never,
        { notifyNewLead: async () => {} } as never,
        spent,
        { reconnectRequired: async () => {} } as never,
      );

      const result = await sync.syncUser(asUser(user.id, user.name), 'manual');

      expect(result.forms).toBe(0);
      expect(result.errors.join(' ')).toContain('allowance');
      // The reassurance matters as much as the refusal: an agent seeing this must not conclude the
      // enquiries are gone.
      expect(result.errors.join(' ')).toContain('no leads are lost');
    });
  });
});

describe('a token Meta says is finished', () => {
  /** A sync whose Graph calls fail the way an expired or revoked token fails. */
  const syncFailingWith = (tx: PrismaService, err: Error, sent: string[]) => new MetaSyncService(
    tx,
    new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
    { formLeads: async () => { throw err; } } as never,
    { record: async () => {} } as never,
    { notifyNewLead: async () => {} } as never,
    new MetaApiBudgetService(tx),
    { reconnectRequired: async (userId: number) => { sent.push(String(userId)); } } as never,
  );

  /** `find()` needs a page matching the form, so give the connection one. */
  async function connectWithPage(tx: PrismaService, userId: number, forms: number): Promise<void> {
    const now = new Date();
    const conn = await tx.meta_connections.create({
      data: {
        user_id: userId, access_token: 'plain:tok', facebook_user_id: `fb-${tag()}`,
        is_active: true, connected_at: now, created_at: now, updated_at: now,
      },
    });
    for (let i = 0; i < forms; i += 1) {
      const pageId = `page-${tag()}`;
      await tx.meta_pages.create({
        data: { connection_id: conn.id, page_id: pageId, name: 'Page', access_token: 'plain:pt', created_at: now, updated_at: now },
      });
      await tx.meta_lead_forms.create({
        data: {
          company_id: 1, user_id: userId, page_id: pageId, form_id: `form-${tag()}`,
          form_name: `Form ${i}`, is_active: true, created_at: now, updated_at: now,
        },
      });
    }
  }

  it('is recorded as expired the moment Meta says so, and the agent is emailed', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connectWithPage(tx, user.id, 2);
      const sent: string[] = [];

      const result = await syncFailingWith(tx, new GraphError('Session expired', 400, 190), sent)
        .syncUser(asUser(user.id, user.name), 'scheduled');

      const conn = await tx.meta_connections.findUnique({ where: { user_id: user.id } });
      expect(conn?.token_expires_at).not.toBeNull();
      expect(conn!.token_expires_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      // Not disconnected — the forms stay claimed so reconnecting restores service.
      expect(conn?.is_active).toBe(true);
      expect(await tx.meta_lead_forms.count({ where: { user_id: user.id, is_active: true } })).toBe(2);

      expect(sent).toEqual([String(user.id)]);
      expect(result.errors.join(' ')).toContain('paused');
    });
  });

  it('stops after the first form rather than failing every one of them', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connectWithPage(tx, user.id, 4);
      const sent: string[] = [];

      const result = await syncFailingWith(tx, new GraphError('Invalid OAuth token', 400, 190), sent)
        .syncUser(asUser(user.id, user.name), 'scheduled');

      // Four forms, one failure reported: the rest were not attempted against a dead credential.
      const perForm = result.errors.filter((e) => e.startsWith('Form '));
      expect(perForm).toHaveLength(1);
    });
  });

  it('emails once, not every fifteen minutes for ever', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connectWithPage(tx, user.id, 1);
      const sent: string[] = [];
      const sync = syncFailingWith(tx, new GraphError('Session expired', 400, 190), sent);

      await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await sync.syncUser(asUser(user.id, user.name), 'scheduled');
      await sync.syncUser(asUser(user.id, user.name), 'scheduled');

      expect(sent).toHaveLength(1);
    });
  });

  it('does not pause on a rate limit or a permission problem, which are different failures', async () => {
    await inRollback(async (tx) => {
      for (const [code, label] of [[4, 'rate limit'], [10, 'permission'], [100, 'bad request']] as const) {
        const user = await makeUser(tx);
        await connectWithPage(tx, user.id, 1);
        const sent: string[] = [];

        await syncFailingWith(tx, new GraphError(label, 400, code), sent)
          .syncUser(asUser(user.id, user.name), 'scheduled');

        const conn = await tx.meta_connections.findUnique({ where: { user_id: user.id } });
        expect(conn?.token_expires_at).toBeNull();
        expect(sent).toEqual([]);
      }
    });
  });

  it('is skipped by the poller afterwards, so a dead token is not retried for ever', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 1);

      const polled: number[] = [];
      const scheduler = () => new MetaSyncSchedulerService(tx, {
        syncUser: async (u: { id: number }) => {
          polled.push(u.id);
          return { imported: 0, updated: 0, duplicates: 0, skipped: 0, forms: 0, errors: [] };
        },
      } as never);

      await scheduler().pollAllForTenant();
      expect(polled).toContain(user.id);

      await new MetaConnectionService(tx, { fetchPages: async () => [] } as never).markTokenDead(user.id);

      const after: number[] = [];
      const s2 = new MetaSyncSchedulerService(tx, {
        syncUser: async (u: { id: number }) => {
          after.push(u.id);
          return { imported: 0, updated: 0, duplicates: 0, skipped: 0, forms: 0, errors: [] };
        },
      } as never);
      await s2.pollAllForTenant();
      expect(after).not.toContain(user.id);
    });
  });

  it('resumes as soon as a reconnect gives it a live token', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await connect(tx, user.id, 1);
      const conns = new MetaConnectionService(tx, { fetchPages: async () => [] } as never);
      await conns.markTokenDead(user.id);

      // What a reconnect does: a fresh token and a fresh expiry.
      await conns.save(user.id, 'new-token', { id: `fb-${tag()}` }, []);
      await tx.meta_connections.update({
        where: { user_id: user.id },
        data: { token_expires_at: new Date(Date.now() + 60 * 86_400_000) },
      });

      const polled: number[] = [];
      await new MetaSyncSchedulerService(tx, {
        syncUser: async (u: { id: number }) => {
          polled.push(u.id);
          return { imported: 0, updated: 0, duplicates: 0, skipped: 0, forms: 0, errors: [] };
        },
      } as never).pollAllForTenant();

      expect(polled).toContain(user.id);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
