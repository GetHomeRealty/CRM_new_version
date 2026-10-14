const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('Transaction pages retain the server search and authorization contract', async () => {
  const api = {}, calls = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/transactions-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, json: async () => ({ data: [], meta: { current_page: 3, last_page: 3 } }) }; },
  });
  const signal = new AbortController().signal;
  const result = await api.fetchTransactions('local-test', ' Trade 100 ', signal, 3);
  assert.equal(calls[0].url.searchParams.get('page'), '3');
  assert.equal(calls[0].url.searchParams.get('q'), 'Trade 100');
  assert.equal(calls[0].url.searchParams.get('per_page'), '50');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-test');
  assert.equal(result.meta.last_page, 3);
  await api.fetchTransactions('local-test', '');
  assert.equal(calls[1].url.searchParams.get('page'), '1');
  assert.equal(calls[1].url.searchParams.has('q'), false);
});
test('Transaction date updates preserve partial fields and explicit clearing', async () => {
  const api = {}, calls = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/transactions-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ data: { id: 9, closing_date: null } }) }; },
  });
  const result = await api.updateTransaction('local-test', 9, { closing_date: null });
  assert.equal(result.id, 9);
  assert.equal(calls[0].url, 'http://localhost:8000/api/transactions/9');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer local-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), { closing_date: null });
  await api.updateTransaction('local-test', 9, { offer_date: '2026-09-12' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { offer_date: '2026-09-12' });
});
