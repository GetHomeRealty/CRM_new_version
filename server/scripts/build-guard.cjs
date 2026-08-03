/**
 * Makes `npm run build` mean what it says.
 *
 * nest-cli.json sets `deleteOutDir: true` and tsconfig.json sets `incremental: true`. Together
 * those two produce a silent failure: the build wipes dist/, TypeScript then reads a
 * .tsbuildinfo that still claims every file is up to date, emits nothing, and exits 0. The
 * result is an empty dist/ from a build that reported success — `npm run start:prod` dies with
 * MODULE_NOT_FOUND, and CI goes green on the way there.
 *
 * It only bites when a working directory is REUSED — a git pull on the server, a cached CI
 * workspace, a warm Docker layer — because *.tsbuildinfo is gitignored, so a fresh clone has no
 * stale state to trip over. That is exactly the redeploy path, which is the one that matters.
 *
 * SINCE FIXED AT THE SOURCE, and this guard is now the second line rather than the only one.
 * tsconfig.json sets `tsBuildInfoFile: ./dist/.tsbuildinfo`, so the cache lives inside the
 * directory `deleteOutDir` wipes and cannot outlive its own output. That closes the paths this
 * script could never reach: `nest start`, `nest start --watch`, and anyone invoking tsc directly —
 * which is how a developer hit it locally, with a stale cache left behind by a preceding
 * `npm run build`. Keep both: the guard still turns "emitted nothing" into a loud failure rather
 * than a green build, whatever the cause.
 *
 *   --clean    (prebuild)  remove dist/ and every *.tsbuildinfo, so the compiler cannot be
 *                          fooled into thinking there is nothing to do.
 *   --verify   (postbuild) fail loudly if dist/main.js is not there. A build that produces no
 *                          entry point must not be able to report success.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const ENTRY = path.join(SERVER, 'dist', 'main.js');
const mode = process.argv.includes('--verify') ? 'verify' : 'clean';

if (mode === 'clean') {
  fs.rmSync(path.join(SERVER, 'dist'), { recursive: true, force: true });
  let removed = 0;
  for (const f of fs.readdirSync(SERVER)) {
    if (f.endsWith('.tsbuildinfo')) {
      fs.rmSync(path.join(SERVER, f), { force: true });
      removed += 1;
    }
  }
  console.log(`build-guard: cleaned dist/${removed ? ` and ${removed} .tsbuildinfo file(s)` : ''}`);
  process.exit(0);
}

if (!fs.existsSync(ENTRY)) {
  console.error(
    '\nbuild-guard: BUILD PRODUCED NO OUTPUT.\n\n'
    + `  Expected: ${ENTRY}\n\n`
    + '  The compiler exited successfully but emitted nothing — normally a stale *.tsbuildinfo\n'
    + '  surviving a deleted dist/. `npm run build` runs the clean step first, so hitting this\n'
    + '  means something else went wrong; check the compiler output above.\n\n'
    + '  Do NOT deploy this tree: `npm run start:prod` would fail with MODULE_NOT_FOUND.\n',
  );
  process.exit(1);
}

const count = fs.readdirSync(path.join(SERVER, 'dist')).length;
console.log(`build-guard: dist/main.js present (${count} entries in dist/)`);
