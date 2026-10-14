const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, requireMock) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: requireMock });
  return exports;
}
const policy = load('../src/auth/access-policy.ts');
test('Open lead detail is unmounted when view access or the session is removed', () => {
  let grant = 'view'; let token = 'synthetic';
  const { LeadDetailSheet } = load('../src/components/lead-detail-sheet.tsx', name => {
    if (name === 'react/jsx-runtime') return require(name);
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token, user: { modules: ['crm'], permissions: { lead: grant } } }) };
    if (name.includes('access-policy')) return policy;
    if (name === 'react-native') return { StyleSheet: { create: x => x } };
    if (name.includes('constants/theme')) return { Spacing: {} };
    return {};
  });
  const props = { leadId: 1, onClose() {} };
  assert.ok(LeadDetailSheet(props));
  grant = 'none'; assert.equal(LeadDetailSheet(props), null);
  grant = 'edit'; assert.ok(LeadDetailSheet(props));
  token = null; assert.equal(LeadDetailSheet(props), null);
});
test('Read-only activity handlers refuse writes while history remains visible', () => {
  const mutations = [];
  const primitive = () => null;
  const { LeadActivity } = load('../src/components/lead-activity.tsx', name => {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'react') return { useState: initial => [initial, () => {}] };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'], permissions: { lead: 'view' } } }) };
    if (name.includes('access-policy')) return policy;
    if (name.includes('leads-api')) return new Proxy({}, { get: () => () => assert.fail('Denied API called') });
    if (name.includes('submitted-field')) return {};
    if (name.includes('activity-date')) return { validActivityDate: () => true };
    if (name.includes('constants/theme')) return { Spacing: {} };
    if (name === '@tanstack/react-query') return { useQueryClient: () => ({}), useMutation: config => { mutations.push(config.mutationFn); return {}; } };
    if (name === 'react-native') return { ActivityIndicator: primitive, Alert: {}, Pressable: primitive, TextInput: primitive, View: primitive, StyleSheet: { create: x => x } };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({}) };
    throw Error(name);
  });
  const tree = LeadActivity({ lead: { id: 1, notes_history: [{ id: 2, content: 'Visible history', created_at: null }] } });
  assert.match(JSON.stringify(tree), /Visible history/);
  assert.match(JSON.stringify(tree), /view only/);
  assert.equal(mutations.length, 3);
  for (const mutation of mutations) assert.throws(() => mutation({ kind: 'notes', content: 'Denied' }), /permission/);
});
test('Create lead mutation refuses view-only, revoked and missing module grants before API call', () => {
  for (const [user, allowed] of [
    [null, false], [{ modules: ['crm'], permissions: { lead: 'view' } }, false],
    [{ modules: [], permissions: { lead: 'edit' } }, false],
    [{ modules: ['crm'], permissions: { lead: 'none' } }, false],
    [{ modules: ['crm'], permissions: { lead: 'edit' } }, true],
  ]) {
    let mutation; let calls = 0;
    const primitive = () => null;
    const { CreateLeadSheet } = load('../src/components/create-lead-sheet.tsx', name => {
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'react') return { useState: initial => [initial, () => {}] };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user }) };
      if (name.includes('access-policy')) return policy;
      if (name.includes('leads-api')) return { createLead: () => { calls++; } };
      if (name === '@tanstack/react-query') return { useQueryClient: () => ({}), useMutation: config => { mutation = config.mutationFn; return {}; } };
      if (name === 'react-native') return { ActivityIndicator: primitive, Modal: primitive, Pressable: primitive, ScrollView: primitive, TextInput: primitive, View: primitive, StyleSheet: { create: x => x } };
      if (name.includes('safe-area')) return { SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('themed-view')) return { ThemedView: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      throw Error(name);
    });
    CreateLeadSheet({ onClose() {}, onCreated() {} });
    if (allowed) mutation(); else assert.throws(() => mutation(), /permission/);
    assert.equal(calls, allowed ? 1 : 0);
  }
});
