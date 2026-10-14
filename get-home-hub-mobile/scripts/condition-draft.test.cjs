const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/condition-draft.ts'), 'utf8');
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, Date });
const standard = { type: 'Financing', custom_name: null, deadline: null, status: 'Pending' };

test('Standard conditions remain editable without a custom name', () => {
  assert.equal(api.conditionDraftError([standard]), null);
  const payload = api.conditionChanges([{ ...standard, status: 'Fulfilled' }]);
  assert.equal(payload.conditions[0].type, 'Financing');
  assert.equal(payload.conditions[0].custom_name, null);
  assert.equal(payload.conditions[0].status, 'Fulfilled');
});

test('Custom names are required and normalized without changing the input', () => {
  assert.throws(() => api.conditionChanges([{ ...standard, type: 'Custom', custom_name: '  ' }]), /Enter a name/);
  const draft = { ...standard, type: 'Custom', custom_name: '  Lender approval  ' };
  assert.equal(api.conditionChanges([draft]).conditions[0].custom_name, 'Lender approval');
  assert.equal(draft.custom_name, '  Lender approval  ');
});

test('Deadlines validate calendar dates including leap years', () => {
  for (const deadline of ['2027-02-29', '2028-02-30', '2028-13-01', '09/10/2028', 'invalid']) {
    assert.throws(() => api.conditionChanges([{ ...standard, deadline }]), /valid deadline/);
  }
  assert.equal(api.conditionChanges([{ ...standard, deadline: ' 2028-02-29 ' }]).conditions[0].deadline, '2028-02-29');
  assert.equal(api.conditionChanges([{ ...standard, deadline: ' ' }]).conditions[0].deadline, null);
});

test('Removing all conditions marks the offer unconditional', () => {
  const payload = api.conditionChanges([]);
  assert.equal(payload.conditional_offer, false);
  assert.equal(payload.conditions.length, 0);
});
