const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/demographics.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
const plain = value => JSON.parse(JSON.stringify(value));

test('Demographic edits normalize values and preserve omitted fields', () => {
  assert.deepEqual(plain(api.serializeDemographics({ age: '0', religion: ' Test ', date_of_birth: '2000-02-29' })), { age: 0, religion: 'Test', date_of_birth: '2000-02-29' });
  assert.deepEqual(plain(api.serializeDemographics({})), {});
  assert.equal(api.serializeDemographics({ age: '120' }).age, 120);
});
test('Blank demographics explicitly clear without manufacturing zero ages', () => {
  assert.deepEqual(plain(api.serializeDemographics({ age: ' ', religion: '', date_of_birth: '', marriage_day: null })), { age: null, religion: null, date_of_birth: null, marriage_day: null });
});
test('Invalid dates, ages and oversized religion fail before a save', () => {
  for (const age of ['-1', '121', '2.5', 'abc', 'Infinity']) assert.throws(() => api.serializeDemographics({ age }), /Age/);
  for (const date of ['2025-02-29', '2024-04-31', '2024-13-01', '01/01/2024', '2024-1-1']) {
    assert.throws(() => api.serializeDemographics({ date_of_birth: date }), /Birthday/);
    assert.throws(() => api.serializeDemographics({ marriage_day: date }), /anniversary/);
  }
  assert.throws(() => api.serializeDemographics({ religion: 'a'.repeat(65) }), /Religion/);
});
