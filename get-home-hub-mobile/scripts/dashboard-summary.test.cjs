const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/dashboard/dashboard-summary.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Missing data never becomes a zero workload', () => {
  assert.equal(api.dashboardSummary(undefined, true, false).title, 'Loading your work…');
  assert.equal(api.dashboardSummary(undefined, false, true).title, 'Dashboard unavailable');
  assert.equal(api.dashboardSummary({ crm: null, desk: null }, false, false).title, 'No dashboard access');
});
test('Only accessible areas contribute counts and stale totals are labelled', () => {
  const data = { crm: { tasks: { due_today: 1, overdue: 2 } }, desk: null };
  const summary = api.dashboardSummary(data, false, false);
  assert.equal(summary.title, '3 items need your attention');
  assert.equal(summary.detail, '2 overdue tasks');
  assert.match(api.dashboardSummary(data, false, true).detail, /Last loaded totals/);
  assert.equal(api.dashboardSummary({ crm: null, desk: { closings: { overdue: 1 } } }, false, false).title, '1 item needs your attention');
});
