/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const base = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'app.config.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function configure(env, config = base) {
  const exports = {};
  vm.runInNewContext(source, { exports, process: { env }, URL });
  return exports.default({ config });
}
const id = '12345678-1234-4234-8234-123456789abc'; // Synthetic config fixture, never linked or built.
const preview = { GHH_PROVIDER_PREVIEW: 'true', EXPO_PUBLIC_EAS_PROJECT_ID: id, EXPO_PUBLIC_API_URL: 'https://api.example.invalid', EXPO_PUBLIC_AUTH_URL: 'https://auth.example.invalid' };
test('unconfigured local build preserves existing app config and plugins', () => {
  assert.equal(JSON.stringify(configure({})), JSON.stringify(base));
});
test('public EAS binding preserves other config and never copies server secrets', () => {
  const result = configure({ EXPO_PUBLIC_EAS_PROJECT_ID: id, EXPO_PUSH_ACCESS_TOKEN: 'secret fixture', GOOGLE_MAIL_CLIENT_SECRET: 'secret fixture' }, { ...base, extra: { retained: true } });
  assert.equal(result.extra.eas.projectId, id);
  assert.equal(result.extra.retained, true);
  assert(!JSON.stringify(result).includes('secret fixture'));
});
test('missing or conflicting project ID blocks push configuration', () => {
  assert.throws(() => configure({ EXPO_PUBLIC_NATIVE_PUSH_ENABLED: 'true' }), /requires/);
  assert.throws(() => configure({ EXPO_PUBLIC_EAS_PROJECT_ID: 'placeholder' }), /UUID/);
  assert.throws(() => configure({ EXPO_PUBLIC_EAS_PROJECT_ID: id }, { ...base, extra: { eas: { projectId: 'different' } } }), /differs/);
});
test('provider preview blocks missing origins, production fallback, HTTP and embedded credentials', () => {
  for (const url of ['', 'https://transaction.gethomehub.ca', 'http://127.0.0.1:8000', 'https://user:password@api.example.invalid', 'https://api.example.invalid?secret=fixture', 'https://api.example.invalid/api']) {
    assert.throws(() => configure({ ...preview, EXPO_PUBLIC_API_URL: url }), /explicit HTTPS test origin/);
  }
  assert.throws(() => configure({ ...preview, EXPO_PUBLIC_EAS_PROJECT_ID: '' }), /actual EXPO_PUBLIC_EAS_PROJECT_ID/);
  assert.equal(configure(preview).extra.eas.projectId, id);
});
test('provider-preview build profile keeps sending and external management disabled', () => {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8')).build['provider-preview'];
  assert.equal(profile.environment, 'preview');
  assert.equal(profile.distribution, 'internal');
  for (const flag of ['NATIVE_PUSH', 'META_MANAGEMENT', 'INBOX_REPLY_SENDING', 'CAMPAIGN_SENDING', 'LOCAL_CAMPAIGN_SEND_TESTING', 'LEAD_IMPORT']) assert.equal(profile.env['EXPO_PUBLIC_' + flag + '_ENABLED'] || profile.env['EXPO_PUBLIC_' + flag], 'false');
});
