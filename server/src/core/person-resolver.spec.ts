import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { PersonResolver } from './person-resolver.service';
import { CommissionService } from '../transactions/commission.service';
import type { CommissionTxn } from '../transactions/commission.types';

/**
 * Identifying a person by id rather than by the name they happen to have today.
 *
 * THE CASE THAT MADE THIS NECESSARY (Users audit, U-C1). A departed agent on a 10% split is
 * deactivated; a new hire with the same common name joins on 90%. Commission profiles were resolved
 * with `users.findFirst({ where: { name } })` and no status filter, which returned the INACTIVE row
 * three times out of three — so every deal the new agent closed paid the departed colleague's
 * percentage, silently, with both records looking correct in isolation.
 *
 * Two things close it, and both are tested here:
 *
 *   the id wins when the row has one — no name lookup happens at all
 *   the name fallback, for rows that predate the column, is at least DETERMINISTIC: an Active row
 *   wins and ties break on the lowest id, rather than the query planner deciding
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

async function person(tx: PrismaService, name: string, status: string, pct: number) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name, email: `pr-${t}@example.test`, username: `pr-${t}`, password: 'x',
      role: 'agent', status, created_at: now, updated_at: now,
      profile: JSON.stringify({ agent_comm_pct: pct }),
    },
  });
}

/** The minimum a commission breakdown needs: one agent, no team members, a flat 2.5%. */
const txn = (agent: string, agentUserId: number | null): CommissionTxn => ({
  type: 'Sale', price: 1_000_000, comm_type: '%', comm_value: 2.5, comm_pct: 2.5, comm_amt: null,
  comm_adjust_enabled: false, comm_adjust_before: 0, comm_adjust_after: 0,
  listing_comm_pct: null, coop_comm_pct: null, listing_comm_flat: null, coop_comm_flat: null,
  listing_adj_enabled: false, listing_adj_before: 0, listing_adj_after: 0,
  coop_adj_enabled: false, coop_adj_before: 0, coop_adj_after: 0,
  precon_net_of_hst: false, precon_comm_pct: null, precon_comm_amt_manual: null, precon_term_count: null,
  comm_paid_status: null, comm_status: null,
  agent, agent_user_id: agentUserId, adjustments: {}, teamMembers: [], preconTerms: [],
} as unknown as CommissionTxn);

describe('the id decides, not the name', () => {
  it('pays the new hire their own split, not the departed namesake\'s', async () => {
    await inRollback(async (tx) => {
      const name = `Shared Name ${tag()}`;
      const departed = await person(tx, name, 'Inactive', 10);
      const newHire = await person(tx, name, 'Active', 90);

      const commission = new CommissionService(new PersonResolver(tx));
      const withId = await commission.breakdown(txn(name, newHire.id)) as { agents: { agent_pct: number }[] };

      // Before this, the lookup returned the inactive row and the agent line read 10%.
      expect(withId.agents[0].agent_pct).toBe(90);
      expect(departed.id).toBeLessThan(newHire.id);   // the wrong row is the one it used to pick
    });
  });

  it('still resolves a row that has no id, and does so deterministically', async () => {
    await inRollback(async (tx) => {
      const name = `Legacy Name ${tag()}`;
      await person(tx, name, 'Inactive', 10);
      await person(tx, name, 'Active', 90);

      const commission = new CommissionService(new PersonResolver(tx));
      // agent_user_id null — a row written before the column existed.
      const legacy = await commission.breakdown(txn(name, null)) as { agents: { agent_pct: number }[] };

      // Ambiguous by construction, but no longer arbitrary: the Active row wins, every time.
      expect(legacy.agents[0].agent_pct).toBe(90);
    });
  });

  it('prefers the id even when that account has since been deactivated', async () => {
    await inRollback(async (tx) => {
      const name = `Left Since ${tag()}`;
      const closer = await person(tx, name, 'Inactive', 70);
      await person(tx, name, 'Active', 90);

      const commission = new CommissionService(new PersonResolver(tx));
      const settled = await commission.breakdown(txn(name, closer.id)) as { agents: { agent_pct: number }[] };

      // A deal closed by somebody who has since left still pays at THEIR split — which is the whole
      // reason the commission paths do not filter on status.
      expect(settled.agents[0].agent_pct).toBe(70);
    });
  });
});

describe('resolve()', () => {
  it('takes the id over the name when both are given and they disagree', async () => {
    await inRollback(async (tx) => {
      const a = await person(tx, `A ${tag()}`, 'Active', 50);
      const b = await person(tx, `B ${tag()}`, 'Active', 60);

      const found = await new PersonResolver(tx).resolve(b.id, a.name);
      expect(found?.id).toBe(b.id);
    });
  });

  it('falls back to the name when there is no id', async () => {
    await inRollback(async (tx) => {
      const a = await person(tx, `Solo ${tag()}`, 'Active', 50);
      expect((await new PersonResolver(tx).resolve(null, a.name))?.id).toBe(a.id);
    });
  });

  it('returns nothing for a name nobody has', async () => {
    await inRollback(async (tx) => {
      expect(await new PersonResolver(tx).resolve(null, `Nobody ${tag()}`)).toBeNull();
    });
  });

  it('refuses an inactive account when the caller needs a live one', async () => {
    await inRollback(async (tx) => {
      const gone = await person(tx, `Gone ${tag()}`, 'Inactive', 50);
      const r = new PersonResolver(tx);
      // The email paths ask for activeOnly: writing to a departed colleague's address is the thing
      // to avoid, whether they were found by id or by name.
      expect(await r.resolve(gone.id, gone.name, { activeOnly: true })).toBeNull();
      expect(await r.resolve(null, gone.name, { activeOnly: true })).toBeNull();
      expect((await r.resolve(gone.id, gone.name))?.id).toBe(gone.id);
    });
  });

  it('resolves a batch the same way it resolves one', async () => {
    await inRollback(async (tx) => {
      const name = `Batch ${tag()}`;
      await person(tx, name, 'Inactive', 10);
      const active = await person(tx, name, 'Active', 90);

      const r = new PersonResolver(tx);
      const many = await r.resolveManyByName([name]);
      const one = await r.resolve(null, name);

      // The cached and uncached paths must agree, which is what the dashboard parity gate depends on.
      expect(many.get(name)?.id).toBe(active.id);
      expect(one?.id).toBe(active.id);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
