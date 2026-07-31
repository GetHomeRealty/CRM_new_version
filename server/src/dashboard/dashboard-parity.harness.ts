import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { normalizeCommissionTxn } from '../transactions/commission.loader';
import { DashboardService } from './dashboard.service';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * The gate for optimising the dashboard.
 *
 * The dashboard sums commissions in application code, and the query it does that over carries a
 * comment explaining that the iteration order is deliberate — "match Laravel's PK-order iteration
 * for identical fp sums". Floating-point addition is not associative, so `(a + b) + c` and
 * `a + (b + c)` genuinely differ in the last place. Any change to how those rows are fetched,
 * grouped or ordered can therefore move a total by a cent, and a cent is a wrong commission
 * cheque.
 *
 * So this is not a "does it still roughly work" test. It captures EVERY numeric leaf the dashboard
 * and the commission engine produce, for EVERY transaction and EVERY role, and compares them for
 * EXACT equality afterwards — no tolerance, no epsilon. A tolerance would defeat the purpose: the
 * failure being guarded against is precisely a sub-cent drift that rounds into a visible figure.
 *
 * WHY IT SNAPSHOTS THE PER-TRANSACTION BREAKDOWN and not only the dashboard totals: two errors that
 * cancel out would leave the totals matching while every individual figure was wrong. Comparing the
 * breakdowns catches that; comparing only the totals cannot.
 *
 * Deliberately free of Nest wiring so it can run against a plain PrismaClient — the point is to be
 * runnable before and after a refactor, from a script, without booting the application.
 */

export interface ParitySnapshot {
  /** transaction id -> the full commission summary and breakdown, verbatim. */
  perTransaction: Record<string, { summary: unknown; breakdown: unknown }>;
  /** role label -> the full dashboard payload. */
  dashboards: Record<string, unknown>;
  meta: { transactions: number; capturedFrom: string };
}

/** Every role whose dashboard is shaped differently. Agents see only their own share. */
export const PARITY_ROLES: { label: string; user: ResourceUser | null }[] = [];

/**
 * Build the role list from the users actually present, so the snapshot covers the real people
 * rather than invented ones — an agent's dashboard depends on their NAME matching team member rows.
 */
export async function parityRoles(prisma: PrismaClient): Promise<{ label: string; user: ResourceUser }[]> {
  const users = await prisma.users.findMany({
    where: { status: 'Active' },
    select: { id: true, name: true, role: true, company_id: true },
    orderBy: { id: 'asc' },
  });
  // Keyed by USER ID, not by name. Keying on the name made a rename look like a parity failure:
  // renaming a duplicated account reported `admin:Akhil` missing and `admin:Akhilesh` appearing,
  // while every figure underneath was byte-identical. A gate that cries wolf over a label gets
  // ignored, which would defeat the point of having one.
  return users.map((u) => ({
    label: `${u.role}#${u.id}`,
    user: { id: u.id, name: u.name, role: u.role, company_id: u.company_id } as unknown as ResourceUser,
  }));
}

/**
 * Capture everything, in the order the application itself would.
 *
 * `orderBy: { id: 'asc' }` matches the dashboard exactly. If the optimised implementation changes
 * that order, the snapshot comparison is what will notice.
 */
export async function captureParity(
  prisma: PrismaService,
  commission: CommissionService,
  dashboard: DashboardService,
  roles: { label: string; user: ResourceUser }[],
  capturedFrom: string,
): Promise<ParitySnapshot> {
  const txns = await prisma.transactions.findMany({
    where: { deleted_at: null },
    orderBy: { id: 'asc' },
    include: {
      transaction_statuses: true,
      team_members: { include: { team_member_terms: true } },
      precon_terms: true,
    },
  });

  const perTransaction: ParitySnapshot['perTransaction'] = {};
  for (const t of txns) {
    const input = normalizeCommissionTxn(t);
    perTransaction[String(t.id)] = {
      summary: commission.summarize(input),
      // No profile cache here on purpose: the baseline must reflect what the CURRENT code computes,
      // including any per-transaction lookup it performs.
      breakdown: await commission.breakdown(input),
    };
  }

  const dashboards: Record<string, unknown> = {};
  for (const r of roles) dashboards[r.label] = await dashboard.commissions(r.user);

  return { perTransaction, dashboards, meta: { transactions: txns.length, capturedFrom } };
}

export interface Difference {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * Deep exact comparison. Every leaf, no tolerance.
 *
 * Numbers are compared with Object.is rather than `===` so that a 0 which became -0, or a value
 * which became NaN, is reported rather than passing silently — both are real outcomes of
 * restructuring arithmetic, and both would otherwise slip through.
 */
export function diffParity(before: unknown, after: unknown, path = ''): Difference[] {
  if (before === null || after === null || before === undefined || after === undefined
      || typeof before !== 'object' || typeof after !== 'object') {
    if (typeof before === 'number' && typeof after === 'number') {
      return Object.is(before, after) ? [] : [{ path, before, after }];
    }
    return before === after ? [] : [{ path, before, after }];
  }

  if (Array.isArray(before) !== Array.isArray(after)) return [{ path, before, after }];

  if (Array.isArray(before) && Array.isArray(after)) {
    // Order matters. A reordered array of agent lines is a real difference: the dashboard sums
    // them in sequence and floating-point addition is not associative.
    if (before.length !== after.length) return [{ path: `${path}.length`, before: before.length, after: after.length }];
    return before.flatMap((v, i) => diffParity(v, after[i], `${path}[${i}]`));
  }

  const keys = [...new Set([...Object.keys(before as object), ...Object.keys(after as object)])].sort();
  return keys.flatMap((k) => diffParity(
    (before as Record<string, unknown>)[k],
    (after as Record<string, unknown>)[k],
    path ? `${path}.${k}` : k,
  ));
}

/** Every numeric leaf, for reporting how much was actually compared. */
export function countNumericLeaves(v: unknown): number {
  if (typeof v === 'number') return 1;
  if (v === null || typeof v !== 'object') return 0;
  if (Array.isArray(v)) return v.reduce<number>((a, x) => a + countNumericLeaves(x), 0);
  return Object.values(v as Record<string, unknown>).reduce<number>((a, x) => a + countNumericLeaves(x), 0);
}
