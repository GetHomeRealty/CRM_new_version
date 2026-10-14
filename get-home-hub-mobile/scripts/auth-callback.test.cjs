const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(transform) {
  const api = {}, writes = [], requests = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/auth/auth-api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: api, URL, URLSearchParams, btoa,
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ access_token: 'synthetic', user: { name: 'Local' } }) }; },
    require: (name) => {
      if (name === 'expo-crypto') return { getRandomBytesAsync: async () => new Uint8Array(32).fill(42),
        digestStringAsync: async () => 'synthetic', CryptoDigestAlgorithm: { SHA256: 'sha256' }, CryptoEncoding: { BASE64: 'base64' } };
      if (name === 'expo-secure-store') return { setItemAsync: async (...args) => writes.push(args) };
      if (name === 'expo-web-browser') return { openAuthSessionAsync: async (url) => {
        const state = new URL(url).searchParams.get('state');
        return { type: 'success', url: transform(`gethomehub://auth/callback?state=${state}&code=local-code`) };
      } };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      return { environment: { apiUrl: 'http://localhost:8000', authUrl: 'http://localhost:5173',
        mobileClientId: 'test', mobileRedirectUri: 'gethomehub://auth/callback' } };
    },
  });
  return { api, writes, requests };
}

test('Valid CRM callback exchanges the code and stores the synthetic session', async () => {
  const { api, writes, requests } = harness((url) => url);
  assert.equal((await api.signInWithCrm()).token, 'synthetic');
  assert.equal(writes.length, 1);
  assert.equal(requests[0], 'http://localhost:8000/api/sso/mobile/token');
});

test('Wrong destinations, ambiguous parameters and oversized callbacks never exchange or store credentials', async () => {
  for (const transform of [
    (url) => url.replace('gethomehub:', 'https:'),
    (url) => url.replace('//auth/', '//other/'),
    (url) => url.replace('/callback?', '/other?'),
    (url) => `${url}&state=second`,
    (url) => `${url}&code=second`,
    (url) => `${url}#fragment`,
    (url) => `${url}&padding=${'x'.repeat(8192)}`,
  ]) {
    const { api, writes, requests } = harness(transform);
    await assert.rejects(api.signInWithCrm(), /could not be verified/);
    assert.equal(writes.length, 0);
    assert.equal(requests.length, 0);
  }
});
