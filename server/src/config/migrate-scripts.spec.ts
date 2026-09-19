import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * `prisma migrate dev` resets the database when it finds drift, and a production database
 * acquires drift easily — a hand-applied fix, a restored backup. Production applies migrations
 * with `migrate deploy`, which only plays pending migrations forward and has no reset path.
 *
 * These assertions exist because the protection is one careless edit away from being gone: drop
 * the guard from the npm script and everything still appears to work, right up until the day it
 * does not.
 */
const serverDir = path.join(__dirname, '..', '..');
const scripts = (JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

/** Run the guard with an environment, returning its exit code. */
const runGuard = (env: Record<string, string>): number => {
  try {
    execFileSync(process.execPath, ['scripts/guard-migrate-dev.cjs'], {
      cwd: serverDir,
      env: { ...process.env, NODE_ENV: '', ALLOW_REMOTE_MIGRATE_DEV: '', ...env },
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
};

describe('migration scripts', () => {
  it('offers a forward-only command for production', () => {
    /*
     * THIS ASSERTED ONE EXACT STRING - 'prisma migrate deploy' - and TD-200 changed what that
     * script runs, on 2026-09-19. The application's database user owns 2 of the 104 tables, so
     * `prisma migrate deploy` fails with "must be owner of table ..." AND records that failure,
     * blocking every later migrate until somebody clears it by hand. prisma:deploy now runs
     * scripts/apply-migrations.sh, which applies each migration as the owner; the raw command is
     * kept as prisma:deploy:raw and is still asserted below.
     *
     * THE PROMISE THIS CASE EXISTS FOR IS FORWARD-ONLY, NOT A PARTICULAR SPELLING. So it is
     * asserted as that, and asserted INSIDE the script rather than at its name - which is stricter
     * than before, because the old form could not see what a script did.
     *
     * `migrate resolve --rolled-back` is deliberately allowed: it marks a FAILED attempt as not
     * applied in Prisma's own tracking table. It reverts no schema - that failure is precisely why
     * nothing was applied.
     */
    const cmd = scripts['prisma:deploy'];
    expect(cmd).toBeTruthy();
    expect(scripts['prisma:deploy:raw']).toBe('prisma migrate deploy');

    const body = cmd.includes('apply-migrations.sh')
      ? fs.readFileSync(path.join(serverDir, 'scripts', 'apply-migrations.sh'), 'utf8')
      : cmd;
    // Comments explain the commands that must not RUN, so only executable lines are judged.
    const runnable = body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const destructive of ['migrate dev', 'migrate reset', 'db push', '--force-reset', 'DROP DATABASE']) {
      expect(runnable).not.toContain(destructive);
    }
  });

  it('keeps migrate dev behind the guard', () => {
    // Both halves matter: the guard must run, and it must run BEFORE prisma.
    expect(scripts['prisma:migrate']).toMatch(/^node scripts\/guard-migrate-dev\.cjs && prisma migrate dev$/);
  });

  it('never puts `migrate dev` in any other script', () => {
    for (const [name, cmd] of Object.entries(scripts)) {
      if (name === 'prisma:migrate') continue;
      expect(cmd).not.toContain('migrate dev');
    }
  });

  describe('the guard itself', () => {
    it('allows a local database in development — what migrate dev is for', () => {
      expect(runGuard({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/app' })).toBe(0);
      expect(runGuard({ DATABASE_URL: 'postgresql://u:p@localhost:5432/app' })).toBe(0);
    });

    it('refuses a remote database — the accident that actually happens', () => {
      // A developer whose .env still points at a shared database, running this on their own
      // machine where NODE_ENV is unset and nothing looks unusual.
      expect(runGuard({ DATABASE_URL: 'postgresql://u:p@db.prod.example.com:5432/app' })).toBe(1);
      expect(runGuard({ DATABASE_URL: 'postgresql://u:p@10.0.0.5:5432/app' })).toBe(1);
    });

    it('refuses when NODE_ENV is production, even against a local URL', () => {
      expect(runGuard({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/app' })).toBe(1);
    });

    it('refuses when the target cannot be identified at all', () => {
      expect(runGuard({ DATABASE_URL: 'not-a-url' })).toBe(1);
    });

    it('allows a deliberate, explicit override', () => {
      expect(runGuard({
        DATABASE_URL: 'postgresql://u:p@db.prod.example.com:5432/app',
        ALLOW_REMOTE_MIGRATE_DEV: '1',
      })).toBe(0);
    });
  });
});
