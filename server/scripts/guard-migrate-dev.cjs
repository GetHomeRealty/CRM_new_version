#!/usr/bin/env node
/**
 * Refuses to let `prisma migrate dev` run against anything that is not a local database.
 *
 * `migrate dev` is a development tool. When it detects drift between the migration history and
 * the database — which a production database acquires easily, through a hand-applied fix or a
 * restored backup — its remedy is to DROP AND RECREATE the database. It asks first, but it is one
 * keystroke and one habit away from deleting every transaction, document and user in the system.
 * Production applies migrations with `prisma migrate deploy`, which only ever plays pending
 * migrations forward and has no reset path at all.
 *
 * Checking NODE_ENV alone would not be worth much. The realistic accident is not someone running
 * this on the server; it is a developer whose .env still points at a remote database running
 * `npm run prisma:migrate` on their own machine, where NODE_ENV is unset and everything looks
 * ordinary. So the host in DATABASE_URL is what decides.
 */
const fs = require('fs');
const path = require('path');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

/** DATABASE_URL as Prisma will see it: a real environment variable wins over the .env file. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function refuse(reason, detail) {
  console.error('\n  Refusing to run `prisma migrate dev`.\n');
  console.error(`  ${reason}\n`);
  if (detail) console.error(`  ${detail}\n`);
  console.error('  `migrate dev` resets the database when it finds drift. To apply migrations to');
  console.error('  a real deployment use:\n');
  console.error('      npm run prisma:deploy        # prisma migrate deploy — forward only\n');
  console.error('  If this really is a throwaway database and you know what you are doing, set');
  console.error('  ALLOW_REMOTE_MIGRATE_DEV=1 for this one command.\n');
  process.exit(1);
}

if (process.env.ALLOW_REMOTE_MIGRATE_DEV === '1') {
  console.warn('  ALLOW_REMOTE_MIGRATE_DEV=1 — running migrate dev without the safety check.');
  process.exit(0);
}

if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
  refuse('NODE_ENV is production.');
}

const url = databaseUrl();
if (!url) {
  refuse('DATABASE_URL is not set, so the target database cannot be identified.');
}

let host;
try {
  host = new URL(url).hostname;
} catch {
  refuse('DATABASE_URL could not be parsed, so the target database cannot be identified.');
}

if (!LOCAL_HOSTS.has(host)) {
  refuse(
    `DATABASE_URL points at "${host}", which is not a local database.`,
    'A remote host is almost always a shared or production database.',
  );
}

// Local database, development environment — this is what migrate dev is for.
