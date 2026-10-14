const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup(body, ok = true) {
  const api = {}, calls = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/leads/leads-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok, json: async () => body };
    },
  });
  return { api, calls };
}

test('Tag catalog uses authenticated cancellable read and preserves canonical names', async () => {
  const { api, calls } = setup({ tags: ['VIP', 'VIP', 'vip', 'East, Toronto'], counts: [] });
  const signal = new AbortController().signal;
  assert.deepEqual(Array.from(await api.fetchLeadTags('local-test', signal)), ['VIP', 'vip', 'East, Toronto']);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/tags');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-test');
  assert.equal(calls[0].options.signal, signal);
});

test('Malformed tag catalogs and authorization failures are errors, not empty successes', async () => {
  for (const body of [null, {}, { tags: 'VIP' }, { tags: ['VIP', null] }]) {
    await assert.rejects(setup(body).api.fetchLeadTags('local-test'), /unavailable/);
  }
  await assert.rejects(setup({ message: 'Not authorized' }, false).api.fetchLeadTags('local-test'), /Not authorized/);
  assert.deepEqual(Array.from(await setup({ tags: [] }).api.fetchLeadTags('local-test')), []);
});
