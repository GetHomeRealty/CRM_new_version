#!/usr/bin/env node
/**
 * Prove the cached agent-payment columns still match the blob they came from — every row, no sample.
 *
 *   node scripts/verify-payment-cache.cjs                 # every live transaction
 *   node scripts/verify-payment-cache.cjs --limit 5000    # a smaller run while iterating
 *   node scripts/verify-payment-cache.cjs --json          # machine-readable, for a deployment gate
 *
 * WHY EVERY ROW. These columns carry money. A sampled check tells you the common case is right,
 * which was never the doubt: the risk is the deal with a malformed blob, the agent on four
 * preconstruction terms whose payments are counted four times, the paid_date that is not a date.
 * Those are rare by definition and are exactly what a sample misses.
 *
 * WHAT IT COMPARES. The stored column against `PaymentCacheService.computeFor` run fresh — the same
 * function the write path calls, over the same parsers the reports call. So this is not a second
 * implementation checking the first; it is the one implementation checked against what is stored,
 * which is the only difference that can actually appear in production: STALENESS. A row whose blob
 * was written without the cache being recomputed shows up here and nowhere else.
 *
 * EXIT CODE 2 ON ANY MISMATCH, so it can gate a deployment step. Money is compared to the cent.
 */
const path = require('node:path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 0));
const JSON_OUT = process.argv.includes('--json');
const BATCH = 500;

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** Two money values agree if they agree to the cent. Decimal|null|number all arrive here. */
const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const dayOf = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10));

async function main() {
  const dist = path.join(__dirname, '..', 'dist');
  const { PrismaClient } = require('@prisma/client');
  const { PaymentCacheService } = require(path.join(dist, 'transactions', 'payment-cache.service.js'));
  const { CommissionService } = require(path.join(dist, 'transactions', 'commission.service.js'));
  const { PersonResolver } = require(path.join(dist, 'core', 'person-resolver.service.js'));
  const { commissionInclude } = require(path.join(dist, 'transactions', 'commission.loader.js'));

  const prisma = new PrismaClient();
  const db = (process.env.DATABASE_URL || '').split('/').pop()?.split('?')[0] ?? '(unknown)';
  const svc = new PaymentCacheService(prisma, new CommissionService(new PersonResolver(prisma)));

  log('');
  log('==========================================================');
  log('  Agent-payment cache verification');
  log(`  database: ${db}`);
  log('==========================================================');

  const where = { deleted_at: null };
  const ids = (await prisma.transactions.findMany({
    where, select: { id: true }, orderBy: { id: 'asc' }, ...(LIMIT ? { take: LIMIT } : {}),
  })).map((r) => r.id);

  log(`  transactions to check    : ${ids.length.toLocaleString()}`);
  log('');

  const mismatches = [];
  const uncomputed = [];
  let checked = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = await prisma.transactions.findMany({
      where: { id: { in: ids.slice(i, i + BATCH) } },
      include: commissionInclude,
    });

    for (const t of rows) {
      checked += 1;
      /*
       * A row the backfill has not reached is NOT a mismatch. `calc_at` NULL means the reader parses
       * the blob, which is correct — just slow. Counted separately so a partial backfill reads as
       * "unfinished" rather than as "broken", which are very different things to be told.
       */
      if (t.calc_at === null) { uncomputed.push(t.id); continue; }

      let fresh;
      try {
        fresh = await svc.computeFor(t);
      } catch (e) {
        mismatches.push({ id: t.id, field: '(recompute threw)', stored: null, fresh: String(e.message).slice(0, 120) });
        continue;
      }

      const checks = [
        // Money, to the cent. `agentCommission` rounds at every addition, so an exact match is the
        // right bar — a tolerance here would hide precisely the rounding drift worth catching.
        ['calc_agent_comm_total', cents(t.calc_agent_comm_total), cents(fresh.calc_agent_comm_total)],
        ['calc_paid_total', cents(t.calc_paid_total), cents(fresh.calc_paid_total)],
        ['calc_paid_date', dayOf(t.calc_paid_date), dayOf(fresh.calc_paid_date)],
        ['calc_paid_name_count', t.calc_paid_name_count, fresh.calc_paid_name_count],
        ['calc_agent_name_count', t.calc_agent_name_count, fresh.calc_agent_name_count],
        ['calc_faq_paid_status', t.calc_faq_paid_status, fresh.calc_faq_paid_status],
      ];
      for (const [field, stored, expected] of checks) {
        if (stored !== expected) mismatches.push({ id: t.id, field, stored, fresh: expected });
      }
    }

    if (!JSON_OUT) process.stdout.write(`\r  checked ${checked.toLocaleString()}/${ids.length.toLocaleString()}  mismatches ${mismatches.length}`);
  }
  if (!JSON_OUT) process.stdout.write('\n');

  log('');
  log('-- result ---------------------------------------------------');
  log(`  checked                  : ${checked.toLocaleString()}`);
  log(`  not yet computed         : ${uncomputed.length.toLocaleString()}${uncomputed.length ? '   (these read from the blob — correct, just slow)' : ''}`);
  log(`  MISMATCHES               : ${mismatches.length}`);
  for (const m of mismatches.slice(0, 25)) {
    log(`     #${m.id} ${m.field}: stored=${JSON.stringify(m.stored)} recomputed=${JSON.stringify(m.fresh)}`);
  }
  if (mismatches.length > 25) log(`     … and ${mismatches.length - 25} more`);
  log('');
  log(mismatches.length === 0 ? '  RESULT: the cache matches the blob, row for row.' : '  RESULT: STALE OR WRONG — do not rely on the cached columns.');
  log('');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      database: db, checked, uncomputed: uncomputed.length, mismatches: mismatches.length,
      sample: mismatches.slice(0, 50),
    }, null, 2));
  }

  await prisma.$disconnect();
  process.exit(mismatches.length === 0 ? 0 : 2);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
