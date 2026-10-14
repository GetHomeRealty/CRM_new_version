const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file) {
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, require: () => ({ ForbiddenException: Error }) });
  return api;
}
const mobile = load('../src/leads/lead-permissions.ts');
const server = load('../../server/src/core/authz.ts');

test('Mobile identity locks match the actual backend capability threshold for every role', () => {
  const minimum = server.CAPABILITIES['leads.rewrite-identity'];
  for (const role of [...Object.keys(server.ROLE_RANK), 'unknown']) {
    const privileged = (server.ROLE_RANK[role] || 0) >= minimum;
    assert.equal(mobile.leadIdentityLocked({ id: 12, role }, { owner_user_id: 99 }), !privileged, role);
    assert.equal(mobile.leadIdentityLocked({ id: 12, role }, { owner_user_id: 12 }), false, role);
    assert.equal(mobile.leadIdentityLocked({ id: 12, role }, { owner_user_id: null }), !privileged, role);
  }
});
test('Missing identity fails closed and locked writes are refused before the request', () => {
  assert.equal(mobile.leadIdentityLocked(null, { owner_user_id: 12 }), true);
  assert.equal(mobile.leadIdentityLocked({ role: 'agent' }, {}), true);
  for (const field of mobile.lockedLeadIdentityFields) {
    assert.throws(() => mobile.assertLeadIdentityUpdateAllowed(true, { [field]: null }), /brokerage owns/);
  }
  assert.doesNotThrow(() => mobile.assertLeadIdentityUpdateAllowed(true, { notes: 'Follow up', lead_status: 'hot', property_preferences: [] }));
  assert.doesNotThrow(() => mobile.assertLeadIdentityUpdateAllowed(false, { email: null }));
});
