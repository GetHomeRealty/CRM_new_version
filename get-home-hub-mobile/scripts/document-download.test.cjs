const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness(large = false, mode = '') {
  const api = {}, calls = [];
  class Directory { exists = true; create() { calls.push('create'); } delete() { calls.push('delete'); this.exists = false; } }
  class File { constructor(directory, name) { if (mode === 'file-constructor') throw Error('native file unavailable'); this.uri = `file:///private-cache/${name}`; } size = 42; }
  class DownloadTask {
    constructor(url, file, options) { if (mode === 'task-constructor') throw Error('native task unavailable'); assert.equal(new URL(url).hostname, 'localhost'); this.file = file; this.options = options; calls.push({ url, options }); }
    async downloadAsync() {
      if (mode === 'pending') return new Promise((resolve, reject) => this.options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
      this.options.onProgress({ bytesWritten: mode === 'stream-large' ? 30 * 1024 * 1024 : 42, totalBytes: large ? 30 * 1024 * 1024 : -1 });
      if (large || mode === 'stream-large') throw Error('cancelled');
      if (mode === 'final-large') this.file.size = 30 * 1024 * 1024;
      return this.file;
    }
    cancel() { calls.push('cancel'); } release() { calls.push('release'); }
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/document-download.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: api, require: (name) => name === 'expo-file-system' ? { Directory, File, DownloadTask, Paths: { cache: 'private-cache' } }
    : name === 'expo-crypto' ? { randomUUID: () => 'synthetic' } : { environment: { apiUrl: 'http://localhost:8000' } } });
  return { api, calls };
}
test('Downloads authenticate in headers and sanitize local paths with explicit cleanup', async () => {
  const { api, calls } = harness();
  const result = await api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: '../../Offer.pdf' });
  assert.equal(result.uri, 'file:///private-cache/attachment.pdf');
  const request = calls.find((call) => call.url);
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic');
  assert.equal(request.url.includes('synthetic'), false);
  assert.ok(calls.includes('release')); result.dispose(); assert.ok(calls.includes('delete'));
});
test('Oversized downloads are cancelled and partial files removed', async () => {
  const { api, calls } = harness(true);
  await assert.rejects(api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.pdf' }), /25 MB/);
  assert.ok(calls.includes('cancel')); assert.ok(calls.includes('delete')); assert.ok(calls.includes('release'));
});
test('Untrusted URLs fail before creating files or starting transport', async () => {
  const { api, calls } = harness();
  await assert.rejects(api.downloadDocument('synthetic', { path: 'https://example.test/file', label: 'file' }), /Invalid/);
  assert.equal(calls.length, 0);
});
test('Template attachments use a constrained authenticated route and private cleanup', async () => {
  const { api, calls } = harness();
  await assert.rejects(api.downloadTemplateAttachment('synthetic', '../1', 2, 'file.pdf'));
  await assert.rejects(api.downloadTemplateAttachment('synthetic', 1, 0, 'file.pdf'));
  assert.equal(calls.length, 0);
  const file = await api.downloadTemplateAttachment('synthetic', 1, 2, '../../file.pdf');
  const request = calls.find(call => call.url);
  assert.equal(request.url, 'http://localhost:8000/api/campaigns/templates/1/attachments/2');
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic');
  assert.equal(file.uri, 'file:///private-cache/attachment.pdf');
  file.dispose(); assert.ok(calls.includes('delete'));
  await assert.rejects(harness(true).api.downloadTemplateAttachment('synthetic', 1, 2, 'file.pdf'), /25 MB/);
});
test('Cancelling an active download removes partial files and releases native resources', async () => {
  const { api, calls } = harness(false, 'pending');
  const controller = new AbortController();
  const pending = api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.txt' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.ok(calls.includes('delete')); assert.ok(calls.includes('release'));
});
test('Already cancelled downloads never allocate files or native tasks', async () => {
  const { api, calls } = harness();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.txt' }, controller.signal), /cancelled/);
  assert.equal(calls.length, 0);
});
test('Unknown-length streams enforce the byte limit', async () => {
  const { api, calls } = harness(false, 'stream-large');
  await assert.rejects(api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.txt' }), /25 MB/);
  assert.ok(calls.includes('cancel')); assert.ok(calls.includes('delete'));
});
test('Final size checks preserve the specific oversized-file error', async () => {
  const { api, calls } = harness(false, 'final-large');
  await assert.rejects(api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.txt' }), /25 MB/);
  assert.ok(calls.includes('delete')); assert.ok(calls.includes('release'));
});
for (const mode of ['file-constructor', 'task-constructor']) {
  test(`${mode} failure cleans its allocated temporary directory`, async () => {
    const { api, calls } = harness(false, mode);
    await assert.rejects(api.downloadDocument('synthetic', { path: '/api/documents/9/file', label: 'file.txt' }), /Could not download/);
    assert.ok(calls.includes('create')); assert.ok(calls.includes('delete'));
    assert.equal(calls.includes('release'), false);
  });
}
