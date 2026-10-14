const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function harness({ lost = false, storageFails = false, initial = null } = {}) {
  const store = new Map(); let submissions = 0; const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/leads/lead-import-guard.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: name => {
      if (name === 'expo-secure-store') return { getItemAsync: async key => store.has(key) ? store.get(key) : initial, setItemAsync: async (key, value) => { if (storageFails) throw Error('Storage failed'); store.set(key, value); }, deleteItemAsync: async key => { store.delete(key); } };
      if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_algorithm, value) => value.replace(/[^a-z0-9]/gi, '') };
      if (name.includes('environment')) return { environment: { apiUrl: 'http://localhost:8000' } };
      if (name.includes('lead-import-api')) return { validateImport() {}, submitLeadImport: async () => { submissions++; if (lost) throw Error('Lost response'); return { job_id: 'confirmed-job' }; } };
      throw Error(name);
    },
  });
  return { api, store, submissions: () => submissions };
}
test('Import guard persists before sending, blocks retries and acknowledges confirmed jobs only', async () => {
  const h = harness();
  const job = await h.api.guardedImport(1, 'synthetic', 'a\nb', '');
  assert.equal(job.job_id, 'confirmed-job');
  assert.equal((await h.api.readImportAttempt(1)).state, 'confirmed');
  await assert.rejects(h.api.guardedImport(1, 'synthetic', 'a\nb', ''), /previous import/);
  await assert.rejects(h.api.acknowledgeImport(1, 'wrong'), /not been confirmed/);
  assert.equal(h.submissions(), 1);
  await h.api.acknowledgeImport(1, 'confirmed-job');
  assert.equal(await h.api.readImportAttempt(1), null);
});
test('Uncertain and corrupt import attempts never authorize another upload', async () => {
  const h = harness({ lost: true });
  await assert.rejects(h.api.guardedImport(1, 'synthetic', 'a\nb', ''), /Lost response/);
  assert.equal((await h.api.readImportAttempt(1)).state, 'pending');
  await assert.rejects(h.api.guardedImport(1, 'synthetic', 'a\nb', ''), /previous import/);
  await assert.rejects(h.api.acknowledgeImport(1, 'confirmed-job'), /not been confirmed/);
  assert.equal(h.submissions(), 1);
  assert.equal(await h.api.readImportAttempt(2), null);
  const corrupt = harness({ initial: 'broken' });
  await assert.rejects(corrupt.api.guardedImport(1, 'synthetic', 'a\nb', ''), /unreadable/);
  assert.equal(corrupt.submissions(), 0);
});
test('Storage failure and simultaneous import operations cannot submit twice', async () => {
  const h = harness({ storageFails: true });
  await assert.rejects(h.api.guardedImport(1, 'synthetic', 'a\nb', ''), /Storage failed/);
  assert.equal(h.submissions(), 0);
  const h2 = harness();
  const first = h2.api.guardedImport(1, 'synthetic', 'a\nb', '');
  await assert.rejects(h2.api.guardedImport(1, 'synthetic', 'a\nb', ''), /already in progress/);
  await first; assert.equal(h2.submissions(), 1);
});
