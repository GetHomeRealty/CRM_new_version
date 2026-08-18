#!/usr/bin/env node
/**
 * Time the reporting module's heaviest reads, so an optimisation can be proved rather than claimed.
 *
 * WHY THIS EXISTS. Every remaining performance finding on the Transaction Desk was reported as a
 * wall-clock number from an environment nobody still has — "39–41 seconds", "13–14 seconds", "8.2
 * seconds". Those are the right numbers to care about and the wrong ones to optimise against,
 * because there is no way to tell whether a change helped, and no way to notice when a query plan
 * regresses six months later. This runs the real HTTP endpoints against the corpus
 * `seed-load-deals.cjs` builds and prints one line per report.
 *
 *   node scripts/measure-reports.cjs                       # every report below, 3 rounds
 *   node scripts/measure-reports.cjs --rounds 5            # more rounds, tighter median
 *   node scripts/measure-reports.cjs --only documentation  # one group
 *   node scripts/measure-reports.cjs --json                # machine-readable, for before/after diffs
 *
 * MEDIAN, NOT MEAN, and the first round is discarded. The first request through a report pays for
 * connection setup, Prisma's query-engine warmup and a cold page cache; including it measures the
 * process starting rather than the report running. A mean would let one outlier — a checkpoint, a
 * background vacuum — move the number more than a real regression would.
 */
const API = process.env.LOAD_API || 'http://localhost:8100';
const PASSWORD = process.env.LOAD_PASSWORD || 'TestPass123!';
const USER = process.env.LOAD_USER || 'superadmin@test.local';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg('rounds', 3));
const ONLY = arg('only', '');
const JSON_OUT = process.argv.includes('--json');

const collect = (headers, jar) => {
  for (const line of (headers.getSetCookie?.() ?? [])) {
    const [pair] = line.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
};
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function signIn(email) {
  const boot = await fetch(`${API}/sanctum/csrf-cookie`, { redirect: 'manual' });
  let jar = collect(boot.headers, {});
  const token = decodeURIComponent(jar['XSRF-TOKEN'] ?? '');
  const res = await fetch(`${API}/api/login`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': token, Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ username: email, password: PASSWORD }),
  });
  if (res.status >= 400) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  jar = collect(res.headers, jar);
  return { cookie: cookieHeader(jar), token: decodeURIComponent(jar['XSRF-TOKEN'] ?? token) };
}

/**
 * The measurements.
 *
 * `group` is what `--only` filters on. `path` is the real endpoint a screen calls, with the same
 * query string the UI sends — an unfiltered first page, which is the case that hurts and the case
 * an office user actually lands on.
 */
/** A report read: `POST /api/reports/:type/search`, the same call the screen makes. */
const report = (group, name, type, filters = {}) => ({
  group, name, method: 'POST',
  path: `/api/reports/${type}/search`,
  body: { filters, page: 1, per_page: 25 },
});

const CASES = [
  // ---- Documentation and Compliance: the six reports, unfiltered, page 1 ----
  report('documentation', 'Deal Documentation Status',        'deal-documentation-status'),
  report('documentation', 'RECO Audit Readiness',             'reco-audit-readiness'),
  report('documentation', 'Pending and Invalid Documents',    'pending-invalid-documents'),
  report('documentation', 'Amendment Documentation',          'amendment-documentation'),
  report('documentation', 'Conditional Offers and Expiry',    'conditional-offers'),
  report('documentation', 'Documentation Reminder/Follow-Up', 'documentation-reminder-followup'),

  // ---- the financial paths the payment status is derived on ----
  report('financial', 'Sales Statement',          'sales-statement'),
  report('financial', 'Transaction Payment Status',  'transaction-payment-status'),
  report('financial', 'Sales Statement (deal_type)',  'sales-statement', { deal_type: ['Residential Buying'] }),

  /*
   * ---- whole-brokerage, unfiltered vs GENUINELY filtered ----
   *
   * THE FILTER KEYS ARE THE ONES `ReportDetailPage.tsx` ACTUALLY SENDS, read off the component
   * rather than guessed. An earlier version of this file used `{ type: 'Sale' }`, which is wrong
   * twice over: the key is `deal_type`, and it is an ARRAY because the control is a MultiSelect.
   * The server's `sanitize` drops what it does not recognise, so the request was accepted, narrowed
   * nothing, and returned all 80,004 rows while looking like a filtered measurement.
   *
   * The values come from `TRANSACTION_TYPES` for the same reason — that is what populates the
   * dropdown, so anything else is a filter no user can select.
   */
  report('brokerage', 'Brokerage Split Commission (all)',        'brokerage-split-commission'),
  report('brokerage', 'Brokerage Split Commission (deal_type)',  'brokerage-split-commission', { deal_type: ['Residential Buying'] }),
  report('brokerage', 'Brokerage Split Commission (year)',       'brokerage-split-commission', { year: '2025' }),
  report('brokerage', 'Brokerage Split Commission (date range)', 'brokerage-split-commission', { closing_date_from: '2025-01-01', closing_date_to: '2025-03-31' }),
  report('brokerage', 'Yearly Deal Summary (all)',               'yearly-deal-summary'),
  report('brokerage', 'Yearly Deal Summary (deal_type)',         'yearly-deal-summary', { deal_type: ['Residential Buying'] }),

  // ---- audit paging vs audit text search ----
  { group: 'audit', name: 'Audit page (no search)', method: 'GET', path: '/api/audit-logs?page=1' },
  { group: 'audit', name: 'Audit text search',      method: 'GET', path: '/api/audit-logs?page=1&q=NEEDLEXYZ' },
  // A term that matches NOTHING, which is the worst case: every row is scanned and none short-circuit.
  { group: 'audit', name: 'Audit search (no match)', method: 'GET', path: '/api/audit-logs?page=1&q=ZZZNOTHINGMATCHES' },
];

