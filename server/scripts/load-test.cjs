/**
 * Measures the CRM endpoints the audit flagged, against a brokerage-sized database.
 *
 * WHY NOT A GENERIC TOOL. autocannon and k6 hammer one URL at a time and report throughput. The
 * question here is not "how many requests per second" — it is "which of these specific queries
 * falls over first, and at what concurrency", with a session cookie and a CSRF token, as three
 * different roles whose scope filters produce completely different query plans. That is a script.
 *
 *   node scripts/load-test.cjs
 *   LOAD_API=http://localhost:8100 LOAD_CONCURRENCY=25 LOAD_ROUNDS=8 node scripts/load-test.cjs
 *
 * Reports p50/p95/p99 and the worst case, because a mean hides exactly the tail that ruins a
 * screen. A budget is attached to each endpoint and anything over it is called out — an unlabelled
 * number invites the reader to decide 900ms is fine.
 */
const API = process.env.LOAD_API || 'http://localhost:8100';
// Mutable, so one call can be run at a different concurrency without a second measure().
const CONCURRENCY_REF = { value: Number(process.env.LOAD_CONCURRENCY || 20) };
const ROUNDS_REF = { value: Number(process.env.LOAD_ROUNDS || 6) };
const PASSWORD = 'TestPass123!';

const ACCOUNTS = {
  agent: 'agent@test.local',
  superAdmin: 'superadmin@test.local',
};

/** Budgets, in ms at p95. A screen that takes longer than its budget reads as broken. */
const BUDGET = { interactive: 300, list: 800, heavy: 2000 };

async function signIn(email) {
  // The CSRF cookie has to be fetched before the login POST, exactly as the SPA does it.
  // NOT under the /api prefix — main.ts excludes this one route, matching Sanctum's contract.
  const boot = await fetch(`${API}/sanctum/csrf-cookie`, { redirect: 'manual' });
  let jar = collect(boot.headers, {});
  const token = decodeURIComponent(jar['XSRF-TOKEN'] ?? '');

  const res = await fetch(`${API}/api/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': token,
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ username: email, password: PASSWORD }),
  });
  if (res.status >= 400) throw new Error(`login failed for ${email}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  jar = collect(res.headers, jar);
  return { cookie: cookieHeader(jar), token: decodeURIComponent(jar['XSRF-TOKEN'] ?? token) };
}

function collect(headers, jar) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function once(session, method, path, body) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': session.token,
      Cookie: session.cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();               // drain, so the timing includes serialisation
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, status: res.status, bytes: text.length };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/**
 * Run one endpoint under load, spreading the requests across a POOL of signed-in people.
 *
 * `sessions` is an array, and each concurrent request takes the next one. That is not a detail: the
 * application rate-limits per user id (`IdentityThrottlerGuard`, 600/min), so driving a whole run
 * from one account measures the throttler rather than the application — the first attempt at this
 * reported 300/300 failures on four endpoints for exactly that reason, and a single 50-request
 * probe of the same endpoint returned 200 fifty times out of fifty. Hundreds of agents each making
 * a few requests is both the honest measurement and the real production shape.
 */
async function measure(label, sessions, method, path, body, budget) {
  const pool = Array.isArray(sessions) ? sessions : [sessions];
  // One warm-up round outside the measurement: the first hit pays for Prisma's connection pool and
  // Postgres's plan cache, which is real but is not what a working day looks like.
  await once(pool[0], method, path, body).catch(() => undefined);

  const times = [];
  const codes = {};
  let failures = 0;
  let bytes = 0;
  let cursor = 0;
  const started = Date.now();

  for (let round = 0; round < ROUNDS_REF.value; round++) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY_REF.value }, () => {
        const session = pool[cursor++ % pool.length];
        return once(session, method, path, body).catch((e) => ({ ms: -1, status: 0, bytes: 0, err: e }));
      }),
    );
    for (const r of batch) {
      codes[r.status] = (codes[r.status] ?? 0) + 1;
      if (r.status >= 400 || r.status === 0) { failures++; continue; }
      times.push(r.ms);
      bytes += r.bytes;
    }
  }

  const wall = (Date.now() - started) / 1000;
  times.sort((a, b) => a - b);
  const n = times.length || 1;
  return {
    label, path, budget, codes,
    n: times.length, failures,
    p50: pct(times, 50) ?? 0, p95: pct(times, 95) ?? 0, p99: pct(times, 99) ?? 0,
    max: times[times.length - 1] ?? 0,
    rps: times.length / wall,
    kb: Math.round(bytes / n / 1024),
  };
}

