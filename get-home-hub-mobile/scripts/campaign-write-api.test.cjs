const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
function harness(status = 201, body = { id: 8, status: 'scheduled' }, fail = false) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/campaigns/campaign-write-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: name => name.includes('environment') ? { environment: { apiUrl: 'http://localhost:8000' } } : { audienceFields: ['leadStatus', 'leadType', 'leadSource', 'clientType'] },
    fetch: async (url, options) => { calls.push({ url, options }); if (fail) throw Error('transport'); return { ok: status < 300, status, json: async () => body }; },
  });
  return { api, calls };
}
const draft = () => ({ name: ' Local test ', templateId: 1, tag: ' synthetic ', filters: { leadStatus: 'hot' }, scheduledFor: new Date(Date.now() + 3600000).toISOString() });
const key = '00000000-0000-4000-8000-000000000001';
test('Campaign submission sends only scoped fields and preserves explicit schedule', async () => {
  const { api, calls } = harness(); const input = draft();
  await api.submitCampaign('synthetic', { ...input, user_id: 99, recipients: ['external@example.invalid'] }, undefined, key);
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent, { name: 'Local test', template_id: 1, tag: 'synthetic', leadStatus: 'hot', scheduled_for: input.scheduledFor, request_key: key });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/submissions');
});
test('Expired, missing-timezone and invalid campaign inputs never submit', async () => {
  const { api, calls } = harness();
  for (const patch of [{ name: '' }, { templateId: 0 }, { scheduledFor: '' }, { scheduledFor: '2026-01-01T12:00:00' }, { scheduledFor: new Date(0).toISOString() }, { filters: { injected: 'x' } }]) await assert.rejects(api.submitCampaign('synthetic', { ...draft(), ...patch }, undefined, key));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.submitCampaign('synthetic', draft(), controller.signal, key));
  await assert.rejects(api.submitCampaign('synthetic', draft())); assert.equal(calls.length, 0);
});
test('Unknown send outcomes are distinguished and never retried', async () => {
  for (const h of [harness(500), harness(201, null), harness(201, {}, true)]) {
    await assert.rejects(h.api.submitCampaign('synthetic', draft(), undefined, key), error => error instanceof h.api.UnconfirmedCampaignError);
    assert.equal(h.calls.length, 1);
  }
});
test('Scheduled cancellation targets only the campaign and verifies acknowledgement', async () => {
  const h = harness(200, { cancelled: true }); await h.api.cancelScheduledCampaign('synthetic', 8);
  assert.equal(h.calls[0].url, 'http://localhost:8000/api/campaigns/8/cancel');
  assert.deepEqual(JSON.parse(h.calls[0].options.body), {});
  await assert.rejects(h.api.cancelScheduledCampaign('synthetic', 0));
  await assert.rejects(harness(200, { cancelled: false }).api.cancelScheduledCampaign('synthetic', 8));
  for (const status of [400, 401, 403, 404]) await assert.rejects(harness(status).api.cancelScheduledCampaign('synthetic', 8));
});
