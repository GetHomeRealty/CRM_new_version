const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const key = '12345678-1234-4123-8123-123456789abc';
function harness(options = {}) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/inbox/reply-send-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      if (options.network) throw new Error('private network details');
      return { ok: (options.status ?? 200) === 200, json: async () => {
        if (options.badJson) throw new Error('invalid JSON');
        return options.body ?? { request_key: key, message_id: 23, status: 'accepted' };
      } };
    },
  });
  return { api, calls, send: (body = 'Hello', files = []) => api.submitInboxReply('synthetic', 'crm', 23, key, body, files) };
}
test('Reply submission preserves identity and sends only allowed draft fields', async () => {
  const h = harness(); await h.send('Hello', [{ filename: 'test.txt', content_type: 'text/plain', data: 'dGVzdA==', size: 4 }]);
  const { url, init } = h.calls[0]; assert.equal(url.pathname, '/api/account/inbox-replies/23');
  assert.equal(url.searchParams.get('area'), 'crm'); assert.equal(init.headers.Authorization, 'Bearer synthetic');
  assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { request_key: key, body_text: 'Hello', attachments: [{ filename: 'test.txt', content_type: 'text/plain', data: 'dGVzdA==' }] });
});
test('Uncertain responses never trigger retry or leak server errors', async () => {
  for (const options of [{ network: true }, { status: 500 }, { status: 404 }, { status: 409 }, { badJson: true }, { body: { request_key: key, message_id: 24, status: 'accepted' } }]) {
    const h = harness(options); await assert.rejects(h.send(), /Recover its status/); assert.equal(h.calls.length, 1);
  }
});
test('Recovery uses only GET and verifies exact receipt identity', async () => {
  const h = harness({ body: { request_key: key, message_id: 23, status: 'uncertain' } });
  assert.equal((await h.api.recoverInboxReply('test', 'desk', 23, key)).status, 'uncertain');
  assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.calls[0].init.body, undefined);
  assert.equal(h.calls[0].url.searchParams.get('area'), 'desk');
  await assert.rejects(harness({ status: 404 }).api.recoverInboxReply('test', 'crm', 23, key), /do not send again/);
});
test('Invalid draft and aborted request fail before any network call', async () => {
  const h = harness(); await assert.rejects(h.send(' ')); await assert.rejects(h.send('x'.repeat(20001)));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.submitInboxReply('test', 'crm', 23, key, 'Hello', [], controller.signal));
  assert.equal(h.calls.length, 0);
});

test('Compose includes one explicit recipient and subject, with zero sentinel receipt identity', async () => {
  const h = harness({ body: { request_key: key, message_id: 0, status: 'accepted' } });
  await h.api.submitInboxReply('test', 'crm', 0, key, 'Hello', [], undefined, { to: 'test@example.invalid', subject: 'New mail' });
  assert.equal(h.calls[0].url.pathname, '/api/account/inbox-replies/0');
  assert.equal(JSON.parse(h.calls[0].init.body).subject, 'New mail');
  assert.equal(JSON.parse(h.calls[0].init.body).to, 'test@example.invalid');
});
