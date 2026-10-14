const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function load(authUrl = 'https://crm.example.invalid', status = 200) {
  const api = {}, calls = [];
  const body = { enabled: true, methods: [{ type: 'totp', confirmed: true, destination: 'private' }], recovery_codes_remaining: 8, trusted_devices: [{ ip: 'private' }], obligation: { state: 'none' }, secret: 'never-retain' };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/account/security-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URL, Error, require: () => ({ environment: { authUrl, apiUrl: 'https://crm.example.invalid' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls, body };
}
test('Security summary keeps only verified non-secret status', () => {
  const { api, body } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(api.securitySummary(body))), { enabled: true, methods: ['totp'], recoveryCodesRemaining: 8, trustedDeviceCount: 1, obligation: 'none' });
  for (const invalid of [null, {}, { ...body, enabled: false }, { ...body, recovery_codes_remaining: -1 }, { ...body, methods: [{ type: 'fake', confirmed: true }] }, { ...body, obligation: { state: 'unknown' } }]) assert.throws(() => api.securitySummary(invalid));
});
test('Security links contain no credentials and stay on exact approved internal paths', () => {
  const { api } = load();
  assert.equal(api.securityPageUrl('crm', 'password'), 'https://crm.example.invalid/crm/account');
  assert.equal(api.securityPageUrl('desk', 'two-step'), 'https://crm.example.invalid/desk/two-step');
  assert.throws(() => api.securityPageUrl('../external', 'password'));
  assert.throws(() => api.securityPageUrl('crm', '//evil.invalid'));
  for (const origin of ['http://crm.example.invalid', 'https://user:secret@crm.example.invalid', 'https://crm.example.invalid/?token=secret', 'https://crm.example.invalid/#secret', 'javascript:alert(1)', 'https://crm.example.invalid/other']) assert.throws(() => load(origin).api.securityPageUrl('crm', 'password'));
  assert.equal(load('http://localhost:5173').api.securityPageUrl('crm', 'two-step'), 'http://localhost:5173/crm/two-step');
});
test('Security status uses only authenticated GET and refuses unauthenticated reads', async () => {
  const { api, calls } = load(); await api.fetchSecurityStatus('synthetic');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://crm.example.invalid/api/mfa');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic');
  assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
  await assert.rejects(api.fetchSecurityStatus('')); await assert.rejects(api.fetchSecurityStatus('synthetic', { aborted: true })); assert.equal(calls.length, 1);
  await assert.rejects(load(undefined, 401).api.fetchSecurityStatus('synthetic'), /expired/);
});
