const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/auth/access-refresh.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, AbortController, setTimeout, clearTimeout });
test('Refresh serializes overlapping calls and applies revoked access', async () => {
  let finish; let calls = 0; const applied = [];
  const lifecycle = api.createAccessRefresh(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, value => applied.push(value), () => assert.fail());
  const first = lifecycle.refresh(); await lifecycle.refresh();
  assert.equal(calls, 1); finish(null); await first;
  assert.deepEqual(applied, [null]);
});
test('Stopped session ignores late responses and aborts outstanding request', async () => {
  let finish; let signal;
  const lifecycle = api.createAccessRefresh(s => { signal = s; return new Promise(resolve => { finish = resolve; }); }, () => assert.fail('stale apply'), () => assert.fail('stale error'));
  const pending = lifecycle.refresh(); lifecycle.stop();
  assert.equal(signal.aborted, true); finish({ id: 1 }); await pending; await lifecycle.refresh();
});
test('Network failure preserves session and allows next refresh', async () => {
  let failures = 0; let attempts = 0; const applied = [];
  const lifecycle = api.createAccessRefresh(async () => { if (++attempts === 1) throw Error('offline'); return { id: 1 }; }, value => applied.push(value), () => failures++);
  await lifecycle.refresh(); await lifecycle.refresh();
  assert.equal(failures, 1); assert.equal(applied.length, 1);
});
test('Timeout releases a hung refresh and ignores its late result', async () => {
  let finish; let signal; let attempts = 0; let failures = 0; const applied = [];
  const lifecycle = api.createAccessRefresh(s => {
    if (++attempts > 1) return Promise.resolve('current');
    signal = s;
    return new Promise(resolve => { finish = resolve; });
  }, value => applied.push(value), () => failures++, 10);
  await lifecycle.refresh();
  assert.equal(signal.aborted, true);
  assert.equal(failures, 1);
  await lifecycle.refresh();
  finish('stale');
  await Promise.resolve();
  assert.deepEqual(applied, ['current']);
  lifecycle.stop();
});
test('Stop settles a hung refresh without reporting a session error', async () => {
  const lifecycle = api.createAccessRefresh(() => new Promise(() => {}), () => assert.fail(), () => assert.fail());
  const pending = lifecycle.refresh();
  lifecycle.stop();
  await pending;
});
