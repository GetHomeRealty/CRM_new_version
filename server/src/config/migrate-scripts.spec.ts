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
    expect(scripts['prisma:deploy']).toBe('prisma migrate deploy');
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
