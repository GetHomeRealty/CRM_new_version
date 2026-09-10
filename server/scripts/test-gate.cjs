#!/usr/bin/env node
/*
 * TD-165 - THE TEST SUITE, ENFORCED.
 *
 * Eighteen tests were failing across this repository on 2026-09-10 and nothing said so. One of them
 * was desk-sql-parity, the gate written specifically to stop the two commission engines drifting
 * apart, and it had been red for weeks with 21,723.45 hiding behind it. Another was
 * report-payments-parity, red with 131,544.00 behind it. Both were found by a person deciding to
 * run the suite by hand, which is not a control.
 *
 * WHY A BASELINE RATHER THAN ALL-GREEN. Demanding a clean suite would fail on its first run - there
 * are known failures this gate is not here to fix - and a gate that fails on day one is switched
 * off on day two. So the known failures are RECORDED, by name, in test-baseline.json, and this
 * fails only when something OUTSIDE that list breaks. The list lives in the repository where it can
 * be read and argued with, rather than being a number nobody can name.
 *
 * A BASELINED TEST THAT STARTS PASSING DOES NOT FAIL THE GATE. It prints loudly and tells you how
 * to shrink the list. Blocking a deploy because something got FIXED is how a gate earns a reputation
 * for being in the way.
 *
 *   node scripts/test-gate.cjs            run the gate
 *   node scripts/test-gate.cjs --update   record the CURRENT failures as the new baseline
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'test-baseline.json');
const OUT = path.join(require('os').tmpdir(), 'jest-gate-result.json');
const update = process.argv.includes('--update');

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
process.stdout.write('test-gate: running the suite, this takes about 90 seconds...\n');
spawnSync('npx', ['jest', '--silent', '--json', '--outputFile', OUT], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: true,
});

if (!fs.existsSync(OUT)) {
  console.error('test-gate: jest produced no report at all. Treating that as a failure.');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(OUT, 'utf8'));

// A suite can fail WITHOUT any failed assertion - a compile error, a missing module. Those are
// recorded by suite name so they cannot slip through as "no failed tests".
const failed = [];
for (const suite of report.testResults) {
  const rel = path.relative(ROOT, suite.name).split(path.sep).join('/');
  const asserts = suite.assertionResults || [];
  const bad = asserts.filter((t) => t.status === 'failed');
  for (const t of bad) failed.push(rel + ' :: ' + [...t.ancestorTitles, t.title].join(' > '));
  if (!bad.length && suite.status === 'failed') failed.push(rel + ' :: SUITE FAILED TO RUN');
}
failed.sort();

if (update) {
  fs.writeFileSync(BASELINE, JSON.stringify(failed, null, 2) + '\n');
  console.log('test-gate: baseline written with ' + failed.length + ' known failure(s).');
  console.log('  ' + BASELINE);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : [];
const known = new Set(baseline);
const nowSet = new Set(failed);
const broke = failed.filter((n) => !known.has(n));
const mended = baseline.filter((n) => !nowSet.has(n));

console.log('test-gate: ' + failed.length + ' failing, ' + baseline.length + ' known.');

if (mended.length) {
  console.log('');
  console.log('  ' + mended.length + ' baselined test(s) now PASS. Shrink the list:');
  console.log('      node scripts/test-gate.cjs --update');
  for (const n of mended) console.log('    + ' + n);
}

if (broke.length) {
  console.log('');
  console.error('  ' + broke.length + ' test(s) FAILING THAT WERE NOT KNOWN TO FAIL:');
  for (const n of broke) console.error('    ! ' + n);
  console.error('');
  console.error('  This is what the gate is for. Fix it, or - if it is genuinely acceptable -');
  console.error('  record it deliberately with --update and say why in the commit.');
  process.exit(1);
}

console.log('  no new failures.');
process.exit(0);
