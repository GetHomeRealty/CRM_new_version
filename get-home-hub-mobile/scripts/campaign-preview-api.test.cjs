const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const vm = require('node:vm'); const ts = require('typescript');
function harness(body, status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/campaigns/campaign-preview-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }), fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  }); return { api, calls };
}
test('Audience preview calls only the non-sending preview endpoint with exact trimmed tag', async () => {
  const { api, calls } = harness({ count: 0, sample: [] }); const signal = new AbortController().signal;
  assert.equal((await api.previewCampaignAudience('synthetic', ' VIP ', signal)).count, 0);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/preview');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.deepEqual(JSON.parse(calls[0].options.body), { tag: 'VIP' });
  await api.previewCampaignAudience('synthetic', ''); assert.deepEqual(JSON.parse(calls[1].options.body), { tag: '' });
});
test('Template browsing uses authorized GET without modifying templates', async () => {
  const template = { id: 1, name: 'Synthetic', subject: '<img src="invalid">', category: 'general', is_active: false, attachment_count: 0 };
  const { api, calls } = harness([template]); assert.equal((await api.fetchCampaignTemplates('synthetic'))[0], template);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
});
test('Template attachment metadata validates sizes, IDs, count and legacy missing details', async () => {
  const template = { id: 1, name: 'Synthetic', subject: 'Test', category: 'custom', is_active: true, attachment_count: 1 };
  const attachment = { id: 2, filename: '<img>.pdf', content_type: 'application/pdf', size: 0 };
  const { api, calls } = harness([{ ...template, attachments: [attachment] }]);
  assert.equal((await api.fetchCampaignTemplates('synthetic'))[0].attachments[0].filename, '<img>.pdf');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET');
  assert.equal((await harness([template]).api.fetchCampaignTemplates('synthetic'))[0].attachments, undefined);
  for (const attachments of [null, [], [{}], [{ ...attachment, size: -1 }], [{ ...attachment, size: 1.5 }], [{ ...attachment, filename: 3 }], [{ ...attachment, id: 0 }]]) {
    await assert.rejects(harness([{ ...template, attachments }]).api.fetchCampaignTemplates('synthetic'), /invalid/);
  }
  await assert.rejects(harness([{ ...template, attachment_count: 2, attachments: [attachment, attachment] }]).api.fetchCampaignTemplates('synthetic'), /invalid/);
});
test('Invalid preview inputs and malformed server responses fail closed', async () => {
  const { api, calls } = harness({ count: 0, sample: [] });
  await assert.rejects(api.previewCampaignAudience('synthetic', 'x'.repeat(256)), /255/);
  await assert.rejects(api.previewCampaignAudience('', ''), /sign in/); assert.equal(calls.length, 0);
  for (const body of [null, { count: -1, sample: [] }, { count: 1, sample: [{}] }]) await assert.rejects(harness(body).api.previewCampaignAudience('synthetic', ''), /invalid/);
  await assert.rejects(harness([{}]).api.fetchCampaignTemplates('synthetic'), /invalid/);
});
test('Denied and unavailable previews remain errors rather than zero recipients', async () => {
  for (const status of [401, 403, 500]) await assert.rejects(harness({}, status).api.previewCampaignAudience('synthetic', 'VIP'));
});
test('All audience filters retain exact server values; Any is omitted', async () => {
  const { api, calls } = harness({ count: 0, sample: [] });
  await api.previewCampaignAudience('synthetic', 'VIP', undefined, { leadStatus: 'hot', leadType: 'Buyer', leadSource: 'Website', clientType: 'Move-up Buyer' });
  assert.deepEqual(JSON.parse(calls[0].options.body), { tag: 'VIP', leadStatus: 'hot', leadType: 'Buyer', leadSource: 'Website', clientType: 'Move-up Buyer' });
  await api.previewCampaignAudience('synthetic', '', undefined, { leadStatus: '' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { tag: '' });
  await assert.rejects(api.previewCampaignAudience('synthetic', '', undefined, { unsupported: 'x' }), /Invalid/);
  await assert.rejects(api.previewCampaignAudience('synthetic', '', undefined, { leadType: 4 }), /Invalid/);
  assert.equal(calls.length, 2);
});
test('Audience options use server vocabulary and reject malformed option lists', async () => {
  const { api, calls } = harness({ lead_status: ['hot'], lead_type: ['buyer'], lead_source: ['website'], client_type: ['Move-up Buyer'] });
  const result = await api.fetchAudienceOptions('synthetic');
  assert.equal(result.clientType[0], 'Move-up Buyer'); assert.equal(result.leadSource[0], 'website');
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/options'); assert.equal(calls[0].options.method, 'GET');
  await assert.rejects(harness({}).api.fetchAudienceOptions('synthetic'), /unavailable/);
});
