import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from './agents.service';

/**
 * TD-102 — a commission plan says whether its account is somebody who can be put on a deal today.
 *
 * WHAT WAS REPORTED. `/api/agent-commissions` returned a plan for 'facebook test', a name with no
 * user account, paying 0% on sales — and with the agent name on a transaction being free text
 * (TD-045), a plan nobody can pick is a plan a typo or an import row can still reach.
 *
 * WHAT IS ACTUALLY POSSIBLE HERE. The map is built FROM `users` rows, so a plan without an account
 * cannot exist: no row, no plan. What does happen is the same hazard from the other end — the map
 * had no filter at all, while `listNames()` (the agent picker) is role `agent` AND status `Active`.
 * So a departed agent, or a manager carrying a 95% plan, still resolved a rate for any deal
 * bearing their name.
 *
 * WHY THE PLANS STAY. `FinancialModal` and `TeamSplitModal` look a member up BY NAME on a deal that
 * already exists, and fall back to 90/95 when there is no entry. Dropping a departed agent's plan
 * would silently re-rate every historical deal they are on — the entry's own instruction is not to
 * fix this by changing anybody's percentage, and a filter changes it by omission. So every plan
 * still resolves and each one now says which population it belongs to.
 *
 * Real rows in a rolled-back transaction: what is under test is which accounts produce a plan and
 * what each plan claims about itself.
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
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const serviceFor = (tx: PrismaService) => new AgentsService(tx);

async function user(tx: PrismaService, o: { role: string; status: string; agent_pct?: unknown; lease_pct?: unknown }) {
  const now = new Date();
  const n = ++seq;
  const name = `TD102 ${o.role} ${o.status} ${Date.now()}-${n}`;
  const profile: Record<string, unknown> = {};
  if (o.agent_pct !== undefined) profile.agent_comm_pct = o.agent_pct;
  if (o.lease_pct !== undefined) profile.lease_comm_pct = o.lease_pct;
  await tx.users.create({
    data: {
      name, email: `td102-${Date.now()}-${n}@x.test`, password: 'x',
      role: o.role, status: o.status, profile: JSON.stringify(profile), created_at: now, updated_at: now,
    },
  });
  return name;
}

describe('commission plans say whether their account is a current agent (TD-102)', () => {
  jest.setTimeout(120_000);

  it('marks an active agent as one', async () => {
    await inRollback(async (tx) => {
      const name = await user(tx, { role: 'agent', status: 'Active', agent_pct: 90, lease_pct: 95 });
      const map = await serviceFor(tx).commissions(null);
      expect(map[name]).toEqual({ agent_pct: 90, lease_pct: 95, active_agent: true });
    });
  });

  it('KEEPS a departed agent\'s plan, and marks it', async () => {
    // The deals they are on must keep resolving the rate they were paid at.
    await inRollback(async (tx) => {
      const name = await user(tx, { role: 'agent', status: 'Inactive', agent_pct: 90, lease_pct: 95 });
      const map = await serviceFor(tx).commissions(null);
      expect(map[name]).toBeDefined();
      expect(map[name].agent_pct).toBe(90);
      expect(map[name].active_agent).toBe(false);
    });
  });

  it('marks a plan held by a seat that is not an agent', async () => {
    // A manager on 95% is exactly the shape that made the reported plan reachable by a typo.
    await inRollback(async (tx) => {
      const name = await user(tx, { role: 'manager', status: 'Active', agent_pct: 95, lease_pct: 95 });
      const map = await serviceFor(tx).commissions(null);
      expect(map[name].active_agent).toBe(false);
      expect(map[name].agent_pct).toBe(95);
    });
  });

  it('still leaves an account with no plan out of the list entirely', async () => {
    await inRollback(async (tx) => {
      const name = await user(tx, { role: 'agent', status: 'Active' });
      const map = await serviceFor(tx).commissions(null);
      expect(map[name]).toBeUndefined();
    });
  });

  it('does not change any percentage, which the entry asks for explicitly', async () => {
    // A zero is a real plan for somebody who does not carry deals — it is the ORPHAN that was the
    // anomaly, never the number. Nothing here rewrites a rate.
    await inRollback(async (tx) => {
      const zero = await user(tx, { role: 'admin', status: 'Active', agent_pct: 0, lease_pct: 95 });
      const map = await serviceFor(tx).commissions(null);
      expect(map[zero]).toEqual({ agent_pct: 0, lease_pct: 95, active_agent: false });
    });
  });

  it('answers an agent with their own plan only, as it always did', async () => {
    await inRollback(async (tx) => {
      const mine = await user(tx, { role: 'agent', status: 'Active', agent_pct: 90 });
      const theirs = await user(tx, { role: 'agent', status: 'Active', agent_pct: 80 });
      const map = await serviceFor(tx).commissions({ id: 1, name: mine, role: 'agent' } as never);
      expect(Object.keys(map)).toEqual([mine]);
      expect(map[theirs]).toBeUndefined();
    });
  });
});
