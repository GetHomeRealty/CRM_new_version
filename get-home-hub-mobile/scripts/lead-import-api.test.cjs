const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const job = { job_id: 'synthetic-job', status: 'processing', total_rows: 10, processed_rows: 5, percent: 50, imported: 4, tagged: 0, duplicate: 1, invalid: 0, failure_reason: null, message: 'Processing', done: false };
function load(body, status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-import-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls };
}
test('Import history uses only authenticated caller-scoped GET, never submission', async () => {
  const { api, calls } = load([job]); const signal = new AbortController().signal;
  assert.equal((await api.fetchRecentLeadImports('synthetic', signal))[0], job);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/imports/recent');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic'); assert.equal(calls[0].options.body, undefined);
  await assert.rejects(api.fetchRecentLeadImports(''), /sign in/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.fetchRecentLeadImports('synthetic', cancelled.signal), /cancelled/);
  assert.equal(calls.length, 1);
});
test('Import history rejects malformed progress and preserves server failures', async () => {
  for (const body of [null, {}, [{}], [{ ...job, percent: 101 }], [{ ...job, imported: -1 }], [{ ...job, processed_rows: 11 }], [{ ...job, done: 'yes' }]]) {
    await assert.rejects(load(body).api.fetchRecentLeadImports('synthetic'), /invalid/);
  }
  for (const status of [401, 403, 500]) await assert.rejects(load([], status).api.fetchRecentLeadImports('synthetic'));
  assert.equal((await load([]).api.fetchRecentLeadImports('synthetic')).length, 0);
});
test('CSV submission is one authenticated POST and rejects unsafe drafts before transport', async () => {
  const { api, calls } = load(job);
  assert.equal(await api.submitLeadImport('synthetic', 'name,email\nTest,test@example.invalid', ' QA '), job);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/import');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).tag, 'QA');
  for (const [csv, tag] of [['', ''], ['header', ''], ['a\nb\0', ''], ['a\nb', 'x\ny'], ['a\n' + 'x'.repeat(250000), '']]) {
    await assert.rejects(api.submitLeadImport('synthetic', csv, tag));
  }
  assert.equal(calls.length, 1);
  await assert.rejects(load({}).api.submitLeadImport('synthetic', 'a\nb', ''), /not be confirmed/);
  await assert.rejects(load({}, 403).api.submitLeadImport('synthetic', 'a\nb', ''), /permission/);
});
