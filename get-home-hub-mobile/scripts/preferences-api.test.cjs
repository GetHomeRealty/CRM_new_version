const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {}, calls = [];
const current = { channels: ['in_app', 'email', 'push'], categories: [{ key: 'lead_new',
  channels: { in_app: 'live', email: 'live', push: 'pending' }, enabled: { in_app: true, email: true, push: true } }] };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/notifications/preferences-api.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
  fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => current }; },
});
test('Preference updates send only changed live channels without changing other choices', async () => {
  const changes = api.preferenceChanges(current, { lead_new: { in_app: true, email: false } });
  assert.equal(JSON.stringify(changes), '{"lead_new":{"email":false}}');
  assert.equal(current.categories[0].enabled.email, true);
  assert.equal(await api.saveNotificationPreferences('synthetic', current, { lead_new: { email: false } }), current);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(calls[0].options.body, '{"lead_new":{"email":false}}');
});
test('Unavailable categories and non-live channels are rejected before sending', () => {
  for (const draft of [{ missing: { email: false } }, { lead_new: { push: false } }, { lead_new: { sms: true } }, { lead_new: { email: 'false' } }]) {
    assert.throws(() => api.preferenceChanges(current, draft));
  }
});
test('Preference loading forwards cancellation and returns server choices', async () => {
  const signal = new AbortController().signal;
  assert.equal(await api.fetchNotificationPreferences('synthetic', signal), current);
  assert.equal(calls.at(-1).options.signal, signal);
  assert.equal(calls.at(-1).options.method, 'GET');
});
