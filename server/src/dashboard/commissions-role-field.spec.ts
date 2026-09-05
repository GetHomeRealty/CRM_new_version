import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DashboardService } from './dashboard.service';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * TD-101 — the commissions payload reports the caller's own role.
 *
 * THE DEFECT. `role` was `isAgent(user) ? 'agent' : 'admin'`, so every seat that is not an agent
 * was described as an administrator. An ACCOUNTING user reading the endpoint from their own
 * session — where `GET /api/user` says `accounting` — was told `admin`, twice, byte for byte, so
 * it was computed that way rather than left over from another session.
 *
 * WHY THE RE-TEST MISSED IT. It was re-run from the AGENT seat, and the agent branch is the only
 * one that was ever right: `isAgent` is true, so the label matched. Every other role — accounting,
 * manager, documentation, crm — was collapsed. That is why the cases below are per role rather
 * than one happy path.
 *
 * NOTHING ELSE CHANGES. The response's SHAPE turns on `isAgent` — an agent gets their own figures,
 * an office seat gets the brokerage's — which is a different question from what to call the caller.
 * The last two tests pin that: the label moved, the money did not.
 *
 * The answer to the entry's open question, "does anything consume this field?", is no: nothing in
 * the client reads it today. Which is the reason to fix it now rather than the reason not to.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

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

const serviceFor = (tx: PrismaService) =>
  new DashboardService(tx, new CommissionService(new PersonResolver(tx)), new PersonResolver(tx));

const asUser = (role: string, name = `TD101 ${role}`): ResourceUser =>
  ({ id: 90_101, name, role } as unknown as ResourceUser);

const ROLES = ['admin', 'manager', 'agent', 'accounting', 'documentation', 'crm'];

describe('the commissions endpoint names the caller correctly (TD-101)', () => {
  jest.setTimeout(120_000);

  it.each(ROLES)('reports %s as themselves', async (role) => {
    await inRollback(async (tx) => {
      const out = await serviceFor(tx).commissions(asUser(role));
      expect(out.role).toBe(role);
    });
  });

  it('is the reported case: accounting is not called admin', async () => {
    await inRollback(async (tx) => {
      const out = await serviceFor(tx).commissions(asUser('accounting', 'karishma'));
      expect(out.role).toBe('accounting');
      expect(out.role).not.toBe('admin');
    });
  });

  it('says the same thing on the enrichment path as on the SQL path', async () => {
    // Two implementations answer this endpoint; a label that drifted between them would be the
    // same defect with a longer fuse.
    await inRollback(async (tx) => {
      const svc = serviceFor(tx);
      for (const role of ROLES) {
        const user = asUser(role);
        expect([role, (await svc.commissionsInNode(user)).role]).toEqual([role, role]);
        expect([role, (await svc.commissions(user)).role]).toEqual([role, role]);
      }
    });
  });

  it('leaves the FIGURES shaped by the seat, which is a different question', async () => {
    /*
     * The fix is a label. An agent still gets their own commission in `t4a` and an office seat
     * still gets the brokerage's `gross` — decided by `isAgent`, not by this field. If somebody
     * later drives the shape from `role`, this is what fails.
     */
    await inRollback(async (tx) => {
      const svc = serviceFor(tx);
      const accounting = await svc.commissions(asUser('accounting', 'An Office Seat'));
      const manager = await svc.commissions(asUser('manager', 'An Office Seat'));
      const agent = await svc.commissions(asUser('agent', 'An Office Seat'));

      // Two office seats, two different labels, one identical set of figures.
      expect(accounting.role).toBe('accounting');
      expect(manager.role).toBe('manager');
      expect({ ...accounting, role: null }).toEqual({ ...manager, role: null });

      // And the agent seat still gets the agent-shaped answer, as it always did.
      expect(accounting.count_basis).toBe('commission_lines');
      expect(agent.count_basis).toBe('deals');
    });
  });
});
