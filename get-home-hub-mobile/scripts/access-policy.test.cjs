const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/auth/access-policy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });

test('Module contract accepts server arrays and fails closed for missing or legacy maps', () => {
  assert.equal(api.hasModule({ modules: ['crm'] }, 'crm'), true);
  assert.equal(api.hasModule({ modules: ['crm'] }, 'desk'), false);
  for (const user of [null, {}, { modules: [] }, { modules: { crm: true } }]) assert.equal(api.hasModule(user, 'crm'), false);
});
test('Screen grants distinguish view/edit and reject missing or malformed values', () => {
  for (const grant of [undefined, 'none', 'admin', true, 2]) assert.equal(api.canScreen({ permissions: { lead: grant } }, 'lead'), false);
  assert.equal(api.canScreen({ permissions: { lead: 'view' } }, 'lead'), true);
  assert.equal(api.canScreen({ permissions: { lead: 'view' } }, 'lead', 'edit'), false);
  assert.equal(api.canScreen({ permissions: { lead: 'edit' } }, 'lead', 'edit'), true);
  assert.equal(api.canScreen({ role: 'admin' }, 'lead'), false);
  assert.equal(api.canScreen({ is_admin: true }, 'lead', 'edit'), true);
});
test('Admin screen privilege never bypasses absent module access; revocation is immediate', () => {
  const user = { is_admin: true, modules: ['crm'] };
  assert.equal(api.canAreaScreen(user, 'crm', 'lead'), true);
  assert.equal(api.canAreaScreen(user, 'desk', 'transactions'), false);
  user.modules = [];
  assert.equal(api.canAreaScreen(user, 'crm', 'lead'), false);
});