const pad = (s, w) => String(s).padEnd(w);
const num = (v, w) => String(Math.round(v)).padStart(w);

function table(rows) {
  console.log(`\n  ${pad('endpoint', 46)}${'p50'.padStart(7)}${'p95'.padStart(8)}${'p99'.padStart(8)}${'max'.padStart(8)}${'req/s'.padStart(8)}${'kB'.padStart(6)}  verdict`);
  console.log(`  ${'-'.repeat(46)}${'-'.repeat(45)}`);
  for (const r of rows) {
    const over = r.p95 > r.budget;
    // Name the status codes rather than just counting failures: a 429 is the rate limiter working
    // and a 500 is the application breaking, and "12 FAILED" cannot tell them apart.
    const bad = Object.entries(r.codes).filter(([c]) => Number(c) >= 400 || c === '0');
    const verdict = bad.length ? bad.map(([c, n]) => `${n}×${c === '0' ? 'ERR' : c}`).join(' ')
      : over ? `OVER BUDGET (${r.budget}ms)` : 'ok';
    console.log(`  ${pad(r.label, 46)}${num(r.p50, 7)}${num(r.p95, 8)}${num(r.p99, 8)}${num(r.max, 8)}${num(r.rps, 8)}${num(r.kb, 6)}  ${verdict}`);
  }
}

