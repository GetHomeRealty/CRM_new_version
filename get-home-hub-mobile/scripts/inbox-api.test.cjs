const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(status = 200) {
  const api = {}, calls = [];
  const body = { data: [], meta: { page: 2, per_page: 30, total: 0, last_page: 1 }, unread: 0, mailbox: null };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/inbox/inbox-api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports: api, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => {
      assert.equal(new URL(url).hostname, 'localhost');
      calls.push({ url: new URL(url), options });
      return { ok: status === 200, status, json: async () => body };
    },
  });
  return { api, calls, body };
}

test('Inbox list preserves area, filters, pagination, authentication and cancellation', async () => {
  const { api, calls, body } = harness();
  const signal = new AbortController().signal;
  assert.equal(await api.fetchInbox('synthetic-token', 'crm', { page: 2, unread: true, leadId: 7, signal }), body);
  const { url, options } = calls[0];
  assert.equal(url.pathname, '/api/account/inbox');
  assert.equal(url.searchParams.get('area'), 'crm');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('unread'), '1');
  assert.equal(url.searchParams.get('lead'), '7');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(options.signal, signal);
  assert.equal(options.method, 'GET');
  await api.fetchInbox('synthetic-token', 'desk');
  assert.equal(calls[1].url.searchParams.has('lead'), false);
  assert.equal(calls[1].url.searchParams.has('unread'), false);
});

test('Explicit message open and read/unread updates retain the selected area', async () => {
  const { api, calls } = harness();
  await api.openInboxMessage('synthetic-token', 'desk', 9);
  assert.equal(calls[0].url.pathname, '/api/account/inbox/9');
  for (const seen of [false, true]) await api.setInboxMessageSeen('synthetic-token', 'desk', 9, seen);
  calls.forEach(({ url }) => assert.equal(url.searchParams.get('area'), 'desk'));
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { seen: false });
  assert.deepEqual(JSON.parse(calls[2].options.body), { seen: true });
});

test('Invalid filters fail closed without broadening the mailbox request', () => {
  const { api, calls } = harness();
  for (const value of [0, -1, 1.2, NaN, Infinity]) {
    assert.throws(() => api.fetchInbox('test', 'crm', { leadId: value }));
    assert.throws(() => api.fetchInbox('test', 'crm', { page: value }));
    assert.throws(() => api.openInboxMessage('test', 'crm', value));
  }
  assert.equal(calls.length, 0);
});

test('Inbox failures surface safe actionable errors rather than a successful empty inbox', async () => {
  for (const [status, message] of [[401, /sign in again/], [403, /access/], [404, /no longer available/], [500, /retry/]]) {
    await assert.rejects(harness(status).api.fetchInbox('test', 'crm'), message);
  }
});

test('Reply context is read-only, cancellable and fails closed for incompatible servers', async () => {
  const { api, calls, body } = harness();
  await assert.rejects(api.fetchInboxReplyContext('test', 'crm', 7), /unavailable/);
  Object.assign(body, { message_id: 7, from: 'agent@example.invalid', to: 'lead@example.invalid',
    subject: 'Re: Test', recipient_source: 'sender', sending_enabled: false });
  const signal = new AbortController().signal;
  await api.fetchInboxReplyContext('test', 'crm', 7, signal);
  assert.equal(calls[1].url.pathname, '/api/account/inbox/7/reply-context');
  assert.equal(calls[1].options.signal, signal);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
  body.sending_enabled = 'true';
  await assert.rejects(api.fetchInboxReplyContext('test', 'crm', 7), /unavailable/);
});
