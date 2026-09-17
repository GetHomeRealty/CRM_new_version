/*
 * ================================================================================================
 * WHAT THE DEPLOYMENT GATE NEEDS OUT OF `server/.env`, AND NOTHING ELSE.
 *
 * `scripts/test-gate.cjs` spawns jest, and jest needs `TEST_DATABASE_URL` — the isolated database
 * the suite may write to and roll back. That variable lives in `server/.env`, which nothing in a
 * plain `node scripts/test-gate.cjs` reads: Prisma loads that file when a PrismaClient is built,
 * which happens inside the jest workers, far too late to decide which database they should use.
 *
 * So the gate failed to find it and had to be run as `node -r dotenv/config scripts/test-gate.cjs`
 * — a detail nobody will remember at the point it matters, on a script whose entire purpose is to
 * be run before a deploy. The loader belongs in the gate.
 *
 * WHY NOT JUST REQUIRE DOTENV. It is not a dependency of this package. It is present only because
 * `@nestjs/config` and `prisma` each happen to pull a copy in, at two different versions. A deploy
 * gate that stops working when an unrelated dependency is bumped is a worse problem than the one
 * being fixed, and adding a dependency to ship one `readFileSync` is not a trade worth making.
 *
 * The parsing below is deliberately the same shape the rest of this repo already assumes of the
 * file — `KEY=value` a line at a time, last occurrence winning, surrounding quotes stripped — which
 * is what `local-mail-safety.spec.ts` reads it as and what dotenv does with a file this simple.
 * `export KEY=value` is accepted because a `.env` that has been sourced by a shell often has it.
 * ================================================================================================
 */
const fs = require('fs');
const path = require('path');

/** Parse a `.env` into a plain object. Last assignment wins, exactly as dotenv resolves it. */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;                       // last wins
  }
  return out;
}

/**
 * The database the gate should hand to jest.
 *
 * A value already in the environment WINS over the file, so `TEST_DATABASE_URL=… node
 * scripts/test-gate.cjs` still does what it plainly says. Absent that, the file answers. This never
 * falls back to `DATABASE_URL`: that is the live database, and silently running the suite against
 * it is the fault this whole branch exists to remove — `test/jest-db-guard.cjs` would refuse it
 * anyway, and a clear refusal is the right outcome rather than a surprising default.
 */
function resolveTestDatabaseUrl({ root, env = process.env } = {}) {
  if (env.TEST_DATABASE_URL) return { url: env.TEST_DATABASE_URL, from: 'environment' };
  const file = path.join(root, '.env');
  const parsed = parseEnvFile(file);
  if (parsed.TEST_DATABASE_URL) return { url: parsed.TEST_DATABASE_URL, from: file };
  return { url: null, from: null };
}

/*
 * The mail settings the test process is given, whatever the deployment's own are.
 *
 * PRODUCTION LEGITIMATELY SENDS REAL MAIL, so `server/.env` on the deploy host says so —
 * `MAIL_ALLOW_REAL_SEND=1`, no redirect. Loading that file to find the test database would hand
 * those settings to jest as well, and a spec that reaches a mailer would then be one bug away from
 * emailing a client from a test run.
 *
 * These are forced instead, and `test/jest-mail-guard.cjs` forces them again inside the worker, so
 * neither the deploy host's configuration nor a stray `--env` can put real sending back.
 */
const SAFE_MAIL_ENV = {
  MAIL_ALLOW_REAL_SEND: '0',
  // CLEARED, not set to a sink of our own. Services read this variable directly to choose a
  // recipient, so imposing a value rewrites application routing rather than only the destination.
  // Empty hands the decision to `MailerService.redirectTarget()`, whose safe default for a
  // non-production process is an address reserved by RFC 2606 as unresolvable.
  MAIL_REDIRECT_TO: '',
};

module.exports = { parseEnvFile, resolveTestDatabaseUrl, SAFE_MAIL_ENV };
