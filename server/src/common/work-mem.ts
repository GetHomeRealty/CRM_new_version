import type { PrismaService } from '../prisma/prisma.service';

/**
 * Run one statement with a larger sort budget, and nothing else changed.
 *
 * WHY THIS EXISTS AT ALL. The commission and report-total aggregates sort the deal's member set and
 * then the line set. At PostgreSQL's 4 MB default both spill to disk, and three of them spilling at
 * the same moment made the parallel run SLOWER than the slowest branch alone — 11.6 s against 8.5 s,
 * which is what disk contention looks like. `SET LOCAL` needs a transaction to be local TO, which is
 * the only reason one is opened; these are single reads with nothing to roll back.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG AND BOTH HAVE ALREADY BITTEN:
 *
 *   · PRISMA CLOSES AN INTERACTIVE TRANSACTION AFTER FIVE SECONDS by default, and then the query
 *     inside it fails with "Transaction already closed". These aggregates take longer than that at
 *     brokerage scale, so the default would turn a slow screen into a broken one — and only on the
 *     largest databases, which is the worst place to find out.
 *   · WHEN THE CLIENT IS ALREADY A TRANSACTION there is no `$transaction` to call and no second one
 *     to want. Every spec in this repository runs inside one so its fixtures roll back, so a caller
 *     that assumes otherwise passes in isolation and fails in the suite. `SET LOCAL` applied to the
 *     transaction already open is exactly the intended scope.
 */
export async function withWorkMem<T>(
  prisma: PrismaService,
  workMem: string,
  timeoutMs: number,
  query: (tx: PrismaService) => Promise<T>,
): Promise<T> {
  const run = async (tx: PrismaService): Promise<T> => {
    await tx.$executeRawUnsafe(`SET LOCAL work_mem = '${workMem}'`);
    return query(tx);
  };
  const client = prisma as unknown as { $transaction?: unknown };
  if (typeof client.$transaction !== 'function') return run(prisma);
  return prisma.$transaction((tx) => run(tx as unknown as PrismaService), {
    timeout: timeoutMs,
    maxWait: 30_000,
  });
}

/** A `work_mem` value from the environment, stripped to what PostgreSQL will accept in a SET. */
export const workMemSetting = (raw: string | undefined, fallback: string): string =>
  (raw ?? fallback).replace(/[^0-9A-Za-z]/g, '') || fallback;
