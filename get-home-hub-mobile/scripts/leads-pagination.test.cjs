const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('Lead pagination preserves search, authentication, cancellation and server metadata', async () => {
  const api = {};
  const calls = [];
  const response = { data: [{ id: 51 }], meta: { current_page: 2, last_page: 3, total: 101 } };
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/leads/leads-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, json: async () => response }; },
  });
  const signal = new AbortController().signal;
  assert.equal(await api.fetchLeads('local-test', ' Alice ', signal, 2), response);
  assert.equal(calls[0].url.searchParams.get('page'), '2');
  assert.equal(calls[0].url.searchParams.get('search'), 'Alice');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-test');
  await api.fetchLeads('local-test', '');
  assert.equal(calls[1].url.searchParams.get('page'), '1');
  assert.equal(calls[1].url.searchParams.has('search'), false);
  await api.fetchLeads('local-test', 'Alice', signal, 1, 'offer submitted');
  assert.equal(calls[2].url.searchParams.get('leadStatus'), 'offer submitted');
  assert.equal(calls[2].url.searchParams.get('search'), 'Alice');
  assert.equal(calls[1].url.searchParams.has('leadStatus'), false);
});
