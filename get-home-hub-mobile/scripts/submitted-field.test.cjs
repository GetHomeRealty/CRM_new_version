const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/submitted-field.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Acknowledging a submitted field retains newer typing and explicit clears', () => {
  assert.equal(api.clearSubmittedField('saved', 'saved'), '');
  assert.equal(api.clearSubmittedField('new draft', 'saved'), 'new draft');
  assert.equal(api.clearSubmittedField('', 'saved'), '');
  assert.equal(api.clearSubmittedField('14:00', '14:00', '12:00'), '12:00');
  assert.equal(api.clearSubmittedField('15:00', '14:00', '12:00'), '15:00');
});
