const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, requireMock) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: requireMock });
  return exports;
}
const policy = load('../src/auth/access-policy.ts');
function tabs(user) {
  const NativeTabs = Object.assign(() => null, { Trigger: Object.assign(() => null, { Label: () => null, Icon: () => null }) });
  const component = load('../src/components/app-tabs.tsx', (name) => {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { useColorScheme: () => 'light' };
    if (name.includes('unstable-native-tabs')) return { NativeTabs };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ user }) };
    if (name.includes('access-policy')) return policy;
    if (name.includes('constants/theme')) return { Colors: { light: {} } };
    throw new Error(name);
  }).default;
  return Object.fromEntries(component().props.children.map((child) => [child.props.name, child.props.hidden === true]));
}
test('Native route exclusion matches module and screen grants, not role names', () => {
  for (const user of [null, {}, { role: 'admin' }, { modules: ['crm'], permissions: {} }]) {
    const result = tabs(user);
    assert.equal(result.leads, true);
    assert.equal(result.transactions, true);
    assert.equal(result.calendar, true);
    assert.equal(result.index, false);
  }
  const crm = tabs({ modules: ['crm'], permissions: { lead: 'view', calendar: 'edit' } });
  assert.equal(crm.leads, false); assert.equal(crm.transactions, true); assert.equal(crm.calendar, false);
  const desk = tabs({ modules: ['desk'], permissions: { transactions: 'view', calendar: 'view' } });
  assert.equal(desk.leads, true); assert.equal(desk.transactions, false); assert.equal(desk.calendar, false);
});
test('Rerender after permission removal excludes the previously available route', () => {
  const user = { modules: ['crm'], permissions: { lead: 'view' } };
  assert.equal(tabs(user).leads, false);
  user.permissions.lead = 'none';
  assert.equal(tabs(user).leads, true);
});
