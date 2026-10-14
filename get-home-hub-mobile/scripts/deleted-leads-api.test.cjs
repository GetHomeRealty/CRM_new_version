const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(body, status = 200, failure) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/deleted-leads-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); if (failure === 'network') throw Error('Connection reset'); return { ok: status === 200, status, json: async () => { if (failure === 'json') throw Error('Unexpected EOF'); return body; } }; },
  });
  return { api, calls };
}
test('Deleted leads search is authenticated, encoded, paged and read-only', async () => {
  const body = { data: [{ id: 1, name: 'Test', email: null, deleted_at: null }], meta: { page: 2, per_page: 50, total: 51, last_page: 2 } };
  const { api, calls } = load(body); const signal = new AbortController().signal;
  assert.equal(await api.fetchDeletedLeads('synthetic', 2, ' A&B ', signal), body);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/leads/deleted'); assert.equal(url.searchParams.get('search'), 'A&B'); assert.equal(url.searchParams.get('page'), '2');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.signal, signal); assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  await assert.rejects(api.fetchDeletedLeads('', 1, ''), /sign in/);
  await assert.rejects(api.fetchDeletedLeads('synthetic', -1, ''), /Invalid/);
  assert.equal(calls.length, 1);
});
test('Lost restore response never claims failure or retries and pre-cancelled requests never send', async () => {
  for (const failure of ['network', 'json']) {
    const { api, calls } = load({}, 200, failure);
    await assert.rejects(api.restoreDeletedLead('synthetic', 12), /could not be confirmed.*Check the active lead list/);
    assert.equal(calls.length, 1);
  }
  const controller = new AbortController(); controller.abort();
  const { api, calls } = load({ restored: true });
  await assert.rejects(api.restoreDeletedLead('synthetic', 12, controller.signal), /before sending/);
  assert.equal(calls.length, 0);
  await assert.rejects(load({}, 401).api.restoreDeletedLead('synthetic', 12), /sign in/);
});
test('Deleted leads reject malformed data and denied responses', async () => {
  for (const body of [null, {}, { data: [{}], meta: { page: 1, per_page: 50, total: 1, last_page: 1 } }]) {
    await assert.rejects(load(body).api.fetchDeletedLeads('synthetic', 1, ''), /invalid/);
  }
  await assert.rejects(load({}, 403).api.fetchDeletedLeads('synthetic', 1, ''), /access/);
  const empty = { data: [], meta: { page: 1, per_page: 50, total: 0, last_page: 1 } };
  assert.equal((await load(empty).api.fetchDeletedLeads('synthetic', 1, '')).data.length, 0);
});
test('Restore targets exactly one lead and requires explicit server confirmation', async () => {
  const { api, calls } = load({ restored: true });
  const signal = new AbortController().signal;
  await api.restoreDeletedLead('synthetic', 12, signal);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/deleted/12/restore');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.signal, signal);
  await assert.rejects(api.restoreDeletedLead('synthetic', 0), /Invalid/);
  await assert.rejects(api.restoreDeletedLead('', 12), /sign in/);
  assert.equal(calls.length, 1);
  await assert.rejects(load({}).api.restoreDeletedLead('synthetic', 12), /not be confirmed/);
  await assert.rejects(load({}, 403).api.restoreDeletedLead('synthetic', 12), /permission/);
  await assert.rejects(load({}, 404).api.restoreDeletedLead('synthetic', 12), /no longer available/);
});
