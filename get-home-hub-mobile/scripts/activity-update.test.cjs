const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function setup(ok = true) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/leads-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok, json: async () => ok ? { id: 12 } : { message: 'Not authorized' } }; },
  });
  return { api, calls };
}
test('Showing transitions send only status to the scoped showing endpoint', async () => {
  const { api, calls } = setup();
  for (const status of ['scheduled', 'completed', 'cancelled']) await api.changeLeadActivity('test-token', 7, { kind: 'showings', id: 15, status });
  calls.forEach((call, i) => {
    assert.equal(call.url, 'http://localhost:8000/api/leads/7/showings/15');
    assert.equal(call.options.method, 'PUT');
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(call.options.body), { status: ['scheduled', 'completed', 'cancelled'][i] });
  });
});
test('Task transitions use scoped authenticated PUT without replacing unrelated task fields', async () => {
  const { api, calls } = setup();
  for (const status of ['pending', 'completed', 'cancelled']) await api.changeLeadActivity('test-token', 7, { kind: 'tasks', id: 12, status });
  calls.forEach((call, index) => {
    assert.equal(call.url, 'http://localhost:8000/api/leads/7/tasks/12');
    assert.equal(call.options.method, 'PUT');
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(call.options.body), { status: ['pending', 'completed', 'cancelled'][index] });
  });
});
test('Pin and unpin preserve note content and server errors remain failures', async () => {
  const { api, calls } = setup();
  for (const pinned of [true, false]) await api.changeLeadActivity('test-token', 7, { kind: 'notes', id: 12, pinned });
  assert.equal(calls[0].url, 'http://localhost:8000/api/leads/7/notes/12');
  assert.deepEqual(JSON.parse(calls[0].options.body), { pinned: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), { pinned: false });
  await assert.rejects(setup(false).api.changeLeadActivity('test-token', 7, { kind: 'notes', id: 12, pinned: true }), /Not authorized/);
});
test('Task creation sends description and each supported priority through the authenticated endpoint', async () => {
  const { api, calls } = setup();
  for (const priority of ['low', 'medium', 'high']) {
    await api.addLeadActivity('test-token', 7, 'tasks', { title: 'Synthetic task', description: 'Local follow-up instructions', due_date: '2030-01-01', status: 'pending', priority });
  }
  calls.forEach((call, index) => {
    assert.equal(call.url, 'http://localhost:8000/api/leads/7/tasks');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    const body = JSON.parse(call.options.body);
    assert.equal(body.description, 'Local follow-up instructions');
    assert.equal(body.priority, ['low', 'medium', 'high'][index]);
  });
});
