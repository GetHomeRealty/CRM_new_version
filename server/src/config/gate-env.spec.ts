import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const gateEnv = require('../../scripts/gate-env.cjs') as {
  parseEnvFile: (file: string) => Record<string, string>;
  resolveTestDatabaseUrl: (o: { root: string; env?: NodeJS.ProcessEnv }) => { url: string | null; from: string | null };
  SAFE_MAIL_ENV: Record<string, string>;
};

/**
 * That `node scripts/test-gate.cjs` finds its own database, and hands the suite a sealed mailbox.
 *
 * THE FAILURE THIS PINS. The gate spawns jest, and jest needs `TEST_DATABASE_URL` to know which
 * database it may write to and roll back. That variable lives in `server/.env` — and nothing in a
 * plain `node scripts/test-gate.cjs` read it, because Prisma only loads that file when a client is
 * constructed, inside the workers, long after the choice has been made. So the gate refused to run
 * and worked only as `node -r dotenv/config scripts/test-gate.cjs`: a detail nobody remembers, on
 * the one script that stands between a bad build and production.
 *
 * WHY THESE TESTS AND NOT A SPAWN OF THE GATE. Running the gate runs the whole suite, which is what
 * the gate is for and is not something a unit test should do. The discovery is therefore its own
 * module, and this asserts the module — plus that `test-gate.cjs` really uses it, which is the part
 * a green unit test could otherwise hide.
 */
describe('the deployment gate finds TEST_DATABASE_URL by itself', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gate-env-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const root = (body: string): string => {
    const d = mkdtempSync(join(dir, 'root-'));
    writeFileSync(join(d, '.env'), body);
    return d;
  };

  it('reads it out of server/.env when the environment does not carry it', () => {
    const d = root('DATABASE_URL=postgresql://u:p@h:5432/live\nTEST_DATABASE_URL=postgresql://u:p@h:5432/myapp_gate_test\n');
    const got = gateEnv.resolveTestDatabaseUrl({ root: d, env: {} });
    expect(got.url).toBe('postgresql://u:p@h:5432/myapp_gate_test');
    expect(got.from).toBe(join(d, '.env'));
  });

  it('lets an explicit environment value win over the file', () => {
    const d = root('TEST_DATABASE_URL=postgresql://u:p@h:5432/from_file\n');
    const got = gateEnv.resolveTestDatabaseUrl({ root: d, env: { TEST_DATABASE_URL: 'postgresql://u:p@h:5432/from_env' } });
    expect(got.url).toBe('postgresql://u:p@h:5432/from_env');
    expect(got.from).toBe('environment');
  });

  it('NEVER falls back to DATABASE_URL, which is the live database', () => {
    // The whole point of the branch. A default that quietly used the production connection string
    // is the fault being removed, not a convenience worth keeping.
    const d = root('DATABASE_URL=postgresql://u:p@h:5432/myapp\n');
    const got = gateEnv.resolveTestDatabaseUrl({ root: d, env: {} });
    expect(got.url).toBeNull();
    expect(got.from).toBeNull();
  });

  it('reports nothing rather than guessing when there is no .env at all', () => {
    const d = mkdtempSync(join(dir, 'empty-'));
    expect(gateEnv.resolveTestDatabaseUrl({ root: d, env: {} }).url).toBeNull();
  });

  describe('parsing the file the way dotenv would', () => {
    it('keeps the LAST assignment, which is the duplicate-key trap', () => {
      const d = root('TEST_DATABASE_URL=postgresql://u:p@h:5432/first\nTEST_DATABASE_URL=postgresql://u:p@h:5432/second\n');
      expect(gateEnv.resolveTestDatabaseUrl({ root: d, env: {} }).url).toBe('postgresql://u:p@h:5432/second');
    });

    it('strips surrounding quotes, accepts `export`, and ignores comments and blanks', () => {
      const d = root([
        '# a comment',
        '',
        'export TEST_DATABASE_URL="postgresql://u:p@h:5432/quoted"',
        'NOT_AN_ASSIGNMENT',
      ].join('\n'));
      expect(gateEnv.resolveTestDatabaseUrl({ root: d, env: {} }).url).toBe('postgresql://u:p@h:5432/quoted');
    });

    it('does not trip over a value containing an equals sign', () => {
      const d = root('TEST_DATABASE_URL=postgresql://u:p@h:5432/db?schema=public&x=1\n');
      expect(gateEnv.resolveTestDatabaseUrl({ root: d, env: {} }).url).toBe('postgresql://u:p@h:5432/db?schema=public&x=1');
    });
  });

  describe('the gate actually uses it, and seals the mail on the way', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'scripts', 'test-gate.cjs'), 'utf8');

    it('resolves the database in the gate rather than relying on the caller', () => {
      expect(source).toMatch(/require\('\.\/gate-env\.cjs'\)/);
      expect(source).toMatch(/resolveTestDatabaseUrl\(/);
    });

    it('stops with an explanation instead of running against whatever it inherited', () => {
      expect(source).toMatch(/no TEST_DATABASE_URL/);
      expect(source).toMatch(/process\.exit\(1\)/);
    });

    it('builds the child environment explicitly, so the host\'s mail settings are not inherited', () => {
      expect(source).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.SAFE_MAIL_ENV/);
    });

    it('hands the suite settings that cannot reach anybody', () => {
      // Production's own settings say "send for real", correctly. These are what jest gets instead.
      // The redirect is CLEARED rather than pointed somewhere: services read that variable to choose
      // a recipient, so a value of ours would rewrite routing instead of only the destination. Empty
      // leaves `MailerService.redirectTarget()` to divert everything to its own unroutable default.
      expect(gateEnv.SAFE_MAIL_ENV.MAIL_REDIRECT_TO).toBe('');
      expect(['1', 'true', 'yes', 'on'])
        .not.toContain(String(gateEnv.SAFE_MAIL_ENV.MAIL_ALLOW_REAL_SEND).toLowerCase());
    });

    it('never prints the connection string, only the database name', () => {
      // The gate logs which database it chose; that line must not carry the password.
      expect(source).toMatch(/function maskDb/);
      expect(source).toMatch(/maskDb\(testDb\.url\)/);
    });
  });
});
