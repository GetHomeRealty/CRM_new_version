const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function harness(status = 200, failure) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/campaigns/template-edit-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); if (failure) throw failure; return { ok: status >= 200 && status < 300, status }; },
  });
  return { api, calls };
}
test('Template metadata saves only changed fields without content or attachment replacement', async () => {
  const { api, calls } = harness(); const signal = new AbortController().signal;
  await api.updateTemplateMetadata('synthetic', 1, { name: ' New name ', is_active: false }, signal);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates/1');
  assert.equal(calls[0].options.method, 'PUT'); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'New name', is_active: false });
});
test('Invalid metadata cannot trigger requests or modify email content', async () => {
  const { api, calls } = harness();
  for (const patch of [{}, { name: '' }, { subject: 'x'.repeat(501) }, { name: 'x'.repeat(256) }, { is_active: 'false' }, { content: '<p>overwrite</p>' }, { attachments: [] }]) await assert.rejects(api.updateTemplateMetadata('synthetic', 1, patch));
  await assert.rejects(api.updateTemplateMetadata('', 1, { name: 'Name' }));
  await assert.rejects(api.updateTemplateMetadata('synthetic', -1, { name: 'Name' }));
  assert.equal(calls.length, 0);
});
test('Denied, missing and ambiguous saves are not reported as success', async () => {
  for (const [status, pattern] of [[401, /sign in/], [403, /permission/], [404, /no longer/], [400, /rejected/], [500, /not be confirmed/]]) await assert.rejects(harness(status).api.updateTemplateMetadata('synthetic', 1, { subject: 'Test' }), pattern);
  await assert.rejects(harness(200, Error('private transport detail')).api.updateTemplateMetadata('synthetic', 1, { subject: 'Test' }), /Refresh/);
});
test('Create uses only the template endpoint and forces inactive custom defaults', async () => {
  const { api, calls } = harness(201); const signal = new AbortController().signal;
  await api.createTemplate('synthetic', { name: ' Draft ', subject: ' Subject ', content: '<p>Hello {{LEAD_NAME}}</p>', is_active: true, user_id: 99 }, signal);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Draft', subject: 'Subject', content: '<p>Hello {{LEAD_NAME}}</p>', category: 'custom', is_active: false });
});
test('Body updates preserve exact source and never submit metadata or attachments', async () => {
  const { api, calls } = harness(); const content = ' <table><tr><td>{{LEAD_NAME}} &amp; team</td></tr></table> ';
  await api.updateTemplateBody('synthetic', 4, content);
  assert.equal(calls[0].options.method, 'PUT'); assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates/4');
  assert.deepEqual(JSON.parse(calls[0].options.body), { content });
});
test('Invalid or cancelled template creation/body edits never reach transport', async () => {
  const { api, calls } = harness();
  for (const content of ['', '   ', 'x'.repeat(200001)]) {
    await assert.rejects(api.updateTemplateBody('synthetic', 1, content));
    await assert.rejects(api.createTemplate('synthetic', { name: 'Draft', subject: 'Subject', content }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.createTemplate('synthetic', { name: 'Draft', subject: 'Subject', content: 'Body' }, controller.signal));
  await assert.rejects(api.updateTemplateBody('synthetic', 0, 'Body'));
  assert.equal(calls.length, 0);
});
test('Unconfirmed creation is surfaced without automatic retry', async () => {
  const { api, calls } = harness(200, Error('private detail'));
  await assert.rejects(api.createTemplate('synthetic', { name: 'Draft', subject: 'Subject', content: 'Body' }), /avoid duplicates/);
  assert.equal(calls.length, 1);
});
test('Category and activation are partial metadata updates; invalid categories and cancelled saves do not reach transport', async () => {
  const { api, calls } = harness();
  await api.updateTemplateMetadata('synthetic', 1, { category: 'follow-up', is_active: true });
  assert.deepEqual(JSON.parse(calls[0].options.body), { category: 'follow-up', is_active: true });
  for (const category of ['', 'unknown', null, 1]) await assert.rejects(api.updateTemplateMetadata('synthetic', 1, { category }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.updateTemplateMetadata('synthetic', 1, { is_active: false }, controller.signal));
  assert.equal(calls.length, 1);
});
test('Attachment removal targets only the selected template file and fails safely', async () => {
  const { api, calls } = harness(204);
  await api.removeTemplateAttachment('synthetic', 4, 8);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates/4/attachments/8');
  assert.equal(calls[0].options.method, 'DELETE'); assert.equal(calls[0].options.body, undefined);
  await assert.rejects(api.removeTemplateAttachment('synthetic', 0, 8));
  await assert.rejects(api.removeTemplateAttachment('synthetic', 4, -1));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.removeTemplateAttachment('synthetic', 4, 8, controller.signal));
  assert.equal(calls.length, 1);
  for (const status of [401, 403, 404, 500]) await assert.rejects(harness(status).api.removeTemplateAttachment('synthetic', 4, 8));
});
test('Attachment uploads use the bounded base64 contract and never retry ambiguous requests', async () => {
  const { api, calls } = harness(201);
  const input = { filename: 'synthetic.txt', content_type: 'text/plain', data: 'dGVzdA==' };
  await api.uploadTemplateAttachment('synthetic', 1, input);
  assert.equal(calls[0].url, 'http://localhost:8000/api/campaigns/templates/1/attachments');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), input);
  for (const data of ['', '!', 'a===', 'A'.repeat(6990512)]) await assert.rejects(api.uploadTemplateAttachment('synthetic', 1, { ...input, data }));
  await assert.rejects(api.uploadTemplateAttachment('synthetic', 0, input));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(api.uploadTemplateAttachment('synthetic', 1, input, abort.signal));
  assert.equal(calls.length, 1);
  const uncertain = harness(500);
  await assert.rejects(uncertain.api.uploadTemplateAttachment('synthetic', 1, input), /not be confirmed/);
  assert.equal(uncertain.calls.length, 1);
});
