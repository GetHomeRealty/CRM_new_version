#!/usr/bin/env node
/**
 * Restore a backup set, or verify that one could be restored.
 *
 * Two modes, and the second is the one that matters day to day:
 *
 *   --verify   restore into a scratch database, count what came back, drop it. Proves the set is
 *              usable without touching anything real. This is what a scheduled job should run —
 *              a backup nobody has ever restored is a hope, not a backup.
 *
 *   --into DB  restore into a named database. Refuses to touch the live one unless --force is
 *              given, because the whole point of a restore is that it overwrites.
 *
 * Usage:
 *   node scripts/restore.mjs --set 20260731-010025 --verify
 *   node scripts/restore.mjs --set latest --into myapp_restored
 *   node scripts/restore.mjs --set latest --into myapp --force        (destructive)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const line = readFileSync(join(SERVER, '.env'), 'utf8').split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL is not set');
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

/** Prisma's own query parameters are not libpq's; pg_restore rejects the string with them present. */
function libpqUrl(url, database) {
  const u = new URL(url);
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size']) u.searchParams.delete(p);
  if (database) u.pathname = '/' + database;
  return u.toString();
}

function tool(name) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  const candidates = [];
  for (const major of ['18', '17', '16', '15', '14']) candidates.push(`C:/Program Files/PostgreSQL/${major}/bin/${name}.exe`);
  candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, name);
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  throw new Error(`${name} not found. Set ${name.toUpperCase()} to its full path.`);
}

const backupRoot = resolve(arg('root', process.env.BACKUP_ROOT ?? join(SERVER, '..', 'backups')));
let set = arg('set', 'latest');
if (set === 'latest') {
  const sets = readdirSync(backupRoot).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  if (!sets.length) throw new Error(`No backup sets in ${backupRoot}`);
  set = sets[sets.length - 1];
}
const setDir = join(backupRoot, set);
if (!existsSync(setDir)) throw new Error(`No such backup set: ${setDir}`);

const manifest = JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8'));
const dumpFile = join(setDir, manifest.database.file);

console.log(`backup set ${set}   taken ${manifest.taken_at}`);
console.log(`  schema at ${manifest.schema_migration}`);

// ---- integrity ---------------------------------------------------------------------------------
process.stdout.write('  integrity … ');
const actual = createHash('sha256').update(readFileSync(dumpFile)).digest('hex');
if (actual !== manifest.database.sha256) {
  console.log('FAILED');
  console.error(`    the dump does not match the manifest.\n    expected ${manifest.database.sha256}\n    actual   ${actual}`);
  process.exit(1);
}
console.log(`ok  (${(statSync(dumpFile).size / 1024 / 1024).toFixed(1)} MB, sha256 matches)`);

// ---- where to put it ---------------------------------------------------------------------------
const live = new URL(libpqUrl(databaseUrl())).pathname.replace(/^\//, '');
const verify = flag('verify');
const target = verify ? `restore_check_${Date.now().toString(36)}` : arg('into', null);

if (!target) {
  console.error('  Give --verify or --into <database>.');
  process.exit(2);
}
if (target === live && !flag('force')) {
  console.error(`  Refusing to overwrite the live database "${live}". Pass --force if that is genuinely what you want.`);
  process.exit(3);
}

const psql = tool('psql');
const pgRestore = tool('pg_restore');
const adminUrl = libpqUrl(databaseUrl(), 'postgres');

function sql(url, statement) {
  return execFileSync(psql, ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '-c', statement, url], { encoding: 'utf8' }).trim();
}

console.log(`  target    ${target}${verify ? '  (scratch — dropped afterwards)' : ''}`);
try {
  sql(adminUrl, `DROP DATABASE IF EXISTS "${target}"`);
  sql(adminUrl, `CREATE DATABASE "${target}"`);

  process.stdout.write('  restoring … ');
  // A dump taken with --no-owner may still mention roles that do not exist on this server; that is
  // noise, not failure, so pg_restore's exit code is not treated as fatal on its own. What the set
  // is actually judged on is the row counts below.
  try {
    execFileSync(pgRestore, ['--no-owner', '--no-privileges', '--dbname', libpqUrl(databaseUrl(), target), dumpFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* judged by the counts, not the exit code */ }
  console.log('done');

  // ---- did the data actually come back? --------------------------------------------------------
  const restoredUrl = libpqUrl(databaseUrl(), target);
  const tables = Number(sql(restoredUrl, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`));
  const checks = ['users', 'transactions', 'leads', 'invoices', 'documents', 'audit_logs', 'roles'];
  const counts = {};
  for (const t of checks) {
    try { counts[t] = Number(sql(restoredUrl, `SELECT count(*) FROM "${t}"`)); } catch { counts[t] = null; }
  }

  console.log(`  tables    ${tables}`);
  console.log('  rows      ' + Object.entries(counts).map(([t, n]) => `${t}=${n ?? 'MISSING'}`).join('  '));

  const empty = Object.entries(counts).filter(([, n]) => n === null || n === 0).map(([t]) => t);
  const storageFiles = manifest.storage.files;
  console.log(`  storage   ${storageFiles} files in the set (copy ${join(setDir, 'storage')} over STORAGE_ROOT)`);

  if (empty.length) {
    console.log(`\n  RESTORE INCOMPLETE — these came back empty or missing: ${empty.join(', ')}`);
    process.exitCode = 4;
  } else {
    console.log(`\n  RESTORE VERIFIED — every checked table came back with rows.`);
  }
} finally {
  if (verify) {
    sql(adminUrl, `DROP DATABASE IF EXISTS "${target}"`);
    console.log('  scratch database dropped');
  }
}
