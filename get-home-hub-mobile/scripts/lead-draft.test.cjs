const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-draft.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
const plain = value => JSON.parse(JSON.stringify(value));

test('A save retains edits made while the request was pending', () => {
  const submitted = { name: 'Original', language: 'English' };
  const current = { name: 'Newer name', language: 'English', notes: 'New note' };
  assert.deepEqual(plain(api.remainingLeadDraft(current, submitted)), { name: 'Newer name', notes: 'New note' });
  assert.equal(current.language, 'English');
});

test('Successful saves acknowledge matching tags and explicit cleared values', () => {
  assert.deepEqual(plain(api.remainingLeadDraft({ tags: ['VIP'], email: null }, { tags: ['VIP'], email: null })), {});
  assert.deepEqual(plain(api.remainingLeadDraft({ tags: [], language: '' }, { tags: ['VIP'], language: 'English' })), { tags: [], language: '' });
});