async function main() {
  console.log(`\nCRM load test — ${API}`);
  console.log(`  default load: ${CONCURRENCY_REF.value} concurrent × ${ROUNDS_REF.value} rounds\n`);

  const admin = await signIn(ACCOUNTS.superAdmin);

  /*
   * A pool of real agents, signed in for real.
   *
   * LOAD_POOL is how many of the seeded `load-agent-N` accounts take part. Each carries its own
   * session cookie and its own rate-limit budget, so the concurrency below lands on the application
   * rather than on IdentityThrottlerGuard. Their books also differ in size by design — the seed
   * skews ownership — so this exercises a spread of query plans rather than one lucky one.
   */
  const POOL = Number(process.env.LOAD_POOL || 40);
  process.stdout.write(`  signing in ${POOL} agents… `);
  const agents = [];
  for (let i = 0; i < POOL; i += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, POOL - i) }, (_, k) =>
        signIn(`load-agent-${i + k}@load.test`).catch(() => null)),
    );
    agents.push(...batch.filter(Boolean));
  }
  // The seeded agent has the biggest single book (~9,800 leads), so it stays in the pool as the
  // worst case rather than being the only case.
  agents.push(await signIn(ACCOUNTS.agent));
  const agent = agents;
  console.log(`${agents.length} ok`);

  const scale = await once(agents[0], 'GET', '/api/leads?limit=1');
  console.log(`  agent list responds ${scale.status} in ${scale.ms.toFixed(0)}ms\n`);

  const heaviest = agents[agents.length - 1];   // agent@test.local — ~9,800 leads

  const results = [];
  const run = async (...args) => { const r = await measure(...args); results.push(r); return r; };

  /*
   * THE THREE QUESTIONS, asked separately, because one run cannot answer all of them.
   *
   *  1. What does a request COST on the heaviest book? Measured serially, one at a time, so the
   *     number is the query and nothing else — no contention, no queueing, no throttler.
   *  2. Does it hold up under CONCURRENCY? Measured across the agent pool, which is what a
   *     brokerage's traffic actually looks like.
   *  3. What about the ADMIN, whose scope includes all unattributed intake and is therefore the
   *     widest query plan in the module?
   *
   * Reporting only (2) flatters the application, because most seeded agents have small books and
   * the average hides the agent who does not. Reporting only (1) misses queueing entirely.
   */
  const SERIAL = { concurrency: 1, rounds: Number(process.env.LOAD_SERIAL_ROUNDS || 12) };

  console.log('── 1. per-request cost on the heaviest book (~9,800 leads), one at a time ' + '─'.repeat(5));
  await serial('leads list, page 1 (+11 stat counters)', heaviest, 'GET', '/api/leads?page=1&limit=50', undefined, BUDGET.list, results, SERIAL);
  await serial('leads search "smith" (5-col ILIKE)', heaviest, 'GET', '/api/leads?search=smith&limit=50', undefined, BUDGET.list, results, SERIAL);
  await serial('lead tags (registry + scoped scan)', heaviest, 'GET', '/api/leads/tags', undefined, BUDGET.interactive, results, SERIAL);
  await serial('lead tasks feed (paged, 25)', heaviest, 'GET', '/api/leads/tasks', undefined, BUDGET.heavy, results, SERIAL);
  await serial('lead showings feed (paged, 25)', heaviest, 'GET', '/api/leads/showings', undefined, BUDGET.heavy, results, SERIAL);
  await serial('CRM dashboard', heaviest, 'GET', '/api/dashboard/crm', undefined, BUDGET.list, results, SERIAL);
  table(results.splice(0));

  console.log(`\n── 2. under load, spread across ${agents.length} agents ` + '─'.repeat(40));
  await run('leads list, page 1 (+11 stat counters)', agent, 'GET', '/api/leads?page=1&limit=50', undefined, BUDGET.list);
  await run('leads list, page 40 (deep offset)', agent, 'GET', '/api/leads?page=40&limit=50', undefined, BUDGET.list);
  await run('leads search "smith" (5-col ILIKE)', agent, 'GET', '/api/leads?search=smith&limit=50', undefined, BUDGET.list);
  await run('leads filtered (status+source+tag)', agent, 'GET', '/api/leads?leadStatus=hot&leadSource=meta&tag=VIP&limit=50', undefined, BUDGET.list);
  await run('lead tags (registry + scoped scan)', agent, 'GET', '/api/leads/tags', undefined, BUDGET.interactive);
  await run('lead tasks feed (paged, 25)', agent, 'GET', '/api/leads/tasks', undefined, BUDGET.heavy);
  await run('lead showings feed (paged, 25)', agent, 'GET', '/api/leads/showings', undefined, BUDGET.heavy);
  await run('lead options (vocabularies + roster)', agent, 'GET', '/api/leads/options', undefined, BUDGET.interactive);
  await run('CRM dashboard', agent, 'GET', '/api/dashboard/crm', undefined, BUDGET.list);
  table(results.splice(0));

  /*
   * The admin is ONE identity, so its budget is one identity's 600/min — exceed it and the numbers
   * become a measurement of IdentityThrottlerGuard. Concurrency is held low here on purpose; the
   * question for this section is the query plan, not the queue.
   */
  console.log('\n── 3. as a super admin (own book + all unattributed intake), low concurrency ' + '─'.repeat(2));
  const ADMIN = { concurrency: 5, rounds: 6 };
  await serial('leads list, page 1', admin, 'GET', '/api/leads?page=1&limit=50', undefined, BUDGET.list, results, ADMIN);
  await serial('leads search "toronto"', admin, 'GET', '/api/leads?search=toronto&limit=50', undefined, BUDGET.list, results, ADMIN);
  await serial('leads list at max page size (200)', admin, 'GET', '/api/leads?page=1&limit=200', undefined, BUDGET.list, results, ADMIN);
  await serial('lead tags', admin, 'GET', '/api/leads/tags', undefined, BUDGET.interactive, results, ADMIN);
  await serial('books (per-user lead counts)', admin, 'GET', '/api/leads/books', undefined, BUDGET.list, results, ADMIN);
  await serial('CSV export (capped at 5,000)', admin, 'POST', '/api/leads/export', { filters: {}, lead_ids: [] }, BUDGET.heavy, results, ADMIN);
  await serial('campaign audience preview', admin, 'POST', '/api/campaigns/preview', { leadStatus: 'hot' }, BUDGET.heavy, results, ADMIN);
  await serial('suppression list, page 1', admin, 'GET', '/api/campaigns/suppressions?limit=50', undefined, BUDGET.interactive, results, ADMIN);
  table(results.splice(0));

  console.log('');
}

/** `measure` with the concurrency and round count overridden for one call. */
async function serial(label, session, method, path, body, budget, results, opts) {
  const c = CONCURRENCY_REF.value, r = ROUNDS_REF.value;
  CONCURRENCY_REF.value = opts.concurrency;
  ROUNDS_REF.value = opts.rounds;
  try {
    results.push(await measure(label, session, method, path, body, budget));
  } finally {
    CONCURRENCY_REF.value = c;
    ROUNDS_REF.value = r;
  }
}

main().catch((e) => { console.error('\n', e.message, '\n'); process.exit(1); });
