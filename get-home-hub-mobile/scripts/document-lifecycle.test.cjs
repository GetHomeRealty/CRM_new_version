/* global __dirname */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const source = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const policy = {}; vm.runInNewContext(source('auth/access-policy.ts'), { exports: policy });
function adapter(fetch) { const exports = {}; vm.runInNewContext(source('transactions/document-lifecycle-api.ts'), { exports, Error, fetch, require: name => name.includes('access-policy') ? policy : { environment: { apiUrl: 'http://127.0.0.1:8000' } } }); return exports; }
const user = { id: 1, role: 'documentation', modules: ['desk'], permissions: { transactions: 'edit' } };
const doc = { id: 9, title: 'Synthetic document', state: 'active', validation: 'Pending', is_condition: false, review_version: 'a'.repeat(64), deleted_by: null };
test('Document action policy enforces view/edit, condition/Valid override and distinct restore states', () => {
  const api = adapter(); assert.equal(api.canDocumentAction(user, doc, 'remove'), true);
  for (const value of [{ ...user, role: 'agent' }, { ...user, role: 'unknown' }, { ...user, modules: [] }, { ...user, permissions: { transactions: 'view' } }]) assert.equal(api.canDocumentAction(value, doc, 'remove'), false);
  for (const value of [{ ...doc, validation: 'Valid' }, { ...doc, is_condition: true }]) { assert.equal(api.canDocumentAction(user, value, 'remove'), false); assert.equal(api.canDocumentAction({ ...user, role: 'admin' }, value, 'remove'), true); }
  assert.equal(api.canDocumentAction({ ...user, role: 'manager' }, { ...doc, state: 'pending' }, 'restore'), true);
  assert.equal(api.canDocumentAction({ ...user, role: 'manager' }, { ...doc, state: 'removed' }, 'restore'), false);
  assert.equal(api.canDocumentAction({ ...user, role: 'admin' }, { ...doc, state: 'removed' }, 'restore'), true);
});
test('Lifecycle list/mutation use authenticated transaction-specific routes, snapshot and single request', async () => {
  let calls = 0; const api = adapter(async (url, options) => { calls++; assert.equal(options.headers.Authorization, 'Bearer synthetic'); if (options.method === 'POST') { assert.equal(url, 'http://127.0.0.1:8000/api/transactions/2/documents/9/lifecycle'); assert.deepEqual(JSON.parse(options.body), { action: 'remove', review_version: doc.review_version }); } else assert.equal(url, 'http://127.0.0.1:8000/api/transactions/2/documents/lifecycle'); return { ok: true, json: async () => ({ documents: [doc], has_more: false }) }; });
  await api.fetchDocumentLifecycle('synthetic', 2); await api.changeDocumentLifecycle('synthetic', user, 2, doc, 'remove'); assert.equal(calls, 2);
});
test('Transport/conflict/server failures block retry; invalid identifiers and denied roles do not send', async () => {
  for (const status of [null, 409, 500, 403, 422]) { let calls = 0; const api = adapter(async () => { calls++; if (status === null) throw Error('lost'); return { ok: false, status }; }); await assert.rejects(api.changeDocumentLifecycle('synthetic', user, 2, doc, 'remove'), error => (error instanceof api.UnconfirmedDocumentLifecycleError) === [null, 409, 500].includes(status)); assert.equal(calls, 1); }
  const api = adapter(() => { throw Error('Must not send'); }); await assert.rejects(api.changeDocumentLifecycle('synthetic', user, -1, doc, 'remove'), /Refresh/); await assert.rejects(api.changeDocumentLifecycle('synthetic', { ...user, role: 'agent' }, 2, doc, 'remove'), /permission/);
});
for (const scenario of ['remove', 'restore', 'pending-restore', 'view-only', 'uncertain', 'permission-loss', 'cached-error', 'cached-fetch']) test(`Document lifecycle screen ${scenario} requires current access, fresh data and confirmation`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let auth = { token: 'synthetic', user: { ...user, ...(scenario === 'restore' ? { role: 'admin' } : scenario === 'pending-restore' ? { role: 'manager' } : {}), ...(scenario === 'view-only' ? { permissions: { transactions: 'view' } } : {}) } }, sends = 0, closes = 0, alerts = [], invalidations = [];
  const row = { ...doc, state: scenario === 'restore' ? 'removed' : scenario === 'pending-restore' ? 'pending' : 'active' };
  const query = { data: { documents: [row], has_more: false }, isFetching: scenario === 'cached-fetch', isError: scenario === 'cached-error', error: Error('Synthetic access rejection'), refetch: async () => {} };
  const primitive = ({ children }) => React.createElement('div', null, children), api = adapter(), exports = {};
  vm.runInNewContext(source('components/document-lifecycle-sheet.tsx'), { exports, Error, AbortController, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name === '@tanstack/react-query') return { useQuery: () => query, useQueryClient: () => ({ invalidateQueries: async value => invalidations.push(value.queryKey) }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => auth };
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff', border: '#ddd' }) };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('document-lifecycle-api')) return { ...api, changeDocumentLifecycle: async (token, principal, txn, selected, action) => { sends++; assert.equal(token, 'synthetic'); assert.equal(txn, 2); assert.equal(api.canDocumentAction(principal, selected, action), true); assert.equal(action, ['restore', 'pending-restore'].includes(scenario) ? 'restore' : 'remove'); if (scenario === 'uncertain') throw new api.UnconfirmedDocumentLifecycleError('Unconfirmed action.'); } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root')); const render = () => root.render(React.createElement(exports.DocumentLifecycleSheet, { transactionId: 2, onClose: () => closes++ })); const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  try {
    await React.act(async () => render());
    if (['view-only', 'cached-error', 'cached-fetch'].includes(scenario)) { assert.equal(document.querySelector('[aria-label="Remove Synthetic document"]'), null); assert.equal(document.querySelector('[aria-label="Restore Synthetic document"]'), null); assert.equal(sends, 0); }
    else {
      const action = ['restore', 'pending-restore'].includes(scenario) ? 'Restore' : 'Remove'; await React.act(async () => document.querySelector(`[aria-label="${action} Synthetic document"]`).click()); assert.equal(sends, 0); assert.equal(alerts[0][2][0].text, 'Cancel'); assert.equal(alerts[0][2][0].onPress, undefined);
      if (scenario === 'permission-loss') { auth = { ...auth, user: { ...user, permissions: { transactions: 'view' } } }; await React.act(async () => render()); }
      await React.act(async () => alerts[0][2][1].onPress()); await settle();
      if (scenario === 'permission-loss') assert.equal(sends, 0);
      else if (scenario === 'uncertain') { assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(document.querySelector('[aria-label="Remove Synthetic document"]').disabled, true); await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1); }
      else { assert.equal(sends, 1); assert.equal(closes, 1); assert.equal(invalidations.length, 3); }
    }
    await React.act(async () => root.unmount());
  } finally { global.window = oldWindow; global.document = oldDocument; dom.window.close(); }
});
