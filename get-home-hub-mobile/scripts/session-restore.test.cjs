const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function setup(status, networkFailure = false) {
  const api = {}, deleted = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/auth/auth-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api,
    require: (name) => name === 'expo-secure-store' ? { getItemAsync: async () => 'local-token', deleteItemAsync: async (key) => deleted.push(key) } : name === 'react-native' ? { Platform: { OS: 'ios' } } : { environment: { apiUrl: 'http://localhost:8000' } },
    fetch: async () => { if (networkFailure) throw new Error('offline'); return { status, ok: status === 200, json: async () => ({ id: 1, name: 'Local Test' }) }; },
  });
  return { api, deleted, recover: () => { status = 200; networkFailure = false; } };
}
test('Expired or forbidden sessions are removed', async () => {
  for (const status of [401, 403]) {
    const { api, deleted } = setup(status);
    assert.equal(await api.restoreSession(), null);
    assert.equal(deleted.length, 1);
  }
});
test('Temporary failures retain saved credentials without authenticating the user', async () => {
  for (const [status, offline] of [[500, false], [503, false], [429, false], [0, true]]) {
    const { api, deleted } = setup(status, offline);
    await assert.rejects(api.restoreSession());
    assert.equal(deleted.length, 0);
  }
});
test('Verified sessions restore their token and user', async () => {
  const { api, deleted } = setup(200);
  const session = await api.restoreSession();
  assert.equal(session.token, 'local-token');
  assert.equal(session.user.id, 1);
  assert.equal(deleted.length, 0);
});
test('Retry after an outage restores the same saved credential without a new login', async () => {
  const { api, deleted, recover } = setup(503);
  await assert.rejects(api.restoreSession());
  recover();
  const session = await api.restoreSession();
  assert.equal(session.token, 'local-token');
  assert.equal(session.user.id, 1);
  assert.equal(deleted.length, 0);
});
