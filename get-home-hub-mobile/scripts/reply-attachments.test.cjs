const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(overrides = {}) {
  const calls = { pick: 0, read: 0, deleted: 0 };
  const asset = { uri: 'file:///cache/DocumentPicker/test.txt', name: 'test.txt', mimeType: 'text/plain', ...overrides.asset };
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/inbox/reply-attachments.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: api, require: name => {
    if (name === 'expo-document-picker') return { getDocumentAsync: async options => {
      calls.pick++; assert.equal(options.copyToCacheDirectory, true); assert.equal(options.multiple, false);
      return overrides.canceled ? { canceled: true } : { canceled: false, assets: [asset] };
    } };
    if (name === 'expo-file-system') return { Paths: { cache: { uri: 'file:///cache/' } }, File: class {
      constructor(uri) { this.uri = uri; this.size = overrides.size ?? 4; this.exists = true; }
      async base64() { calls.read++; if (overrides.fail) throw new Error('read failed'); overrides.abort?.(); return overrides.data ?? 'dGVzdA=='; }
      delete() { calls.deleted++; }
    } };
    throw new Error(name);
  } });
  return { calls, pick: (existing = [], signal = new AbortController().signal) => api.pickReplyAttachment(existing, signal) };
}

test('Reply attachment reads only cache copy, retains bytes in memory and removes temporary copy', async () => {
  const h = harness(); const result = await h.pick();
  assert.equal(result.filename, 'test.txt'); assert.equal(result.data, 'dGVzdA=='); assert.equal(result.size, 4);
  assert.deepEqual(h.calls, { pick: 1, read: 1, deleted: 1 });
});
test('Cancel and file-count limit do not read files', async () => {
  const h = harness({ canceled: true }); assert.equal(await h.pick(), null);
  await assert.rejects(h.pick(Array(5).fill({ size: 1 })), /five/);
  assert.deepEqual(h.calls, { pick: 1, read: 0, deleted: 0 });
});
test('Unknown, empty and oversized files are rejected and cache copies cleaned', async () => {
  for (const size of [0, NaN, -1, 5 * 1024 * 1024 + 1]) {
    const h = harness({ size }); await assert.rejects(h.pick(), /nonempty/);
    assert.equal(h.calls.read, 0); assert.equal(h.calls.deleted, 1);
  }
  await assert.rejects(harness().pick([{ size: 5 * 1024 * 1024 }]), /5 MB/);
});
test('Original documents and traversal paths are never read or deleted', async () => {
  for (const uri of ['file:///documents/test.txt', 'file:///cache/../secret', 'file:///cache/%2e%2e/secret']) {
    const h = harness({ asset: { uri } }); await assert.rejects(h.pick(), /private cache/);
    assert.equal(h.calls.read, 0); assert.equal(h.calls.deleted, 0);
  }
});
test('Read failures, changed content and abort discard results and clean cache copies', async () => {
  for (const options of [{ fail: true }, { data: 'AAAA' }, { asset: { name: '../bad' } }]) {
    const h = harness(options); await assert.rejects(h.pick()); assert.equal(h.calls.deleted, 1);
  }
  const controller = new AbortController(); const h = harness({ abort: () => controller.abort() });
  assert.equal(await h.pick([], controller.signal), null); assert.equal(h.calls.deleted, 1);
});
