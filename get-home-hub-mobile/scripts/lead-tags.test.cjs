const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-tags.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Tags trim whitespace, preserve case and commas, and ignore exact duplicates', () => {
  const tags = ['VIP'];
  assert.equal(api.addLeadTag(tags, ' VIP '), tags);
  assert.equal(api.addLeadTag(tags, ' '), tags);
  assert.equal(api.addLeadTag(tags, ' East, Toronto ')[1], 'East, Toronto');
  assert.equal(api.addLeadTag(tags, 'vip')[1], 'vip');
  assert.equal(tags.length, 1);
});
test('Tag limit is enforced before the backend silently truncates', () => {
  const tags = Array.from({ length: 50 }, (_, i) => String(i));
  assert.throws(() => api.addLeadTag(tags, 'extra'), /50 tags/);
  assert.equal(api.addLeadTag(tags, '0'), tags);
});
test('Existing tag search preserves canonical spelling and excludes selected exact names', () => {
  const available = ['VIP', 'vip', 'East, Toronto', 'Buyer'];
  assert.deepEqual(Array.from(api.matchingLeadTags(available, ['VIP'], ' VI ')), ['vip']);
  assert.deepEqual(Array.from(api.matchingLeadTags(available, [], 'toronto')), ['East, Toronto']);
  assert.deepEqual(Array.from(api.matchingLeadTags(available, [], 'missing')), []);
  assert.equal(api.matchingLeadTags(available, [], '').length, 4);
  assert.equal(available.length, 4);
});
