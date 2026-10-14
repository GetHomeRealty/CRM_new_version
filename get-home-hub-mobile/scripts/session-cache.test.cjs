const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/auth/session-cache.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, require });

test('New sessions cannot read old records or late mutation results', () => {
  const old = api.createSessionCache();
  old.setQueryData(['transaction', 1], { private: 'first account' });
  api.disposeSessionCache(old);
  assert.equal(old.getQueryCache().getAll().length, 0);
  const next = api.createSessionCache();
  old.setQueryData(['transaction', 1], { private: 'late save response' });
  assert.equal(next.getQueryData(['transaction', 1]), undefined);
  api.disposeSessionCache(old);
  api.disposeSessionCache(next);
});

test('Disposal aborts in-flight queries and clears mutation records', async () => {
  const client = api.createSessionCache();
  let aborted = false;
  const pending = client.fetchQuery({ queryKey: ['leads'], queryFn: ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; });
  }) }).catch(() => undefined);
  client.getMutationCache().build(client, { mutationKey: ['save-lead'] });
  api.disposeSessionCache(client);
  await pending;
  assert.equal(aborted, true);
  assert.equal(client.getQueryCache().getAll().length, 0);
  assert.equal(client.getMutationCache().getAll().length, 0);
});
