import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

/*
 * TD-206 - A FAILED BUILD DURING A DEPLOY MUST PUT THE RUNNING BUILD BACK.
 *
 * On 2026-10-06 the TD-204 deploy failed to compile because the server's generated Prisma client
 * still described the old documents table. `npm run build` had already deleted dist/ (prebuild runs
 * build-guard --clean) and the compiler then wrote a new dist/ despite the type errors. The script
 * stopped there, and restore_build() was only wired to the boot check and the gate - so the server
 * was left with an unchecked build of the new code that any restart would have loaded.
 *
 * TD-192's first fix was "verified" with bash -n and had not been applied at all. So this spec does
 * not trust the wording: it lifts the real restore_build() and the real build block out of
 * deploy.sh and RUNS them, with stand-in npm/npx commands, against a throwaway folder.
 */

const DEPLOY = readFileSync(path.join(__dirname, '../../scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n');

function lift(): string {
  const fn = /^restore_build\(\) \{\n[\s\S]*?\n\}\n/m.exec(DEPLOY);
  const block = /^echo "==> refreshing the database client \(prisma generate\)"\n[\s\S]*?^npm run build \|\| \{ restore_build; exit 1; \}\n/m.exec(DEPLOY);
  if (!fn || !block) throw new Error('deploy.sh no longer has the restore_build() function and the TD-206 build block this spec runs');
  return fn[0] + block[0];
}

/** Runs the lifted lines in a scratch folder. `failing` picks which stand-in command fails. */
function run(failing: 'npm' | 'npx' | 'none'): { code: number; out: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'td206-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'dist', 'main.js'), 'RUNNING BUILD');
  const shim = (name: string, fails: boolean, body: string) => {
    const f = path.join(bin, name);
    writeFileSync(f, `#!/usr/bin/env bash\n${body}\n${fails ? 'exit 1' : 'exit 0'}\n`);
    chmodSync(f, 0o755);
  };
  // The stand-in build behaves the way the real one did: it empties dist/ and writes new output first.
  shim('npm', failing === 'npm', 'rm -rf dist && mkdir dist && echo "UNCHECKED NEW BUILD" > dist/main.js');
  shim('npx', failing === 'npx', 'true');
  const script = `set -euo pipefail\ncd "${dir.replace(/\\/g, '/')}"\nSTAMP=test\ncp -r dist "dist.bak.$STAMP"\n${lift()}echo "==> reached the step after the build"\n`;
  writeFileSync(path.join(dir, 'run.sh'), script);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  try {
    const out = execFileSync('bash', [path.join(dir, 'run.sh')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, dir };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? ''), dir };
  }
}

const mainJs = (dir: string) => readFileSync(path.join(dir, 'dist', 'main.js'), 'utf8').trim();

describe('TD-206 - the deploy puts the running build back when the build itself fails', () => {
  it('a failed build stops the deploy and leaves the RUNNING build on disk, not the unchecked one', () => {
    const r = run('npm');
    try {
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('putting the previous build back');
      expect(r.out).not.toContain('reached the step after the build');
      expect(mainJs(r.dir)).toBe('RUNNING BUILD');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('a failed prisma generate stops the deploy before anything is built', () => {
    const r = run('npx');
    try {
      expect(r.code).not.toBe(0);
      expect(r.out).not.toContain('==> building');
      expect(mainJs(r.dir)).toBe('RUNNING BUILD');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('a good build carries on to the next step with the new build in place', () => {
    const r = run('none');
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain('reached the step after the build');
      expect(mainJs(r.dir)).toBe('UNCHECKED NEW BUILD');
      expect(existsSync(path.join(r.dir, 'dist.bak.test', 'main.js'))).toBe(true);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('regenerates the database client BEFORE it builds', () => {
    // The commands themselves, at the start of a line - the comment above them mentions both.
    const generate = DEPLOY.indexOf('\nnpx prisma generate ||');
    const build = DEPLOY.indexOf('\nnpm run build ||');
    expect(generate).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(generate).toBeLessThan(build);
    // And no unguarded build line is left behind anywhere in the script.
    expect(DEPLOY).not.toMatch(/^npm run build\s*$/m);
  });
});
