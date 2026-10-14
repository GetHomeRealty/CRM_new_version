const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const key = '12345678-1234-4123-8123-123456789abc';
function load(file, imports, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/inbox', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: imports, atob, btoa, ...globals });
  return exports;
}
function harness() {
  let body = { data: [], page: 1, has_more: false }, status = 200;
  const calls = [];
  const api = load('mail-archive-api.ts', () => ({ environment: { apiUrl: 'http://localhost:8000' } }), {
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls, setBody: value => { body = value; }, setStatus: value => { status = value; } };
}
test('sent archive carries identity, area, pagination and abort signal', async () => {
  const h = harness(), signal = new AbortController().signal;
  await h.api.sentPage('synthetic', 'crm', 1, signal);
  assert.match(h.calls[0].url, /sent\?page=1&area=crm$/);
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(h.calls[0].options.signal, signal);
  await assert.rejects(h.api.sentPage('', 'crm', 1));
  await assert.rejects(h.api.sentPage('synthetic', 'crm', 0));
  assert.equal(h.calls.length, 1);
});
test('sent archive rejects malformed response, mismatched identity and unavailable server', async () => {
  const h = harness();
  h.setBody({ data: [null], page: 1, has_more: false });
  await assert.rejects(h.api.sentPage('synthetic', 'crm', 1), /Invalid/);
  h.setBody({ id: key, to_email: null, subject: null, sent_at: '2026-10-04T00:00:00Z', content_available: false,
    body_text: null, attachments: { available: false, total: 0, files: [] } });
  assert.equal((await h.api.sentDetail('synthetic', 'crm', key)).content_available, false);
  await assert.rejects(h.api.sentDetail('synthetic', 'crm', '00000000-0000-0000-0000-000000000000'), /Invalid/);
  h.setStatus(503);
  await assert.rejects(h.api.sentPage('synthetic', 'crm', 1), /unavailable/);
});
test('attachment routes reject traversal, invalid kinds and out-of-range indexes', () => {
  const { api } = harness();
  assert.equal(api.attachmentPath('inbound', 12, 0), 'inbound/12/attachments/0');
  for (const args of [['sent', '../secret', 0], ['other', 1, 0], ['inbound', 0, 0], ['inbound', 1, 20]]) assert.throws(() => api.attachmentPath(...args));
  assert.equal(api.validAttachments({ available: true, total: 1, files: [null] }), false);
});
function downloadHarness(payload, shareError = false) {
  const events = [];
  class Directory {
    exists = false;
    create() { this.exists = true; events.push('create'); }
    delete() { this.exists = false; events.push('delete'); }
  }
  class File {
    uri = 'file:///private/cache/test';
    write(bytes) { events.push(['write', bytes.length]); }
  }
  const api = load('archive-download.ts', name => {
    if (name === 'expo-file-system') return { Directory, File, Paths: { cache: 'private' } };
    if (name === 'expo-crypto') return { randomUUID: () => key };
    if (name === 'expo-sharing') return { isAvailableAsync: async () => true, shareAsync: async () => { events.push('share'); if (shareError) throw new Error('cancel'); } };
    if (name === './mail-archive-api') return { attachmentPath: () => 'inbound/1/attachments/0', archiveRequest: async () => payload };
    throw new Error(name);
  });
  return { events, run: signal => api.shareArchivedAttachment('synthetic', 'crm', 'inbound', 1, 0, signal || new AbortController().signal) };
}
test('attachment sharing cleans private temporary bytes on both success and failure', async () => {
  const payload = { filename: 'attachment-1.bin', size: 4, data: 'dGVzdA==' };
  const h = downloadHarness(payload); await h.run();
  assert.deepEqual(h.events, ['create', ['write', 4], 'share', 'delete']);
  const failing = downloadHarness(payload, true); await assert.rejects(failing.run());
  assert.equal(failing.events.at(-1), 'delete');
});
test('malformed and cancelled downloads never create or share files', async () => {
  for (const payload of [{ filename: '../unsafe.html', size: 4, data: 'dGVzdA==' }, { filename: 'attachment-1.bin', size: 5, data: 'dGVzdA==' }]) {
    const h = downloadHarness(payload); await assert.rejects(h.run()); assert.equal(h.events.length, 0);
  }
  const h = downloadHarness({ filename: 'attachment-1.bin', size: 4, data: 'dGVzdA==' });
  const controller = new AbortController(); controller.abort(); await h.run(controller.signal);
  assert.equal(h.events.length, 0);
});
