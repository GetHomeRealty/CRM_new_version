import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AreaDashboardService } from './area-dashboard.service';
import { PermissionService } from '../auth/permission.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-DASH-M01 — the Transaction Desk dashboard's invoice figures.
 *
 * Three of the fourteen aggregates in `desk()` read `{ deleted_at: null }` and nothing else, while
 * this class's own docstring promised "every query is scoped to the signed-in user the same way its
 * module already scopes". Measured against the development database on 2026-08-05:
 *
 *   agent  Akhil     transactions.total 3   invoices { total: 5, billed: 123396, outstanding: 123396 }
 *   admin  Akhilesh  transactions.total 7   invoices { total: 5, billed: 123396, outstanding: 123396 }
 *   SELECT count(*), sum(total) FROM invoices WHERE deleted_at IS NULL  →  5, 123396
 *
 * The transactions figure was correctly the agent's own 3 of 7. The invoice figures were the whole
 * brokerage's — and the agent role holds `invoice: 'none'`, so those four tiles printed money for a
 * module the same person cannot open. It was on screen, not merely in the payload:
 * `DeskDashboardPage` rendered Invoices, Billed, Collected and Outstanding unconditionally.
 *
 * Written as the failure, not the feature.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svc = (tx: PrismaService) => new AreaDashboardService(tx, new PermissionService());
const asUser = (role: string, id: number, name: string, overrides: { screen: string; level: string }[] = []) =>
  ({ id, name, role, user_permissions: overrides } as unknown as AuthUserRecord);

/** One agent, one deal of theirs, one invoice on it — and one of somebody else's, for contrast. */
async function twoAgentsWithInvoices(tx: PrismaService) {
  const now = new Date();
  const mk = async (label: string) => {
    const t = tag();
    const u = await tx.users.create({
      data: {
        name: `ZZ ${label} ${t}`, email: `zz-${label}-${t}@probe.test`, role: 'agent', status: 'Active',
        password: 'x', created_at: now, updated_at: now,
      },
      select: { id: true, name: true },
    });
    const txn = await tx.transactions.create({
      data: {
        trade_no: `ZZ${t}`.slice(0, 20), agent: u.name, type: 'Residential Buying',
        company_id: 1, created_at: now, updated_at: now,
      },
      select: { id: true },
    });
    await tx.invoices.create({
      data: {
        invoice_no: `ZZ-${t}`.slice(0, 30), transaction_id: txn.id, status: 'Unpaid', invoice_date: now,
        total: 1000, amount_paid: 0, balance_due: 1000, company_id: 1, created_at: now, updated_at: now,
      },
    });
    return u;
  };
  return { mine: await mk('mine'), theirs: await mk('theirs') };
}

describe('an agent is not shown the brokerage\'s invoice figures', () => {
  it('the whole invoice block is withheld from a role holding `invoice: none`', async () => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const d = await svc(tx).desk(asUser('agent', mine.id, mine.name));
      expect(d.invoices).toBeNull();
    });
  });

  it('null, not zeros — "the brokerage has billed nothing" is a different lie', async () => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const d = await svc(tx).desk(asUser('agent', mine.id, mine.name));
      expect(d.invoices).not.toEqual({ total: 0, unpaid: 0, billed: 0, collected: 0, outstanding: 0 });
    });
  });

  it.each(['documentation', 'crm'])('%s holds `invoice: none` too, and is withheld the same way', async (role) => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      expect((await svc(tx).desk(asUser(role, mine.id, mine.name))).invoices).toBeNull();
    });
  });

  it('the rest of the agent\'s dashboard is unaffected', async () => {
    // The fix must not take the deal figures with it — those were already correct.
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const d = await svc(tx).desk(asUser('agent', mine.id, mine.name));
      expect(d.transactions.total).toBe(1);
      expect(d.todos).toBeDefined();
      expect(d.calendar).toBeDefined();
    });
  });
});

describe('a role that may read invoices still gets them, at its own scope', () => {
  it('an administrator reads the brokerage\'s, as before', async () => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const d = await svc(tx).desk(asUser('admin', mine.id, mine.name));
      expect(d.invoices).not.toBeNull();
      // Both probe invoices, plus whatever the database already held.
      expect(d.invoices!.total).toBeGreaterThanOrEqual(2);
    });
  });

  it.each(['manager', 'accounting'])('%s reads them too — the fix did not narrow who may', async (role) => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      expect((await svc(tx).desk(asUser(role, mine.id, mine.name))).invoices).not.toBeNull();
    });
  });

  it('an AGENT granted invoice access sees their own deals\' invoices, not the brokerage\'s', async () => {
    /*
     * The second half of the fix, and the reason withholding alone was not enough: Roles &
     * Permissions can grant an individual agent `invoice: view`, and at that point the old query
     * would have handed them everything again. Scoped through `transactions: { is: live }`, the same
     * join the document counts already use.
     */
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const granted = asUser('agent', mine.id, mine.name, [{ screen: 'invoice', level: 'view' }]);
      const d = await svc(tx).desk(granted);

      expect(d.invoices).not.toBeNull();
      expect(d.invoices!.total).toBe(1);            // their own deal's invoice, not both
      expect(d.invoices!.billed).toBe(1000);
      expect(d.invoices!.outstanding).toBe(1000);
    });
  });

  it('…and an invoice attached to no transaction is not counted as theirs', async () => {
    /*
     * A standalone invoice is brokerage billing. `transactions: { is: … }` on a nullable relation
     * excludes it, which is the wanted answer — and worth pinning, because the opposite trap is
     * recorded elsewhere in this codebase: `{ not: … }` against a nullable column silently drops
     * every NULL row.
     */
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const now = new Date();
      await tx.invoices.create({
        data: {
          invoice_no: `ZZ-solo-${tag()}`.slice(0, 30), transaction_id: null, status: 'Unpaid', invoice_date: now,
          total: 9999, amount_paid: 0, balance_due: 9999, company_id: 1, created_at: now, updated_at: now,
        },
      });
      const granted = asUser('agent', mine.id, mine.name, [{ screen: 'invoice', level: 'view' }]);
      const d = await svc(tx).desk(granted);
      expect(d.invoices!.billed).toBe(1000);
    });
  });

  it('a deleted invoice is still excluded for everyone', async () => {
    await inRollback(async (tx) => {
      const { mine } = await twoAgentsWithInvoices(tx);
      const now = new Date();
      const txn = await tx.transactions.findFirst({ where: { agent: mine.name }, select: { id: true } });
      await tx.invoices.create({
        data: {
          invoice_no: `ZZ-del-${tag()}`.slice(0, 30), transaction_id: txn!.id, status: 'Unpaid', invoice_date: now,
          total: 500, amount_paid: 0, balance_due: 500, deleted_at: now,
          company_id: 1, created_at: now, updated_at: now,
        },
      });
      const granted = asUser('agent', mine.id, mine.name, [{ screen: 'invoice', level: 'view' }]);
      expect((await svc(tx).desk(granted)).invoices!.billed).toBe(1000);
    });
  });
});
