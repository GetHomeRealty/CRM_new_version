#!/usr/bin/env node
/**
 * Take a backup.
 *
 * A backup of this application is TWO things, and either one alone is worthless:
 *
 *   the database   every row, including the paths of uploaded files
 *   the storage    the files those paths point at — documents, FINTRAC identification, signatures,
 *                  the brand logo, user photos, generated exports
 *
 * Restore only the database and every document row resolves to a file that is not there: the API
 * answers, the list renders, and every download 404s. Restore only the storage and nothing knows
 * the files exist. So they are taken together, into one timestamped set, and the manifest records
 * that both are present.
 *
 * Usage:  node scripts/backup.mjs [--out DIR] [--keep N]
 *
 *   --out   where backup sets are written        (default: ../backups, or BACKUP_ROOT)
 *   --keep  how many sets to retain              (default: 14, or BACKUP_KEEP)
 *
 * The dump is PostgreSQL's custom format (-Fc): compressed, and restorable table-by-table, which
 * matters when the thing you need back is one table somebody truncated rather than the whole
 * database.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Read DATABASE_URL without pulling in a dependency just to parse a .env file. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(SERVER, '.env');
  if (!existsSync(envFile)) throw new Error('No DATABASE_URL and no .env file to read one from.');
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL is not set in .env');
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

/**
 * The same URL with Prisma's own query parameters removed.
 *
 * `?schema=public` is Prisma vocabulary, not libpq's — pg_dump rejects the whole connection string
 * with "invalid URI query parameter". The connection details are identical either way; only these
 * client-specific hints have to come off.
 */
function libpqUrl(url) {
  const PRISMA_ONLY = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size'];
  try {
    const u = new URL(url);
    for (const p of PRISMA_ONLY) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

/** pg_dump is not on PATH on a default Windows install, so look where the installer puts it. */
function findPgDump() {
  if (process.env.PG_DUMP) return process.env.PG_DUMP;
  const candidates = [];
  for (const major of ['18', '17', '16', '15', '14']) {
    candidates.push(`C:/Program Files/PostgreSQL/${major}/bin/pg_dump.exe`);
  }
  candidates.push('/usr/bin/pg_dump', '/usr/local/bin/pg_dump', 'pg_dump');
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch { /* try the next one */ }
  }
  throw new Error('pg_dump not found. Set PG_DUMP to its full path.');
}

function storageRoot() {
  const fromEnv = (process.env.STORAGE_ROOT ?? '').trim();
  return fromEnv ? resolve(fromEnv) : resolve(SERVER, '..', 'storage', 'app');
}

/** A stable digest of the dump, so a restore can prove it read the same bytes that were written. */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Copy a directory tree, returning how many files and bytes were taken. */
function copyTree(from, to) {
  let files = 0, bytes = 0;
  if (!existsSync(from)) return { files, bytes };
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name), dst = join(to, entry.name);
    if (entry.isDirectory()) {
      const sub = copyTree(src, dst);
      files += sub.files; bytes += sub.bytes;
    } else if (entry.isFile()) {
      writeFileSync(dst, readFileSync(src));
      files += 1; bytes += statSync(src).size;
    }
  }
  return { files, bytes };
}

function prune(root, keep) {
  const sets = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const doomed = sets.slice(0, Math.max(0, sets.length - keep));
  for (const d of doomed) rmSync(join(root, d), { recursive: true, force: true });
  return doomed;
}

const started = Date.now();
// YYYYMMDD-HHMMSS. Sorts lexicographically, which is what the retention prune relies on.
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
const outRoot = resolve(arg('out', process.env.BACKUP_ROOT ?? join(SERVER, '..', 'backups')));
const keep = Number(arg('keep', process.env.BACKUP_KEEP ?? 14));
const setDir = join(outRoot, stamp);

mkdirSync(setDir, { recursive: true });
console.log(`backup set ${stamp}`);

// ---- 1. the database ------------------------------------------------------------------------
const dumpFile = join(setDir, 'database.dump');
const pgDump = findPgDump();
process.stdout.write('  database … ');
execFileSync(pgDump, ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpFile}`, libpqUrl(databaseUrl())], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
const dumpBytes = statSync(dumpFile).size;
const dumpHash = sha256(dumpFile);
console.log(`${(dumpBytes / 1024 / 1024).toFixed(1)} MB  sha256 ${dumpHash.slice(0, 16)}…`);

// ---- 2. the files the database points at --------------------------------------------------------
process.stdout.write('  storage  … ');
const storage = copyTree(storageRoot(), join(setDir, 'storage'));
console.log(`${storage.files} files, ${(storage.bytes / 1024 / 1024).toFixed(1)} MB`);

// ---- 3. a manifest, so a restore can check what it is holding ------------------------------------
const manifest = {
  taken_at: new Date().toISOString(),
  set: stamp,
  database: { file: 'database.dump', format: 'pg_dump custom (-Fc)', bytes: dumpBytes, sha256: dumpHash },
  storage: { dir: 'storage', source: storageRoot(), files: storage.files, bytes: storage.bytes },
  // Recorded because a dump restored against a different schema version is the failure that looks
  // like success until somebody opens a screen.
  schema_migration: (() => {
    try {
      const dirs = readdirSync(join(SERVER, 'prisma', 'migrations')).filter((d) => /^\d/.test(d)).sort();
      return dirs[dirs.length - 1] ?? null;
    } catch { return null; }
  })(),
  took_ms: Date.now() - started,
};
writeFileSync(join(setDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const pruned = prune(outRoot, keep);
console.log(`  manifest  schema at ${manifest.schema_migration}`);
if (pruned.length) console.log(`  pruned    ${pruned.length} set(s) beyond --keep ${keep}`);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${setDir}`);
