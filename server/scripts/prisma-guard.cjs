/**
 * Makes a failed `prisma generate` impossible to mistake for schema drift.
 *
 * WHAT HAPPENED. An end-to-end test report raised as P1: "Server typecheck baseline fails after
 * Prisma generation — generated Prisma Client still lacks MFA, notification, CRM-trigger,
 * Google-sync and related fields/models referenced by source." The conclusion drawn was that
 * schema.prisma had drifted from the code.
 *
 * IT HAD NOT. Every one of those models is in the checked-in schema and has been for weeks. What
 * actually happened is that `prisma generate` FAILED, on Windows, with:
 *
 *   EPERM: operation not permitted, rename
 *   'node_modules/.prisma/client/query_engine-windows.dll.node.tmp2512' -> '...dll.node'
 *
 * Windows will not let a DLL be replaced while a process has it mapped, and the API holds it the
 * whole time it is running. So generate exits 1, the PREVIOUS client stays exactly where it was,
 * and the next typecheck reports a hundred errors about models "missing" from a client that was
 * simply never rewritten. Nothing about the schema is wrong; the regeneration never happened.
 *
 * That is a bad failure to leave lying around, because every symptom points somewhere else. The
 * error scrolls past in a wall of npm output, and what a person sees afterwards is the typecheck.
 *
 * TWO MODES, ONE FOR EACH HALF OF THE PROBLEM:
 *
 *   --generate   run `prisma generate`, and if it fails because the engine is locked, say so in
 *                words that name the cause and the remedy instead of a temp filename.
 *
 *   --verify     compare the models in schema.prisma against the delegates in the generated
 *                client, and refuse to continue when the client is behind. Wired ahead of
 *                `typecheck`, so the answer to "why does this not compile" arrives as one sentence
 *                about a stale client rather than as the errors that sentence explains.
 *
 * `--verify` is deliberately not an mtime comparison. A fresh checkout, a rebased branch or a
 * `npm ci` all reorder timestamps without meaning anything; what matters is whether the client
 * actually has the models the schema declares.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const CLIENT_TYPES = path.join(ROOT, 'node_modules', '.prisma', 'client', 'index.d.ts');

const say = (msg) => process.stdout.write(`prisma-guard: ${msg}\n`);
const fail = (msg) => { process.stderr.write(`\nprisma-guard: ${msg}\n\n`); process.exit(1); };

/** Model names declared in the schema. */
function schemaModels() {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  return [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

/**
 * Whether the generated client exposes a delegate for a model.
 *
 * Prisma emits `get modelName(): Prisma.modelNameDelegate<...>` on the client type for every model,
 * so the presence of that accessor is the same question as "was this model generated".
 */
function clientHasModel(types, name) {
  return types.includes(`get ${name}()`);
}

const LOCK_HINT = [
  'A running process is holding the Prisma query engine, so the client could not be replaced.',
  '',
  'On Windows a DLL cannot be overwritten while it is loaded. Stop anything running this server',
  'and try again:',
  '',
  '  - the development API (port 8000)',
  '  - the end-to-end API (port 8100)',
  '  - any `npm run start:dev`, `nest start --watch`, or jest worker still alive',
  '',
  'Then run `npm run prisma:generate` again.',
  '',
  'THIS IS NOT SCHEMA DRIFT. The client on disk is the PREVIOUS one, unchanged. A typecheck run',
  'now will report models as missing that are present in schema.prisma — because the file that',
  'would have declared them was never written.',
].join('\n');

function runGenerate() {
  const res = spawnSync('npx', ['prisma', 'generate'], { cwd: ROOT, encoding: 'utf8', shell: true });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  process.stdout.write(output);

  if (res.status === 0) { say('client generated.'); return; }

  // EPERM/EBUSY on the engine binary is the locked-file case, whatever the surrounding wording.
  if (/EPERM|EBUSY|resource busy or locked/i.test(output) && /query[_-]engine|\.dll\.node/i.test(output)) {
    fail(LOCK_HINT);
  }
  fail(`prisma generate failed (exit ${res.status}). The generated client has NOT been updated.`);
}

function verify() {
  if (!fs.existsSync(CLIENT_TYPES)) {
    fail('No generated Prisma Client found. Run `npm run prisma:generate` before typechecking.');
  }
  const types = fs.readFileSync(CLIENT_TYPES, 'utf8');
  const missing = schemaModels().filter((m) => !clientHasModel(types, m));

  if (missing.length) {
    fail([
      `The generated Prisma Client is STALE — ${missing.length} model(s) in schema.prisma are not in it:`,
      '',
      ...missing.map((m) => `  - ${m}`),
      '',
      'The schema is not at fault, and neither is the code that references these. The client was',
      'never regenerated — most often because `prisma generate` failed while the API was running.',
      '',
      'Run `npm run prisma:generate` (stopping the API first if it reports EPERM), then try again.',
    ].join('\n'));
  }
  say(`client is current (${schemaModels().length} models).`);
}

const mode = process.argv[2];
if (mode === '--generate') runGenerate();
else if (mode === '--verify') verify();
else fail('usage: prisma-guard.cjs --generate | --verify');

module.exports = { schemaModels, clientHasModel };
