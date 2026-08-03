import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaConnectionService } from './meta-connection.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * What happens to an agent's Meta lead forms when they disconnect.
 *
 * WHY THIS EXISTS AS A DATABASE TEST. The first attempt to prove this behaviour reconstructed
 * `disconnect()` in SQL — delete the pages, deactivate the connection — and reported that a
 * successor could take the form over. The real method does not deactivate the forms, so the claim
 * was never released and the successor was refused. The simulation agreed with the design intent
 * instead of with the code, which is the one thing a test must not do.
 *
 * So: call the real service, against the real schema, and let the real partial unique index decide.
 *
 * The rule being defended (see docs/META-LEAD-FORM-POLICY.md): one form belongs to one agent, and
 * the claim is released by deactivation — which is why `meta_lead_forms_page_form_key` is partial
 * on `is_active` rather than absolute.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

/**
 * An interactive transaction client has no `$transaction` of its own, and `disconnect` uses one.
 * Awaiting the operations in order is a faithful stand-in here: we are already inside a
 * transaction, so they are still atomic — the outer rollback covers the lot.
 *
 * Wrapped rather than assigned: setting `$transaction` on the transaction client writes straight
 * through to the real one, which then breaks the outer rollback that depends on it.
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
const noGraph = { fetchPages: async () => [] };
const svc = (tx: PrismaService) => new MetaConnectionService(tx, noGraph as never);

async function makeAgent(tx: PrismaService, label: string): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `Meta ${label} ${t}`, email: `meta-${t}@example.test`, role: 'agent',
      status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now,
    },
  });
  return u as unknown as AuthUserRecord;
}

/** A connection row with no Graph call — `disconnect` only ever reads its id. */
async function connect(tx: PrismaService, userId: number): Promise<void> {
  const now = new Date();
  await tx.meta_connections.create({
    data: {
      user_id: userId, access_token: 'enc:v1:stub', facebook_user_id: `fb-${tag()}`,
      is_active: true, connected_at: now, created_at: now, updated_at: now,
    },
  });
}

async function claimForm(tx: PrismaService, userId: number, pageId: string, formId: string): Promise<void> {
  const now = new Date();
  await tx.meta_lead_forms.create({
    data: {
      company_id: 1, user_id: userId, page_id: pageId, form_id: formId,
      form_name: 'Spring campaign', is_active: true, created_at: now, updated_at: now,
    },
  });
}

describe('an agent leaving hands their forms back', () => {
  it('releases the form claim, so a successor can connect the same form', async () => {
    await inRollback(async (tx) => {
      const departing = await makeAgent(tx, 'departing');
      const successor = await makeAgent(tx, 'successor');
      const pageId = `page-${tag()}`;
      const formId = `form-${tag()}`;

      await connect(tx, departing.id as number);
      await claimForm(tx, departing.id as number, pageId, formId);

      const result = await svc(tx).disconnect(departing.id as number);
      expect(result.disconnected).toBe(true);

      // The row survives for the audit trail, but no longer holds the claim.
      const released = await tx.meta_lead_forms.findFirst({ where: { user_id: departing.id as number, form_id: formId } });
      expect(released).not.toBeNull();
      expect(released?.is_active).toBe(false);

      // The successor takes it over. Before the fix this threw a unique violation.
      await claimForm(tx, successor.id as number, pageId, formId);
      const held = await tx.meta_lead_forms.findMany({ where: { form_id: formId, is_active: true }, select: { user_id: true } });
      expect(held).toHaveLength(1);
      expect(held[0].user_id).toBe(successor.id);
    });
  });

  it('stops the polling — no active form is left behind to sync', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx, 'polled');
      const pageId = `page-${tag()}`;

      await connect(tx, agent.id as number);
      await claimForm(tx, agent.id as number, pageId, `form-a-${tag()}`);
      await claimForm(tx, agent.id as number, pageId, `form-b-${tag()}`);

      await svc(tx).disconnect(agent.id as number);

      // This is the exact filter `syncUser` and the scheduler use to decide what to poll.
      const wouldPoll = await tx.meta_lead_forms.count({ where: { user_id: agent.id as number, is_active: true } });
      expect(wouldPoll).toBe(0);
    });
  });

  it('leaves another agent\'s forms alone', async () => {
    await inRollback(async (tx) => {
      const leaving = await makeAgent(tx, 'leaving');
      const staying = await makeAgent(tx, 'staying');

      await connect(tx, leaving.id as number);
      await connect(tx, staying.id as number);
      await claimForm(tx, leaving.id as number, `page-${tag()}`, `form-${tag()}`);
      const keptFormId = `form-kept-${tag()}`;
      await claimForm(tx, staying.id as number, `page-${tag()}`, keptFormId);

      await svc(tx).disconnect(leaving.id as number);

      const kept = await tx.meta_lead_forms.findFirst({ where: { user_id: staying.id as number, form_id: keptFormId } });
      expect(kept?.is_active).toBe(true);
      const stillConnected = await tx.meta_connections.findFirst({ where: { user_id: staying.id as number, is_active: true } });
      expect(stillConnected).not.toBeNull();
    });
  });

  it('reconnecting the same agent restores their own forms rather than duplicating them', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx, 'returning');
      const pageId = `page-${tag()}`;
      const formId = `form-${tag()}`;

      await connect(tx, agent.id as number);
      await claimForm(tx, agent.id as number, pageId, formId);
      await svc(tx).disconnect(agent.id as number);

      // What `meta.controller.ts` does when the agent switches the form back on.
      const now = new Date();
      await tx.meta_lead_forms.upsert({
        where: { user_id_form_id_page_id: { user_id: agent.id as number, form_id: formId, page_id: pageId } },
        create: {
          company_id: 1, user_id: agent.id as number, page_id: pageId, form_id: formId,
          form_name: 'Spring campaign', is_active: true, created_at: now, updated_at: now,
        },
        update: { is_active: true, updated_at: now },
      });

      const rows = await tx.meta_lead_forms.findMany({ where: { user_id: agent.id as number, form_id: formId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(true);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
