const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(status = 200, failure = false) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/account/account-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); if (failure) throw Error('network'); return { ok: status === 200, status, json: async () => ({ ok: true }) }; },
  });
  return { api, calls };
}
test('Account profile only writes editable personal fields', () => {
  const { api } = load();
  const result = api.profileInput({ name: ' Agent ', username: ' agent ', phone: ' 123 ', role: 'Admin', email: 'other@example.invalid', status: 'Active' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { name: 'Agent', username: 'agent', phone: '123' });
  assert.throws(() => api.profileInput({ name: '', username: '', phone: '' }));
  assert.throws(() => api.profileInput({ name: 'A', username: '', phone: '1'.repeat(65) }));
});
test('Personal email preference limits match the server', () => {
  const { api } = load(), prefs = { signature: '', replyTemplate: '', autoSync: false, autoResponder: { enabled: false, message: '' }, forwardingAddress: '' };
  assert.equal(api.preferencesInput(prefs).autoSync, false);
  assert.throws(() => api.preferencesInput({ ...prefs, signature: 'x'.repeat(5001) }));
  assert.throws(() => api.preferencesInput({ ...prefs, forwardingAddress: 'invalid' }));
});
test('Mailbox edits preserve blank passwords and never change ownership or scope', () => {
  const { api } = load();
  const mailbox = { id: 1, name: 'Test', from_email: 'a@example.invalid', host: 'smtp.example.invalid', port: 587, username: 'a', encryption: 'tls', imap_host: 'imap.example.invalid', imap_port: 993, imap_encryption: 'ssl', inbound_enabled: true, is_active: true, is_default: true, user_id: 999, scope: 'desk' };
  const result = api.mailboxInput(mailbox, '');
  for (const key of ['password', 'user_id', 'scope', 'id', 'is_default']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(api.mailboxInput(mailbox, 'synthetic-only').password, 'synthetic-only');
  assert.throws(() => api.mailboxInput({ ...mailbox, port: 0 }, ''));
  assert.throws(() => api.mailboxInput({ ...mailbox, imap_host: '' }, ''));
  assert.throws(() => api.mailboxInput({ ...mailbox, encryption: '' }, ''));
});
test('Account requests are authenticated personal endpoints and never automatically retried', async () => {
  const { api, calls } = load();
  await api.accountRequest('synthetic', 'profile', 'PUT', { name: 'Test' });
  assert.equal(calls[0].url, 'http://localhost:8000/api/account/profile');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(calls.length, 1);
  await assert.rejects(api.accountRequest('', 'profile'));
  await assert.rejects(api.accountRequest('synthetic', 'profile', 'GET', undefined, { aborted: true }));
  assert.equal(calls.length, 1);
  for (const status of [401, 403, 500]) await assert.rejects(load(status).api.accountRequest('synthetic', 'settings'));
  const failed = load(200, true);
  await assert.rejects(failed.api.accountRequest('synthetic', 'settings', 'PUT', {}), /not confirmed/);
  assert.equal(failed.calls.length, 1);
});
