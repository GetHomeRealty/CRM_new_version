#!/usr/bin/env node
/**
 * Fill in the derived agent-payment columns on `transactions`.
 *
 *   node scripts/backfill-payment-cache.cjs               # only rows never computed (calc_at NULL)
 *   node scripts/backfill-payment-cache.cjs --all         # every row, recomputed from scratch
 *   node scripts/backfill-payment-cache.cjs --batch 250   # smaller batches on a busy database
 *
 * SAFE TO RUN WHILE THE APPLICATION IS SERVING, and safe to interrupt. It writes five columns that
 * nothing reads until `calc_at` is set on that row, so a half-finished run leaves the un-reached
 * rows behaving exactly as they do today — the reports parse the blob for them. Re-running picks up
 * where it stopped.
 *
 * SAFE TO RUN AGAINST PRODUCTION, unlike the seed scripts beside it: it derives values from data
 * that is already there and writes no business data of its own. There is no test-database guard for
 * that reason — refusing to run here would mean the cache could never be built where it matters.
 *
 * IT USES THE APPLICATION'S OWN CODE. The compiled `PaymentCacheService` is what computes each row,
 * which is the same service the write path calls and the same parsers the reports call. A script
 * with its own copy of the rules would be a third implementation to keep in step; this one cannot
 * drift, because there is nothing in it to drift.
 */
const path = require('node:path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ALL = process.argv.includes('--all');
const BATCH = Number(arg('batch', 500));

async function main() {
  const dist = path.join(__dirname, '..', 'dist');
  const { PrismaClient } = require('@prisma/client');
  const { PaymentCacheService } = require(path.join(dist, 'transactions', 'payment-cache.service.js'));
  const { CommissionService } = require(path.join(dist, 'transactions', 'commission.service.js'));
  const { PersonResolver } = require(path.join(dist, 'core', 'person-resolver.service.js'));

  const prisma = new PrismaClient();
  const db = (process.env.DATABASE_URL || '').split('/').pop()?.split('?')[0] ?? '(unknown)';
  const svc = new PaymentCacheService(prisma, new CommissionService(new PersonResolver(prisma)));

  console.log('');
  console.log('==========================================================');
  console.log(`  Agent-payment cache backfill — ${ALL ? 'ALL ROWS' : 'ONLY UNCOMPUTED'}`);
  console.log(`  database: ${db}`);
  console.log('==========================================================');

  const where = ALL ? { deleted_at: null } : { deleted_at: null, calc_at: null };
  const ids = (await prisma.transactions.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  const total = await prisma.transactions.count({ where: { deleted_at: null } });

  console.log(`  live transactions        : ${total.toLocaleString()}`);
  console.log(`  to compute this run      : ${ids.length.toLocaleString()}`);
  if (ids.length === 0) { console.log('\n  Nothing to do.\n'); await prisma.$disconnect(); return; }

  const started = Date.now();
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    done += await svc.recompute(ids.slice(i, i + BATCH), BATCH);
    const pct = ((i + BATCH) / ids.length * 100).toFixed(0);
    process.stdout.write(`\r  computed ${done.toLocaleString()}/${ids.length.toLocaleString()} (${Math.min(100, pct)}%)`);
  }
  process.stdout.write('\n');

  const remaining = await prisma.transactions.count({ where: { deleted_at: null, calc_at: null } });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log('-- result ---------------------------------------------------');
  console.log(`  rows written             : ${done.toLocaleString()}`);
  console.log(`  still uncomputed         : ${remaining.toLocaleString()}${remaining ? '   <- these still parse the blob on read' : ''}`);
  console.log(`  elapsed                  : ${secs}s`);
  console.log('');
  console.log('  Verify before relying on it:  node scripts/verify-payment-cache.cjs');
  console.log('');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
