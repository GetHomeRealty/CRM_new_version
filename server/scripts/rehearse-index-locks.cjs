/**
 * Samples what `leads` is locked by, and who is waiting, while an index is built beside it.
 *
 * The claim being tested is narrow and worth stating exactly: `CREATE INDEX CONCURRENTLY` takes a
 * SHARE UPDATE EXCLUSIVE lock, which does NOT conflict with the ROW EXCLUSIVE that INSERT/UPDATE
 * take, so ordinary lead traffic continues. The failure mode it replaces — a plain CREATE INDEX —
 * takes ACCESS EXCLUSIVE and blocks every reader and writer for the duration.
 *
 * This records the lock modes actually held and any session actually waiting, once a second, so the
 * runbook rests on an observation rather than on the documentation.
 *
 *   node scripts/rehearse-index-locks.cjs --seconds 180 --out locks.json
 */
const { Client } = require('pg');
const { writeFileSync, readFileSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');

const SERVER = resolve(dirname(__filename), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', 120));
const OUT = arg('out', '');

function databaseUrl() {
  if (process.env.REHEARSAL_DATABASE_URL) return process.env.REHEARSAL_DATABASE_URL;
  const line = readFileSync(join(SERVER, '.env'), 'utf8').split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}
function libpq(url) {
  const u = new URL(url);
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) u.searchParams.delete(p);
  return u.toString();
}

const LOCKS = `
  SELECT l.mode, l.granted, count(*) AS n
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
   WHERE c.relname IN ('leads','leads_email_lower_idx','leads_owner_email_key')
   GROUP BY 1,2 ORDER BY 1,2`;

const WAITING = `
  SELECT count(*) AS waiting
    FROM pg_stat_activity
   WHERE wait_event_type = 'Lock' AND datname = current_database()`;

const BUILDING = `
  SELECT count(*) AS building
    FROM pg_stat_activity
   WHERE datname = current_database() AND query ILIKE 'CREATE%INDEX%CONCURRENTLY%' AND state = 'active'`;

async function main() {
  const c = new Client({ connectionString: libpq(databaseUrl()) });
  await c.connect();

  const samples = [];
  const modesSeen = new Set();
  let maxWaiting = 0;
  let sawBuild = false;

  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    const [locks, waiting, building] = await Promise.all([c.query(LOCKS), c.query(WAITING), c.query(BUILDING)]);
    const w = Number(waiting.rows[0].waiting);
    const b = Number(building.rows[0].building);
    if (b > 0) sawBuild = true;
    maxWaiting = Math.max(maxWaiting, w);
    for (const r of locks.rows) modesSeen.add(`${r.mode}${r.granted ? '' : ' (WAITING)'}`);
    samples.push({ t: new Date().toISOString(), building: b, waiting: w, locks: locks.rows.map((r) => `${r.mode}${r.granted ? '' : '!'}×${r.n}`) });
    await new Promise((r) => setTimeout(r, 1000));
  }
  await c.end();

  const blocking = [...modesSeen].filter((m) => /AccessExclusiveLock/i.test(m));
  const summary = {
    seconds: SECONDS,
    saw_concurrent_build: sawBuild,
    lock_modes_observed: [...modesSeen].sort(),
    access_exclusive_observed: blocking,
    max_sessions_waiting_on_a_lock: maxWaiting,
    samples,
  };

  console.log(`\n  observed for ${SECONDS}s`);
  console.log(`  concurrent build seen ......... ${sawBuild ? 'yes' : 'NO — the build may have finished before sampling started'}`);
  console.log(`  lock modes on leads ........... ${[...modesSeen].sort().join(', ') || '(none)'}`);
  console.log(`  ACCESS EXCLUSIVE observed ..... ${blocking.length ? 'YES — ' + blocking.join(', ') : 'no'}`);
  console.log(`  max sessions waiting on a lock  ${maxWaiting}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify(summary, null, 2)); console.log(`  written → ${OUT}`); }
  if (blocking.length) { console.error('\n  ACCESS EXCLUSIVE was taken — this is NOT the non-blocking path.'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
