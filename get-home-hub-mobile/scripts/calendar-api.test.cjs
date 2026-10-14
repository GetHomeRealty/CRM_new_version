const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadApi(failure) {
  const calls = [];
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/calendar/calendar-api.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }), Date,
    fetch: async (url, options) => { calls.push({ url: new URL(url), options }); return failure ? { ok: false, status: failure.status, json: async () => failure.body } : { ok: true, json: async () => ({}) }; } });
  return { api: exports, calls };
}

test('Calendar queries preserve area and leap-year month boundaries', async () => {
  const { api, calls } = loadApi();
  await api.fetchCalendar('test', 'desk', new Date(2028, 1, 15));
  assert.equal(calls[0].url.searchParams.get('from'), '2028-02-01');
  assert.equal(calls[0].url.searchParams.get('to'), '2028-02-29');
  for (const call of calls) assert.equal(call.url.searchParams.get('area'), 'desk');
  await api.fetchCalendar('test', 'crm', new Date(2026, 12, 1));
  assert.equal(calls[2].url.searchParams.get('from'), '2027-01-01');
  assert.equal(calls[2].url.searchParams.get('to'), '2027-01-31');
});

test('Only scheduling overlaps offer an override; stale writes and validation do not', async () => {
  for (const [status, conflict, expected] of [
    [400, { id: 12 }, true], [400, { dates: ['2030-02-01'] }, true],
    [409, { current_version: 3 }, false], [400, undefined, false], [403, { id: 12 }, false],
  ]) {
    const { api } = loadApi({ status, body: { message: 'Request rejected', conflict } });
    await assert.rejects(api.createEvent('test', {}, 'desk'), error => error instanceof api.CalendarApiError && error.overlap === expected && error.status === status);
  }
});

test('All task and event writes carry their selected area; series and versions survive', async () => {
  const { api, calls } = loadApi();
  const record = { id: 11, version: 7 };
  for (const area of ['crm', 'desk']) {
    const start = calls.length;
    await api.createTodo('test', { title: 'Test' }, area);
    await api.updateTodo('test', record, { status: 'completed' }, area);
    await api.deleteTodo('test', record, area);
    await api.createEvent('test', { recur_freq: 'weekly', recur_count: 3, enable_reminder: false }, area);
    await api.updateEvent('test', record, { title: 'Updated' }, area, 'series');
    await api.deleteEvent('test', record, area, 'series');
    for (const call of calls.slice(start)) assert.equal(call.url.searchParams.get('area'), area);
    assert.equal(JSON.parse(calls[start + 1].options.body).version, 7);
    assert.equal(JSON.parse(calls[start + 3].options.body).recur_count, 3);
    assert.equal(JSON.parse(calls[start + 3].options.body).enable_reminder, false);
    assert.equal(calls[start + 4].url.searchParams.get('scope'), 'series');
    assert.equal(JSON.parse(calls[start + 4].options.body).version, 7);
    assert.equal(calls[start + 5].url.searchParams.get('scope'), 'series');
  }
});
