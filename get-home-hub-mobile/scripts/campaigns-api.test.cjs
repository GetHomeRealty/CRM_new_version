const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const campaign = { id: 7, name: 'Synthetic campaign', status: 'sent', stats: { total: 1, sent: 1, failed: 0, opened: 0, bounced: 0, unsubscribed: 0 } };
function harness(body, status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/campaigns/campaigns-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls };
}
test('Suppression pages use authenticated cancellable GET with bounded pagination', async () => {
  const body = { data: [{ id: 1, email: 'qa@example.invalid', reason: 'unsubscribe', updated_at: null }], meta: { page: 2, per_page: 50, total: 51, last_page: 2 } };
  const { api, calls } = harness(body); const signal = new AbortController().signal;
  assert.equal(await api.fetchSuppressions('synthetic', 2, signal), body);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/suppressions?page=2&limit=50');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  for (const page of [0, -1, 1.5, NaN]) await assert.rejects(api.fetchSuppressions('synthetic', page), /Invalid/);
  await assert.rejects(api.fetchSuppressions('', 1), /sign in/);
  assert.equal(calls.length, 1);
});
test('Suppression pages reject malformed responses and denied access', async () => {
  for (const body of [null, {}, { data: [], meta: { page: 1, per_page: 50, total: -1, last_page: 1 } }, { data: [{}], meta: { page: 1, per_page: 50, total: 1, last_page: 1 } }]) {
    await assert.rejects(harness(body).api.fetchSuppressions('synthetic', 1), /invalid/);
  }
  await assert.rejects(harness({}, 403).api.fetchSuppressions('synthetic', 1), /access/);
});
test('Campaign list is authenticated, cancellable, bounded and read-only', async () => {
  const { api, calls } = harness([campaign]); const signal = new AbortController().signal;
  assert.equal((await api.fetchCampaigns('synthetic', signal))[0], campaign);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns?limit=100');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic'); assert.equal(calls[0].options.body, undefined);
});
test('Campaign results use only the selected read endpoint', async () => {
  const { api, calls } = harness({ ...campaign, subject: 'Synthetic', recipients: [{ id: 1, name: null, email: 'test@example.invalid', status: 'sent', opened: false, bounced: false, unsubscribed: false }] });
  assert.equal((await api.fetchCampaign('synthetic', 7)).recipients.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/7'); assert.equal(calls[0].options.method, 'GET');
});
test('Malformed campaign statistics and recipient results fail visibly', async () => {
  for (const body of [{}, [null], [{ ...campaign, stats: {} }], [{ ...campaign, stats: { ...campaign.stats, total: -1 } }]]) {
    await assert.rejects(harness(body).api.fetchCampaigns('synthetic'), /invalid/);
  }
  await assert.rejects(harness({ ...campaign, subject: 'Test', recipients: [{}] }).api.fetchCampaign('synthetic', 7), /invalid/);
  await assert.rejects(harness({ ...campaign, subject: 'Test', recipients: [] }).api.fetchCampaign('synthetic', 8), /invalid/);
});
test('Missing authentication and invalid identifiers never send a request', async () => {
  const { api, calls } = harness([]);
  await assert.rejects(api.fetchCampaigns(''), /sign in/);
  for (const id of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(api.fetchCampaign('synthetic', id), /Invalid/);
  assert.equal(calls.length, 0);
});
test('Campaign access failures do not become empty success results', async () => {
  for (const [status, pattern] of [[401, /sign in/], [403, /access/], [404, /no longer/], [500, /retry/]]) {
    await assert.rejects(harness([], status).api.fetchCampaigns('synthetic'), pattern);
  }
});
test('Delivery metadata accepts optional server values and rejects malformed retry details', async () => {
  const recipient = { id: 1, name: null, email: 'test@example.invalid', status: 'failed', opened: false, bounced: true, unsubscribed: false };
  const body = (extra) => ({ ...campaign, subject: 'Synthetic', recipients: [{ ...recipient, ...extra }] });
  for (const extra of [{}, { bounce_type: null, next_retry_at: null }, { bounce_type: 'soft', retry_count: 2, next_retry_at: '2026-09-28T12:00:00Z' }]) {
    assert.equal((await harness(body(extra)).api.fetchCampaign('synthetic', 7)).recipients.length, 1);
  }
  for (const extra of [{ bounce_type: 5 }, { retry_count: -1 }, { retry_count: 0.5 }, { retry_count: '2' }, { next_retry_at: 'invalid-date' }, { next_retry_at: 123 }]) {
    await assert.rejects(harness(body(extra)).api.fetchCampaign('synthetic', 7), /invalid/);
  }
});