const ms = (n) => `${n.toFixed(0)} ms`;
const pretty = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : ms(n));

async function time(session, c) {
  const init = {
    method: c.method ?? 'GET',
    headers: {
      Accept: 'application/json', Cookie: session.cookie,
      'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': session.token,
    },
  };
  if (c.body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(c.body); }

  const t0 = process.hrtime.bigint();
  const res = await fetch(`${API}${c.path}`, init);
  const body = await res.text();          // drain, so the timing includes transfer
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6, status: res.status, bytes: body.length, body };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Refuse to measure a corpus that is not the one these numbers mean anything against.
 *
 * WHY THIS EXISTS. A stale `node dist/main.js` from an earlier run was still holding port 8100, so a
 * freshly started API failed to bind and exited, and this script cheerfully measured the OTHER
 * server — pointed at a different database. Every report came back in single-digit milliseconds and
 * read as a spectacular win. It was an empty database.
 *
 * A timing is only meaningful next to the row count it was measured over, so the row count is what
 * is checked. `--expect 0` skips the guard for a deliberate small-corpus run.
 */
const EXPECT_ROWS = Number(arg('expect', 80004));

async function assertCorpus(session) {
  if (!EXPECT_ROWS) return;
  const probe = await time(session, report('brokerage', 'probe', 'brokerage-split-commission'));
  let rows = null;
  try { rows = JSON.parse(probe.body)?.total_count ?? null; } catch { /* reported below */ }
  if (rows !== EXPECT_ROWS) {
    throw new Error(
      `refusing to measure: expected ${EXPECT_ROWS.toLocaleString()} transactions, the API reports ${rows === null ? '(unreadable)' : rows.toLocaleString()}.\n`
      + `  The server on ${API} is pointed at the wrong database, or the corpus has not been seeded.\n`
      + `  Check for a stale listener:  netstat -ano | grep :8100\n`
      + `  Re-seed:                     node scripts/seed-load-deals.cjs\n`
      + `  Measure a smaller corpus:    --expect <rows>  (0 disables this check)`,
    );
  }
}

async function main() {
  const session = await signIn(USER);
  await assertCorpus(session);
  const cases = CASES.filter((c) => !ONLY || c.group === ONLY);
  const out = [];

  if (!JSON_OUT) {
    console.log('');
    console.log(`  ${API}   user ${USER}   rounds ${ROUNDS} (+1 discarded warm-up)`);
    console.log('');
    console.log('  group          report                             median      rows   status');
    console.log('  ' + '-'.repeat(76));
  }

  for (const c of cases) {
    // Warm-up, discarded. See the header.
    const warm = await time(session, c);
    const runs = [];
    for (let i = 0; i < ROUNDS; i += 1) runs.push((await time(session, c)).ms);

    let rows = '?';
    try {
      const j = JSON.parse(warm.body);
      rows = j?.total ?? j?.totals?.count ?? j?.meta?.total ?? (Array.isArray(j?.data) ? j.data.length : '?');
    } catch { /* a non-JSON body is reported through `status` below */ }

    const med = median(runs);
    out.push({ group: c.group, name: c.name, path: c.path, median_ms: Math.round(med), status: warm.status, rows });

    if (!JSON_OUT) {
      const flag = warm.status >= 400 ? '  <-- FAILED' : '';
      console.log(`  ${c.group.padEnd(14)} ${c.name.padEnd(34)} ${pretty(med).padStart(9)} ${String(rows).padStart(9)}   ${warm.status}${flag}`);
    }
  }

  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('');
    const slow = out.filter((o) => o.median_ms >= 1000).sort((a, b) => b.median_ms - a.median_ms);
    if (slow.length) {
      console.log('  Over one second:');
      for (const s of slow) console.log(`    ${pretty(s.median_ms).padStart(9)}  ${s.name}`);
      console.log('');
    }
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
