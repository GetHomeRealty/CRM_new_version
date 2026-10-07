import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

/*
 * 2026-10-07 - THE DEPLOY BRINGS THE GATE'S TEST DATABASE UP TO DATE ITSELF.
 *
 * Nothing migrated the practice database the gate runs on, so after every schema change somebody
 * had to remember to (2 Oct: 15 migrations behind; 6 Oct: done by hand for TD-204). This lifts the
 * real block out of deploy.sh and RUNS it in a scratch folder with a stand-in apply-migrations.sh
 * that only records which database it was pointed at.
 */
const DEPLOY = readFileSync(path.join(__dirname, '../../scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n');
const block = /^TEST_DB_URL=\$\([\s\S]*?^fi\n/m.exec(DEPLOY)?.[0];

function run(envLine: string): { code: number; out: string; called: string } {
  if (!block) throw new Error('deploy.sh no longer has the test-database block this spec runs');
  const dir = mkdtempSync(path.join(tmpdir(), 'td-testdb-'));
  mkdirSync(path.join(dir, 'scripts'));
  writeFileSync(path.join(dir, '.env'), envLine + '\n');
  writeFileSync(path.join(dir, 'scripts', 'apply-migrations.sh'), 'echo "$DATABASE_URL" > called.txt\n');
  writeFileSync(path.join(dir, 'run.sh'), `set -euo pipefail\ncd "${dir.replace(/\\/g, '/')}"\n${block}echo "==> after the block"\n`);
  let code = 0; let out = '';
  try { out = execFileSync('bash', [path.join(dir, 'run.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { const x = e as { status?: number; stdout?: string }; code = x.status ?? 1; out = String(x.stdout ?? ''); }
  let called = '';
  try { called = readFileSync(path.join(dir, 'called.txt'), 'utf8').trim(); } catch { called = ''; }
  rmSync(dir, { recursive: true, force: true });
  return { code, out, called };
}

describe('the deploy migrates the gate\'s test database', () => {
  it('applies the database changes to the test database named in TEST_DATABASE_URL', () => {
    const r = run('TEST_DATABASE_URL="postgresql://u:p@127.0.0.1:5432/myapp_gate_test?schema=public"');
    expect(r.code).toBe(0);
    expect(r.called).toBe('postgresql://u:p@127.0.0.1:5432/myapp_gate_test?schema=public');
    expect(r.out).toContain('==> after the block');
  });

  it('refuses, and touches nothing, when the name does not look like a test database', () => {
    const r = run('TEST_DATABASE_URL="postgresql://u:p@127.0.0.1:5432/myapp?schema=public"');
    expect(r.code).not.toBe(0);
    expect(r.called).toBe('');
    expect(r.out).toMatch(/does not look like a test database/);
  });

  it('does nothing at all when no test database is configured', () => {
    const r = run('SOMETHING_ELSE=1');
    expect(r.code).toBe(0);
    expect(r.called).toBe('');
  });

  it('runs before the build and the gate', () => {
    const step = DEPLOY.indexOf('\nTEST_DB_URL=$(');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(DEPLOY.indexOf('\nnpm run build ||'));
    expect(step).toBeLessThan(DEPLOY.indexOf('\nnode scripts/test-gate.cjs'));
  });
});
