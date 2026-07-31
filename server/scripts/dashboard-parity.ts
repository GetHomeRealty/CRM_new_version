/**
 * The deploy gate for the dashboard optimisation.
 *
 *   npx ts-node scripts/dashboard-parity.ts capture         # BEFORE any change
 *   npx ts-node scripts/dashboard-parity.ts verify          # AFTER — exits 1 on any difference
 *
 * Captures every commission, HST, referral and dashboard total the application computes — for every
 * transaction and every role — and compares them for EXACT equality.
 *
 * NO TOLERANCE, deliberately. The dashboard sums commissions in application code, and the query it
 * iterates carries a comment explaining the order is deliberate: "match Laravel's PK-order
 * iteration for identical fp sums". Floating-point addition is not associative, so regrouping the
 * same additions can move a total in the last place. A tolerance would hide precisely the failure
 * this exists to catch, because a sub-cent drift is what eventually rounds into a wrong cheque.
 *
 * It snapshots the PER-TRANSACTION breakdown as well as the totals. Two errors that cancel would
 * leave the totals matching while every individual figure was wrong; comparing breakdowns catches
 * that, comparing totals cannot.
 *
 * The baseline is written to scripts/.dashboard-parity.json, which is gitignored — it is a local
 * artefact of one machine's data, not something to commit.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { CommissionService } from '../src/transactions/commission.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import {
  captureParity, parityRoles, diffParity, countNumericLeaves,
} from '../src/dashboard/dashboard-parity.harness';

const MODE = process.argv[2];
const BASELINE = join(__dirname, '.dashboard-parity.json');

if (MODE !== 'capture' && MODE !== 'verify') {
  console.error('  usage: dashboard-parity.ts capture | verify');
  process.exit(2);
}

(async () => {
  const prisma = new PrismaClient();
  const p = prisma as unknown as PrismaService;
  const commission = new CommissionService(p);
  const dashboard = new DashboardService(p, commission);

  const roles = await parityRoles(prisma);
  const t0 = Date.now();
  const snap = await captureParity(p, commission, dashboard, roles, MODE);
  const ms = Date.now() - t0;

  const leaves = countNumericLeaves(snap.perTransaction) + countNumericLeaves(snap.dashboards);
  console.log(`  ${snap.meta.transactions} transactions · ${roles.length} roles · ${leaves} numeric values · ${ms} ms`);

  if (MODE === 'capture') {
    writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
    console.log(`  baseline written — ${BASELINE}`);
    console.log('  now make the change, then run:  npx ts-node scripts/dashboard-parity.ts verify');
    await prisma.$disconnect();
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error('  no baseline — run "capture" against the OLD implementation first.');
    await prisma.$disconnect();
    process.exit(2);
  }

  const before = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (before.meta.transactions !== snap.meta.transactions) {
    // Comparing against a baseline taken over a different set of rows proves nothing.
    console.error(`  BASELINE STALE — captured over ${before.meta.transactions} transactions, now ${snap.meta.transactions}.`);
    console.error('  Re-capture against the old implementation before trusting a verify.');
    await prisma.$disconnect();
    process.exit(2);
  }

  const diffs = diffParity(
    { perTransaction: before.perTransaction, dashboards: before.dashboards },
    { perTransaction: snap.perTransaction, dashboards: snap.dashboards },
  );

  if (!diffs.length) {
    console.log(`  PARITY HOLDS — all ${leaves} values identical to the baseline.`);
    console.log('  Safe to deploy.');
    await prisma.$disconnect();
    return;
  }

  console.error(`\n  PARITY BROKEN — ${diffs.length} difference(s). DO NOT DEPLOY.\n`);
  for (const d of diffs.slice(0, 40)) {
    console.error(`    ${d.path}`);
    console.error(`      before  ${JSON.stringify(d.before)}`);
    console.error(`      after   ${JSON.stringify(d.after)}`);
  }
  if (diffs.length > 40) console.error(`    … and ${diffs.length - 40} more`);
  await prisma.$disconnect();
  process.exit(1);
})();
