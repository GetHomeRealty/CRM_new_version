const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness(status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/messages-api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { assert.equal(new URL(url).hostname, 'localhost'); calls.push({ url, options });
      return { ok: status === 200, status, json: async () => [] }; },
  });
  return { api, calls };
}
test('Conversation and mention reads retain transaction scope, authentication and cancellation', async () => {
  const { api, calls } = harness();
  const signal = new AbortController().signal;
  await api.fetchTransactionMessages('synthetic', 9, signal);
  await api.fetchMentionCandidates('synthetic', 9, ' Alice ', signal);
  assert.equal(calls[0].url, 'http://localhost:8000/api/transactions/9/messages');
  assert.equal(new URL(calls[1].url).searchParams.get('q'), 'Alice');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(calls[0].options.signal, signal);
});
test('Message sends trim content and deduplicate explicit mentions', async () => {
  const { api, calls } = harness();
  await api.sendTransactionMessage('synthetic', 9, ' Local test ', [2, 2, 3]);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: 'Local test', mentions: [2, 3] });
});
test('Invalid messages, transaction IDs and mentions never issue requests', () => {
  const { api, calls } = harness();
  for (const text of ['', '   ', 'x'.repeat(5001)]) assert.throws(() => api.sendTransactionMessage('test', 9, text));
  for (const ids of [[0], [-1], [1.5], Array.from({ length: 21 }, (_, i) => i + 1)]) assert.throws(() => api.sendTransactionMessage('test', 9, 'test', ids));
  assert.throws(() => api.fetchTransactionMessages('test', 0));
  assert.equal(calls.length, 0);
});
test('Access failures remain failures rather than empty conversations', async () => {
  await assert.rejects(harness(403).api.fetchTransactionMessages('test', 9), /access/);
});
