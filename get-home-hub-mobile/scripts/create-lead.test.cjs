const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function setup(ok = true, failure = { message: 'This email already exists in your book.' }, options = { lead_status: [], lead_type: [], lead_source: [], lead_response: [], client_type: [] }) {
  const api = {}, calls = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/leads/leads-api.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, request) => { calls.push({ url, options: request }); return { ok, json: async () => ok ? url.endsWith('/options') ? options : { id: 52 } : failure }; },
  });
  return { api, calls };
}
test('Create lead validates before sending and normalizes required fields', async () => {
  const { api, calls } = setup();
  for (const input of [{}, { name: 'Test', email: 'invalid' }, { name: ' '.repeat(3), email: 'test@example.invalid' }]) {
    await assert.rejects(api.createLead('test', input));
  }
  assert.equal(calls.length, 0);
  const created = await api.createLead('test', { name: ' Local Test ', email: ' lead@example.invalid ', phone: '5550100' });
  assert.equal(created.id, 52);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Local Test', email: 'lead@example.invalid', phone: '5550100' });
});
test('Server validation failures remain visible to the creation form', async () => {
  const { api } = setup(false);
  await assert.rejects(api.createLead('test', { name: 'Test', phone: '4165550100', email: 'lead@example.invalid' }), /already exists/);
});

test('Every field validation error is presented, not just the summary', async () => {
  const { api } = setup(false, { message: 'Validation failed', errors: { email: ['Email already exists'], phone: ['Phone is too long'] } });
  await assert.rejects(api.createLead('test', { name: 'Test', phone: '4165550100', email: 'lead@example.invalid' }), error => error.message === 'Email already exists\nPhone is too long');
});

test('Phone-only leads match the current website contract with a null email', async () => {
  const { api, calls } = setup();
  for (const email of [undefined, null, '', '  ']) {
    await api.createLead('test', { name: ' Phone Only ', phone: ' 416-555-0100 ', email });
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { name: 'Phone Only', phone: '416-555-0100', email: null });
  }
});

test('Missing or oversized phone and malformed optional email never issue a request', async () => {
  const { api, calls } = setup();
  for (const phone of [undefined, null, '', ' ', '1'.repeat(65)]) {
    await assert.rejects(api.createLead('test', { name: 'Test', phone }), /phone number/);
  }
  await assert.rejects(api.createLead('test', { name: 'Test', phone: '4165550100', email: 'invalid' }), /valid email/);
  assert.equal(calls.length, 0);
});

test('Custom language updates preserve the language and allow clearing it', async () => {
  const { api, calls } = setup();
  await api.updateLead('test', 52, { language: 'Telugu' });
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/52');
  assert.deepEqual(JSON.parse(calls[0].options.body), { language: 'Telugu' });
  await api.updateLead('test', 52, { language: '' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { language: '' });
});

test('Classification options use the authenticated website endpoint and updates preserve values', async () => {
  const { api, calls } = setup();
  const signal = new AbortController().signal;
  await api.fetchLeadOptions('test', signal);
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/options');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test');
  await api.updateLead('test', 52, { client_type: 'server-provided-value', lead_response: null });
  assert.deepEqual(JSON.parse(calls[1].options.body), { client_type: 'server-provided-value', lead_response: null });
});

test('Actual backend classification arrays are accepted unchanged', async () => {
  const constants = {};
  const source = fs.readFileSync(require('node:path').join(__dirname, '../../server/src/leads/lead.constants.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: constants });
  const options = { lead_status: constants.LEAD_STATUS, lead_type: constants.LEAD_TYPE, lead_source: constants.LEAD_SOURCE, lead_response: constants.LEAD_RESPONSE, client_type: constants.CLIENT_TYPE };
  const { api } = setup(true, undefined, options);
  assert.equal(await api.fetchLeadOptions('test'), options);
  for (const malformed of [{}, null, { ...options, client_type: ['Buyer', 7] }]) {
    await assert.rejects(setup(true, undefined, malformed).api.fetchLeadOptions('test'), /classifications are unavailable/);
  }
});
