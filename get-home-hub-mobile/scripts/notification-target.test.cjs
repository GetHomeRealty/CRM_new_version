const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/notifications/notification-target.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: api });
test('Known website record links map to native records', () => {
  assert.equal(api.notificationTarget('/crm/lead/42').kind, 'lead');
  assert.equal(api.notificationTarget('/crm/lead/42').id, 42);
  assert.equal(api.notificationTarget('/desk/transactions/9').kind, 'transaction');
});
test('External, malformed and unsupported links are refused', () => {
  for (const link of ['', 'https://example.test/crm/lead/1', '//example.test', 'javascript:alert(1)',
    '/crm/lead/0', '/crm/lead/-1', '/crm/lead/1?redirect=https://example.test', '/crm/lead/1/../2',
    '/crm/lead/999999999999999999999', '/crm/lead/%31', '/desk/settings']) {
    assert.equal(api.notificationTarget(link), null, link);
  }
});
