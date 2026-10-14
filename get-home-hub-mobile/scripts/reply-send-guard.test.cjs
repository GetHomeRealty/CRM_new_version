const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
function harness(options = {}) {
  const records = options.records ?? new Map(); const calls = [];
  let writes = 0;
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/inbox/reply-send-guard.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: name => {
      if (name === 'expo-secure-store') return {
        getItemAsync: async key => records.get(key) ?? null,
        setItemAsync: async (key, value) => { writes++; if (options.failWrite === writes) throw new Error('Storage unavailable'); records.set(key, value); },
        deleteItemAsync: async key => records.delete(key),
      };
      if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, randomUUID: crypto.randomUUID,
        digestStringAsync: async (_, value) => crypto.createHash('sha256').update(value).digest('hex') };
      if (name.includes('environment')) return { environment: { apiUrl: options.url ?? 'http://localhost:8000' } };
      if (name.includes('reply-send-api')) return {
        submitInboxReply: async (_, area, id, key) => { calls.push(['send', area, id, key]); if (options.failSend) throw new Error('unknown'); return { request_key: key, message_id: id, status: 'accepted' }; },
        recoverInboxReply: async (_, area, id, key) => { calls.push(['recover', area, id, key]); if (options.failRecovery) throw new Error('not found'); return { request_key: key, message_id: id, status: options.recoveryStatus ?? 'accepted' }; },
      };
      throw new Error(name);
    },
  });
  return { api, calls, records, submit: () => api.guardedSubmitReply(7, 'synthetic', 'crm', 23, 'Hello', []) };
}
test('Duplicate taps produce one submission and accepted receipt requires acknowledgement', async () => {
  const h = harness(); const results = await Promise.allSettled([h.submit(), h.submit()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.calls.length, 1);
  const attempt = await h.api.readReplyAttempt(7); assert.equal(attempt.status, 'accepted');
  await assert.rejects(h.submit(), /previous reply/);
  await h.api.acknowledgeAcceptedReply(7, attempt.key); assert.equal(await h.api.readReplyAttempt(7), null);
});
test('Network uncertainty survives restart; recovery never submits again', async () => {
  const h = harness({ failSend: true }); await assert.rejects(h.submit());
  const restarted = harness({ records: h.records }); await assert.rejects(restarted.submit(), /previous reply/);
  const result = await restarted.api.recoverReplyAttempt(7, 'synthetic'); assert.equal(result.status, 'accepted');
  assert.deepEqual(restarted.calls.map(c => c[0]), ['recover']);
});
test('Failure to persist pending blocks all network; confirmation write failure retains pending', async () => {
  const h = harness({ failWrite: 1 }); await assert.rejects(h.submit()); assert.equal(h.calls.length, 0);
  const accepted = harness({ failWrite: 2 }); await assert.rejects(accepted.submit());
  assert.equal((await accepted.api.readReplyAttempt(7)).status, 'pending'); assert.equal(accepted.calls.length, 1);
});
test('Pending/uncertain cannot be acknowledged; failed recovery does not clear safety record', async () => {
  const h = harness({ failSend: true }); await assert.rejects(h.submit());
  const attempt = await h.api.readReplyAttempt(7);
  await assert.rejects(h.api.acknowledgeAcceptedReply(7, attempt.key));
  const restarted = harness({ records: h.records, failRecovery: true });
  await assert.rejects(restarted.api.recoverReplyAttempt(7, 'synthetic'));
  assert.equal((await restarted.api.readReplyAttempt(7)).key, attempt.key);
  const uncertain = harness({ records: h.records, recoveryStatus: 'uncertain' });
  await uncertain.api.recoverReplyAttempt(7, 'synthetic');
  await assert.rejects(uncertain.api.acknowledgeAcceptedReply(7, attempt.key));
});
test('Records are account/environment scoped and corruption fails closed', async () => {
  const h = harness(); await h.submit(); assert.equal(await h.api.readReplyAttempt(8), null);
  assert.equal(await harness({ records: h.records, url: 'http://localhost:9000' }).api.readReplyAttempt(7), null);
  h.records.set([...h.records.keys()][0], 'broken'); await assert.rejects(h.submit(), /unreadable/);
  assert.equal(h.calls.length, 1);
});

test('Compose validation occurs before saving a safety record and binds zero message identity', async () => {
  const h = harness();
  await assert.rejects(h.api.guardedSubmitReply(7, 'test', 'crm', 0, 'Hello', [], undefined, { to: 'bad', subject: 'Test' }));
  assert.equal(h.records.size, 0); assert.equal(h.calls.length, 0);
  await h.api.guardedSubmitReply(7, 'test', 'crm', 0, 'Hello', [], undefined, { to: 'test@example.invalid', subject: 'Test' });
  assert.equal((await h.api.readReplyAttempt(7)).messageId, 0);
});
