const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/activity-date.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Activity dates validate real calendar days, including century leap years', () => {
  for (const date of ['2000-02-29', '2024-02-29', '2026-12-31']) assert.equal(api.validActivityDate(date), true, date);
  for (const date of ['', '1900-02-29', '2100-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-1', '2026-01-01T00:00:00Z']) assert.equal(api.validActivityDate(date), false, date);
});
