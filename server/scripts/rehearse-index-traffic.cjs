/**
 * Ordinary lead traffic, run against a database while an index is being built beside it.
 *
 * WHY THIS EXISTS. `CREATE INDEX CONCURRENTLY` is documented not to block writes, and the migration
 * runbook depends on that being true here rather than true in general. A rehearsal that only times
 * the build proves the build finishes; it does not prove the brokerage could have kept working
 * while it ran. This drives the four operations that actually matter on the `leads` table and
 * records, per operation, whether it succeeded and how long it took.
 *
 *   create      a lead arriving from a form or typed into the CRM
 *   update      an agent editing one
 *   list        the lead list, page 1, scoped to one agent
 *   duplicate   the "is this address already here?" check that runs on every create and import
 *
 * Raw SQL over `pg` rather than Prisma, deliberately: the rehearsal database is in the PRE-migration
 * shape and the generated client is post-migration, so an ORM would be testing its own mapping
 * rather than the database's behaviour under DDL.
 *
 *   node scripts/rehearse-index-traffic.cjs --seconds 120 --out traffic.json
 *
 * Exits non-zero if any operation failed, so a blocked write cannot be mistaken for a clean run.
 */
const { Client } = require('pg');
const { writeFileSync, readFileSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');

const SERVER = resolve(dirname(__filename), '..');

function databaseUrl() {
  if (process.env.REHEARSAL_DATABASE_URL) return process.env.REHEARSAL_DATABASE_URL;
  const line = readFileSync(join(SERVER, '.env'), 'utf8').split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', 60));
const OUT = arg('out', '');

/** libpq does not understand Prisma's query parameters. */
function libpq(url) {
  const u = new URL(url);
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) u.searchParams.delete(p);
  return u.toString();
}

const stats = {};
function record(op, ms, err) {
  const s = (stats[op] ??= { ok: 0, failed: 0, ms: [], errors: [] });
  if (err) { s.failed++; if (s.errors.length < 5) s.errors.push(String(err.message || err)); }
  else { s.ok++; s.ms.push(ms); }
}

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

async function main() {
  const url = libpq(databaseUrl());
  const db = (url.split('/').pop() || '').split('?')[0];
  if (/prod/i.test(db)) { console.error(`Refusing to generate write traffic against "${db}".`); process.exit(1); }

  const c = new Client({ connectionString: url });
  await c.connect();

  // A real agent to own the traffic, and a lead of theirs to edit.
  const owner = (await c.query(`SELECT id FROM users WHERE email = 'agent@test.local' LIMIT 1`)).rows[0]
             ?? (await c.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0];
  const editable = (await c.query(`SELECT id FROM leads WHERE owner_user_id = $1 LIMIT 1`, [owner.id])).rows[0]
                ?? (await c.query(`SELECT id FROM leads ORDER BY id LIMIT 1`)).rows[0];

  console.log(`traffic → ${db}  owner=${owner.id}  for ${SECONDS}s`);

  const started = Date.now();
  const deadline = started + SECONDS * 1000;
  let n = 0;

  while (Date.now() < deadline) {
    n++;
    const stamp = `${process.pid}-${n}-${Date.now()}`;

    // CREATE — the path the unique index actually guards.
    let t = Date.now();
    try {
      await c.query(
        `INSERT INTO leads (name, email, owner_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [`Rehearsal ${stamp}`, `rehearsal.${stamp}@traffic.test`, owner.id],
      );
      record('create', Date.now() - t);
    } catch (e) { record('create', 0, e); }

    // DUPLICATE CHECK — brokerage-wide lookup by lower(email).
    t = Date.now();
    try {
      await c.query(`SELECT id FROM leads WHERE lower(email) = lower($1) LIMIT 1`, [`rehearsal.${stamp}@traffic.test`]);
      record('duplicate', Date.now() - t);
    } catch (e) { record('duplicate', 0, e); }

    // UPDATE — an agent editing an existing record.
    t = Date.now();
    try {
      await c.query(`UPDATE leads SET notes = $1, updated_at = now() WHERE id = $2`, [`touched ${stamp}`, editable.id]);
      record('update', Date.now() - t);
    } catch (e) { record('update', 0, e); }

    // LIST — the lead list, page 1, scoped to one agent.
    t = Date.now();
    try {
      await c.query(
        `SELECT id, name, email, lead_status FROM leads
          WHERE deleted_at IS NULL AND (owner_user_id = $1 OR assigned_to = $1)
          ORDER BY id DESC LIMIT 25`,
        [owner.id],
      );
      record('list', Date.now() - t);
    } catch (e) { record('list', 0, e); }
  }

  // Remove only what this script created.
  const cleaned = await c.query(`DELETE FROM leads WHERE email LIKE 'rehearsal.%@traffic.test'`);
  await c.end();

  const elapsed = (Date.now() - started) / 1000;
  const summary = { database: db, seconds: Number(elapsed.toFixed(1)), iterations: n, cleaned: cleaned.rowCount, operations: {} };
  let anyFailed = false;

  console.log(`\n  op          ok   failed    p50     p95     p99     max`);
  for (const [op, s] of Object.entries(stats)) {
    if (s.failed) anyFailed = true;
    summary.operations[op] = {
      ok: s.ok, failed: s.failed,
      p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95), p99: pct(s.ms, 0.99),
      max: s.ms.length ? Math.max(...s.ms) : 0,
      errors: s.errors,
    };
    const o = summary.operations[op];
    console.log(`  ${op.padEnd(10)} ${String(o.ok).padStart(5)} ${String(o.failed).padStart(7)} ${String(o.p50).padStart(6)}ms ${String(o.p95).padStart(5)}ms ${String(o.p99).padStart(5)}ms ${String(o.max).padStart(5)}ms`);
    for (const e of o.errors) console.log(`      error: ${e}`);
  }
  console.log(`\n  ${n} iterations in ${elapsed.toFixed(1)}s; removed ${cleaned.rowCount} rehearsal leads.`);

  if (OUT) { writeFileSync(OUT, JSON.stringify(summary, null, 2)); console.log(`  written → ${OUT}`); }
  if (anyFailed) { console.error('\n  FAILURES RECORDED — writes did not remain available throughout.'); process.exit(1); }
  console.log('\n  every operation succeeded throughout.');
}

main().catch((e) => { console.error(e); process.exit(1); });
