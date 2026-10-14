const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function harness(body = { ok: true }, status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/notifications/notifications-api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: api, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { assert.equal(new URL(url).hostname, 'localhost'); calls.push({ url: new URL(url), options });
      return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls };
}
test('Notification queries preserve filters, pagination, search, authentication and cancellation', async () => {
  const { api, calls } = harness();
  const signal = new AbortController().signal;
  await api.fetchNotifications('synthetic', { filter: 'unread', source: 'direct', search: ' lead ', offset: 30, signal });
  const { url, options } = calls[0];
  assert.equal(url.searchParams.get('search'), 'lead');
  assert.equal(url.searchParams.get('offset'), '30');
  assert.equal(url.searchParams.get('source'), 'direct');
  assert.equal(url.searchParams.get('filter'), 'unread');
  assert.equal(options.signal, signal);
  assert.equal(options.headers.Authorization, 'Bearer synthetic');
});
test('Direct alerts use notification ID while other sources use transaction ID', async () => {
  const { api, calls } = harness();
  await api.markNotificationRead('test', { source: 'direct', transaction_id: 0, notification_id: 21 });
  await api.markNotificationRead('test', { source: 'reminder', transaction_id: 9 });
  assert.equal(JSON.parse(calls[0].options.body).transaction_id, 21);
  assert.equal(JSON.parse(calls[1].options.body).transaction_id, 9);
  assert.equal(calls[0].options.method, 'POST');
  await assert.rejects(api.markNotificationRead('test', { source: 'direct', transaction_id: 9 }), /Invalid/);
  assert.equal(calls.length, 2);
});
test('Logical failures are not swallowed and bulk partial failures remain visible', async () => {
  await assert.rejects(harness({ ok: false }).api.markNotificationRead('test', { source: 'reminder', transaction_id: 9 }), /could not/);
  await assert.rejects(harness({}, 401).api.fetchNotifications('test'), /sign in again/);
  const result = await harness({ marked: 3, failed: 2 }).api.markAllNotificationsRead('test');
  assert.equal(result.failed, 2);
  await assert.rejects(harness({}).api.markAllNotificationsRead('test'), /verify/);
});
test('Invalid filters and offsets cannot silently broaden notification scope', () => {
  const { api, calls } = harness();
  for (const options of [{ offset: -1 }, { offset: 1.5 }, { filter: 'typo' }, { source: 'typo' }]) {
    assert.throws(() => api.fetchNotifications('test', options), /Invalid/);
  }
  assert.equal(calls.length, 0);
});
