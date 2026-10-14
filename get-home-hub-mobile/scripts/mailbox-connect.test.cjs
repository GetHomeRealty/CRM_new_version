const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), crypto = require('node:crypto');
function load({ accounts = [], limit = { max: 1, used: 0, canAdd: true }, failure, status = 200, configured = true } = {}) {
  const store = new Map(), calls = [], api = {}, account = {};
  const environment = { apiUrl: 'https://crm.example.invalid' };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST' && failure) throw Error('network');
    return { ok: status === 200, status, json: async () => url.includes('/limit') ? limit : url.includes('google/mail') ? { configured, url: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=synthetic&redirect_uri=https%3A%2F%2Fcrm.example.invalid%2Fapi%2Fgoogle%2Fcallback' } : options.method === 'POST' ? { id: 2, from_email: JSON.parse(options.body).from_email } : accounts };
  };
  function compile(file, exports, require) { vm.runInNewContext(ts.transpileModule(fs.readFileSync(requirePath(file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require, fetch, URL, Error }); }
  const requirePath = file => require('node:path').join(__dirname, '../src/account/', file);
  compile('account-api.ts', account, () => ({ environment }));
  compile('mailbox-connect.ts', api, name => {
    if (name === './account-api') return account;
    if (name.includes('environment')) return { environment };
    if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_, value) => crypto.createHash('sha256').update(value).digest('hex') };
    if (name === 'expo-secure-store') return { getItemAsync: async key => store.get(key) ?? null, setItemAsync: async (key, value) => store.set(key, value), deleteItemAsync: async key => store.delete(key) };
    throw Error(name);
  });
  const draft = { ...api.emptyMailbox, name: 'Test', from_email: 'test@example.invalid', host: 'smtp.example.invalid', username: 'test' };
  return { api, store, calls, draft, accounts };
}
test('Manual mailbox creation respects shared scope and does not send a test email', async () => {
  const { api, calls, draft, store } = load();
  await api.connectMailbox(1, 'synthetic-token', draft, 'synthetic-password');
  const post = calls.filter(c => c.options.method === 'POST'); assert.equal(post.length, 1);
  const body = JSON.parse(post[0].options.body);
  assert.equal(body.scope, 'crm'); assert.equal(body.password, 'synthetic-password');
  assert.equal(body.is_default, undefined); assert.equal(body.user_id, undefined);
  assert.equal(store.size, 0); assert.equal(calls.some(c => c.url.endsWith('/test')), false);
});
test('Limit, duplicate, malformed limit and missing credentials fail before creation', async () => {
  for (const opts of [{ limit: { max: 1, used: 1, canAdd: false } }, { accounts: [{ id: 1, from_email: 'TEST@example.invalid' }] }, { limit: { max: 1, used: 1, canAdd: true } }]) {
    const { api, calls, draft } = load(opts); await assert.rejects(api.connectMailbox(1, 'token', draft, 'synthetic')); assert.equal(calls.some(c => c.options.method === 'POST'), false);
  }
  const { api, draft, calls } = load(); await assert.rejects(api.connectMailbox(1, 'token', draft, '')); assert.equal(calls.length, 0);
});
test('Lost response persists only a hash and blocks retry until the mailbox appears', async () => {
  const { api, draft, calls, store, accounts } = load({ failure: true });
  await assert.rejects(api.connectMailbox(1, 'token', draft, 'synthetic-secret'));
  assert.equal(store.size, 1); const stored = [...store.values()][0]; assert.match(stored, /^[a-f0-9]{64}$/); assert.ok(!stored.includes('synthetic-secret'));
  await assert.rejects(api.connectMailbox(1, 'token', draft, 'synthetic-secret'), /unconfirmed/);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  accounts.push({ id: 2, from_email: draft.from_email });
  assert.equal(await api.pendingMailbox(1, accounts), false); assert.equal(store.size, 0);
});
test('Gmail only opens a trusted provider URL bound to this Hub callback', async () => {
  const { api } = load(); const url = await api.gmailConnectUrl('synthetic'); assert.match(url, /^https:\/\/accounts.google.com\//);
  for (const bad of [url.replace('accounts.google.com', 'evil.invalid'), url.replace('https:', 'http:'), url.replace('crm.example.invalid', 'evil.invalid'), url.replace('response_type=code', 'response_type=token')]) assert.throws(() => api.trustedGoogleUrl(bad));
  await assert.rejects(load({ configured: false }).api.gmailConnectUrl('token'), /not configured/);
  const anonymous = load(); await assert.rejects(anonymous.api.gmailConnectUrl('')); assert.equal(anonymous.calls.length, 0);
});
test('Concurrent create is blocked before a second request', async () => {
  const { api, draft, calls } = load();
  const first = api.connectMailbox(1, 'token', draft, 'synthetic');
  await assert.rejects(api.connectMailbox(1, 'token', draft, 'synthetic'), /already in progress/);
  await first; assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});
