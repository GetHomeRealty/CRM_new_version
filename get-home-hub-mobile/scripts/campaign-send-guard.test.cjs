const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
function harness(records = new Map(), mode = '') {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/campaigns/campaign-send-guard.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, require: name => {
    if (name === 'expo-secure-store') return { getItemAsync: async key => records.get(key) ?? null, setItemAsync: async (key, value) => { if (mode === 'storage-failure' || (mode === 'confirmation-write-failure' && JSON.parse(value).state === 'confirmed')) throw Error('storage unavailable'); records.set(key, value); }, deleteItemAsync: async key => records.delete(key) };
    if (name === 'expo-crypto') return { randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_algorithm, value) => require('node:crypto').createHash('sha256').update(value).digest('hex') };
    if (name.includes('environment')) return { environment: { apiUrl: 'http://localhost:8000' } };
    if (name.includes('campaigns-api')) return { fetchCampaign: async (_token, id) => { calls.push('verify'); if (mode === 'denied') throw Error('Denied'); return { id, status: 'sending' }; } };
    return { campaignPayload: () => ({}), recoverCampaignSubmission: async () => { calls.push('recover'); if (mode === 'denied') throw Error('unconfirmed'); return { id: 9, status: 'sending' }; }, submitCampaign: async (_token, _draft, _signal, key) => { assert.match(key, /^[0-9a-f-]{36}$/); calls.push('send'); if (mode === 'network') throw Error('unknown'); return { id: 9, status: 'sending' }; } };
  } });
  return { api, calls, records };
}
const draft = { templateId: 1 };
test('Durable campaign guard blocks parallel and restart duplicates, requires acknowledgement', async () => {
  const h = harness();
  const first = h.api.guardedSubmitCampaign(1, 'synthetic', draft);
  await assert.rejects(h.api.guardedSubmitCampaign(1, 'synthetic', draft), /progress/);
  await first; assert.equal(h.calls.length, 1);
  const restarted = harness(h.records);
  assert.equal((await restarted.api.verifyConfirmedCampaign(1, 'synthetic')).id, 9);
  await assert.rejects(restarted.api.guardedSubmitCampaign(1, 'synthetic', draft), /previous/);
  await assert.rejects(restarted.api.acknowledgeConfirmedCampaign(1, 8));
  await restarted.api.acknowledgeConfirmedCampaign(1, 9);
  assert.equal(await restarted.api.readCampaignAttempt(1), null);
});
test('Uncertain sends persist across restart and cannot be cleared as confirmed', async () => {
  const h = harness(new Map(), 'network');
  await assert.rejects(h.api.guardedSubmitCampaign(1, 'synthetic', draft));
  const next = harness(h.records);
  assert.equal((await next.api.readCampaignAttempt(1)).state, 'pending');
  await assert.rejects(next.api.verifyConfirmedCampaign(1, 'synthetic'), /unresolved/);
  await assert.rejects(next.api.acknowledgeConfirmedCampaign(1, 9));
  await assert.rejects(next.api.guardedSubmitCampaign(1, 'synthetic', draft));
  assert.equal(next.calls.length, 0);
  assert.equal(await next.api.readCampaignAttempt(2), null);
});
test('Storage failures and malformed durable records fail closed without sending', async () => {
  const h = harness(new Map(), 'storage-failure');
  await assert.rejects(h.api.guardedSubmitCampaign(1, 'synthetic', draft)); assert.equal(h.calls.length, 0);
  const seeded = harness(); await seeded.api.guardedSubmitCampaign(1, 'synthetic', draft);
  for (const key of seeded.records.keys()) seeded.records.set(key, '{invalid');
  const next = harness(seeded.records); await assert.rejects(next.api.guardedSubmitCampaign(1, 'synthetic', draft), /unreadable/); assert.equal(next.calls.length, 0);
});
test('Recovery after a lost response resolves the original durable request without a send', async () => {
  const h = harness(new Map(), 'network');
  await assert.rejects(h.api.guardedSubmitCampaign(1, 'synthetic', draft));
  const denied = harness(h.records, 'denied');
  await assert.rejects(denied.api.recoverPendingCampaign(1, 'synthetic'));
  assert.equal((await denied.api.readCampaignAttempt(1)).state, 'pending');
  const next = harness(h.records);
  assert.equal((await next.api.recoverPendingCampaign(1, 'synthetic')).id, 9);
  assert.equal((await next.api.readCampaignAttempt(1)).state, 'confirmed');
  assert.deepEqual(next.calls, ['recover']);
  await next.api.acknowledgeConfirmedCampaign(1, 9);
});
test('Failure to persist a successful confirmation retains the request for safe recovery', async () => {
  const h = harness(new Map(), 'confirmation-write-failure');
  await assert.rejects(h.api.guardedSubmitCampaign(1, 'synthetic', draft), /storage unavailable/);
  assert.deepEqual(h.calls, ['send']);
  const original = await h.api.readCampaignAttempt(1);
  assert.equal(original.state, 'pending');
  assert.ok(original.requestKey);
  const restarted = harness(h.records);
  await assert.rejects(restarted.api.guardedSubmitCampaign(1, 'synthetic', draft), /previous/);
  await restarted.api.recoverPendingCampaign(1, 'synthetic');
  const confirmed = await restarted.api.readCampaignAttempt(1);
  assert.equal(confirmed.requestKey, original.requestKey);
  assert.equal(confirmed.campaignId, 9);
  assert.deepEqual(restarted.calls, ['recover']);
});
