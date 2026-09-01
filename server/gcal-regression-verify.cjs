/**
 * PRODUCTION VERIFICATION for the Google Calendar two-way regression test.
 *
 * Read-only and safe on a live server: writes NOTHING, sends NOTHING, prints no secret or token.
 * It does not perform the test — you do that in the UI and in Google Calendar. This checks the
 * parts a person cannot reliably eyeball: duplicates, the outstanding queue, retry state, and
 * whether any Google-generated entry has been adopted again.
 *
 * USAGE — copy to the production server's `server/` directory (beside .env), then, AFTER doing the
 * UI steps of each test:
 *
 *     node gcal-regression-verify.cjs
 *
 * Titles are matched on the "TEST —" prefix from the test plan, so nothing else is touched.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env found in ${ROOT}. Run this from the server/ directory that holds .env.`);
  process.exit(1);
}
const fromFile = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');   // last wins, as dotenv does
}
for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v;

let PrismaClient;
try { ({ PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client'))); }
catch (e) { console.error('Run from server/ (node_modules must be present).', e.message); process.exit(1); }

const t = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

(async () => {
  const prisma = new PrismaClient();
  console.log('='.repeat(78));
  console.log('GOOGLE CALENDAR REGRESSION VERIFICATION');
  console.log('='.repeat(78));

  // ---- the test events you created -----------------------------------------------------------
  const tests = await prisma.calendar_events.findMany({
    where: { title: { startsWith: 'TEST —' } },
    select: {
      id: true, title: true, date: true, time: true, end_time: true, user_id: true, domain: true,
      google_calendar_id: true, google_sync_error: true, google_sync_attempts: true,
      google_sync_next_retry_at: true, last_synced_to_google: true, deleted_at: true, created_by: true,
    },
    orderBy: { id: 'asc' },
  });

  console.log(`\nTEST EVENTS FOUND (title starts "TEST —"): ${tests.length}`);
  for (const e of tests) {
    console.log(`  #${e.id} "${e.title}"`);
    console.log(`      ${t(e.date)} ${e.time ?? ''}${e.end_time ? `–${e.end_time}` : ''}  user=${e.user_id}  domain=${e.domain ?? '—'}  by=${e.created_by ?? '—'}`);
    console.log(`      google event id : ${e.google_calendar_id ?? '(none — not mirrored)'}`);
    console.log(`      last synced     : ${t(e.last_synced_to_google)}`);
    console.log(`      outstanding     : ${e.google_sync_error ? `YES — ${String(e.google_sync_error).slice(0, 110)}` : 'no'}`);
    console.log(`      attempts        : ${e.google_sync_attempts}   next retry: ${t(e.google_sync_next_retry_at)}`);
    console.log(`      deleted         : ${e.deleted_at ? t(e.deleted_at) : 'no'}`);
  }

  // ---- Test 1 / 3 : the CRM-created appointment ----------------------------------------------
  console.log('\nTEST 1/3 — CRM to Google');
  const crmSide = tests.filter((e) => /CRM to Google/i.test(e.title));
  check('exactly one CRM row for the CRM-created test event', crmSide.length === 1, `found ${crmSide.length}`);
  if (crmSide.length === 1) {
    const e = crmSide[0];
    check('it reached Google (a Google event id is stored)', !!e.google_calendar_id);
    check('it is not outstanding', !e.google_sync_error, String(e.google_sync_error ?? '').slice(0, 80));
    check('no retry backlog on it', e.google_sync_attempts === 0, `attempts=${e.google_sync_attempts}`);
  }

  // ---- Test 2 : the Google-created event ------------------------------------------------------
  console.log('\nTEST 2 — Google to CRM');
  const googleSide = tests.filter((e) => /Google to CRM/i.test(e.title));
  check('exactly one CRM row for the Google-created test event', googleSide.length === 1, `found ${googleSide.length}`);
  if (googleSide.length === 1) {
    check('it carries the originating Google event id', !!googleSide[0].google_calendar_id);
  }

  // ---- Test 4 : deletion ----------------------------------------------------------------------
  console.log('\nTEST 4 — deletion of a normal event');
  const deleted = tests.filter((e) => e.deleted_at);
  if (!deleted.length) console.log('  (skipped — no test event has been deleted yet)');
  for (const e of deleted) {
    check(`#${e.id} left no permanent outstanding item`, !e.google_sync_error, String(e.google_sync_error ?? '').slice(0, 90));
  }

  // ---- duplicates: the check a person cannot do by eye ----------------------------------------
  console.log('\nDUPLICATES');
  const linked = await prisma.calendar_events.findMany({
    where: { google_calendar_id: { not: null }, deleted_at: null },
    select: { id: true, user_id: true, title: true, google_calendar_id: true },
  });
  const byGoogleId = new Map();
  for (const e of linked) {
    const key = `${e.user_id}:${e.google_calendar_id}`;
    byGoogleId.set(key, [...(byGoogleId.get(key) ?? []), e]);
  }
  const dupes = [...byGoogleId.entries()].filter(([, rows]) => rows.length > 1);
  check('no Google event is mirrored by two CRM rows for the same user', dupes.length === 0, `${dupes.length} duplicated`);
  for (const [key, rows] of dupes.slice(0, 5)) console.log(`      ${key} -> CRM rows ${rows.map((r) => '#' + r.id).join(', ')}`);

  const titleCounts = new Map();
  for (const e of tests.filter((x) => !x.deleted_at)) titleCounts.set(e.title, (titleCounts.get(e.title) ?? 0) + 1);
  const dupTitles = [...titleCounts.entries()].filter(([, n]) => n > 1);
  check('no test title appears on more than one live CRM row', dupTitles.length === 0,
    dupTitles.map(([ti, n]) => `${ti} ×${n}`).join('; '));

  // ---- Test 5 : the birthday fix --------------------------------------------------------------
  console.log('\nTEST 5 — birthday / eventTypeRestriction protection');
  const restriction = await prisma.calendar_events.count({
    where: { google_sync_error: { contains: 'eventTypeRestriction' } },
  });
  check('no row is queued on an eventTypeRestriction failure', restriction === 0, `${restriction} found`);

  const outstanding = await prisma.calendar_events.groupBy({
    by: ['user_id'],
    where: { google_sync_error: { not: null }, deleted_at: null },
    _count: { _all: true },
  }).catch(() => []);
  const totalOutstanding = outstanding.reduce((n, r) => n + (r._count?._all ?? 0), 0);
  check('the outstanding queue is empty', totalOutstanding === 0, `${totalOutstanding} owed to Google`);
  for (const r of outstanding) console.log(`      user ${r.user_id}: ${r._count?._all} outstanding`);

  const stuck = await prisma.calendar_events.count({
    where: { google_sync_error: { not: null }, google_sync_attempts: { gte: 5 } },
  });
  check('nothing is sitting at the retry cap', stuck === 0, `${stuck} at or past the cap`);

  console.log('\n' + '='.repeat(78));
  console.log(failures === 0
    ? 'ALL DATABASE-OBSERVABLE CHECKS PASSED.'
    : `${failures} CHECK(S) FAILED — see above.`);
  console.log('These checks do NOT replace looking at Google Calendar and the CRM screen.');
  console.log('='.repeat(78));
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('VERIFY ERROR:', e.message); process.exit(1); });
