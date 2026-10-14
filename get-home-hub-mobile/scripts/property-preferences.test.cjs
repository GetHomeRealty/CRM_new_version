const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/property-preferences.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
const plain = value => JSON.parse(JSON.stringify(value));

test('Multiple preferences preserve custom fields, zeroes, decimals and independent budgets', () => {
  const input = [{ budget: { min: '0', max: '900000', currency: 'CAD' }, bathrooms: '2.5', custom: { imported: true } }, { bedrooms: '3', locations: ['Toronto'] }];
  const output = plain(api.serializePreferences(input));
  assert.equal(output.length, 2);
  assert.deepEqual(output[0], { budget: { min: 0, max: 900000, currency: 'CAD' }, bathrooms: 2.5, custom: { imported: true } });
  assert.deepEqual(output[1], { bedrooms: 3, locations: ['Toronto'] });
  assert.equal(input[0].bathrooms, '2.5');
});
test('Empty values clear numeric fields and malformed values fail without silent data loss', () => {
  assert.deepEqual(plain(api.serializePreferences([{ bedrooms: ' ', budget: { max: '' } }])), [{ bedrooms: null, budget: { max: null } }]);
  for (const value of ['abc', 'Infinity', '1.2.3']) assert.throws(() => api.serializePreferences([{ bathrooms: value }]), /Preference 1: Bathrooms/);
  assert.deepEqual(plain(api.serializePreferences([])), []);
});
test('Property types and features keep exact case and embedded commas while removing blanks', () => {
  assert.deepEqual(plain(api.serializePreferences([{ propertyType: [' Custom, loft ', '', 'Custom, loft', 'custom'], features: [' Elevator ', ''] }])), [{ propertyType: ['Custom, loft', 'custom'], features: ['Elevator'] }]);
});
