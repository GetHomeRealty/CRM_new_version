/**
 * Verify the ported CommissionService against the captured live-Laravel fixtures:
 * for each transaction, compare summarize() vs the fixture `commission` field and
 * breakdown() vs the fixture `financial` field.
 *
 *   node scripts/test-commission.cjs <fixtureFile>
 */
const { PrismaClient } = require('@prisma/client');
const { CommissionService } = require('../dist/transactions/commission.service');
const { loadCommissionTxn } = require('../dist/transactions/commission.loader');

const FIX = process.argv[2];
const fixtures = require(FIX);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const prisma = new PrismaClient();
  const svc = new CommissionService(prisma);
  let failures = 0;

  for (const id of Object.keys(fixtures)) {
    const d = fixtures[id].data || fixtures[id];
    const input = await loadCommissionTxn(prisma, Number(id));
    if (!input) {
      console.log(`FAIL  #${id}  (not found in Postgres)`);
      failures++;
      continue;
    }
    const summary = svc.summarize(input);
    const financial = await svc.breakdown(input);

    const okSum = eq(summary, d.commission);
    const okFin = eq(financial, d.financial);
    console.log(`${okSum ? 'PASS' : 'FAIL'}  #${id} ${d.type} — commission`);
    if (!okSum) {
      console.log('   laravel:', JSON.stringify(d.commission));
      console.log('   nest   :', JSON.stringify(summary));
    }
    console.log(`${okFin ? 'PASS' : 'FAIL'}  #${id} ${d.type} — financial`);
    if (!okFin) {
      // Show the first differing key to make debugging quick.
      const keys = new Set([...Object.keys(d.financial || {}), ...Object.keys(financial || {})]);
      for (const k of keys) {
        if (!eq(d.financial?.[k], financial?.[k])) {
          console.log(`   ↳ key "${k}":`);
          console.log('      laravel:', JSON.stringify(d.financial?.[k]));
          console.log('      nest   :', JSON.stringify(financial?.[k]));
        }
      }
    }
    if (!okSum) failures++;
    if (!okFin) failures++;
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
