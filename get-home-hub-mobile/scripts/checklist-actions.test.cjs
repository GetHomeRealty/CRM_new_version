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
function adapter(fetch) { const exports = {}; vm.runInNewContext(source('transactions/checklist-actions-api.ts'), { exports, Error, fetch, require: name => name.includes('access-policy') ? policy : { environment: { apiUrl: 'http://127.0.0.1:8000' } } }); return exports; }
const user = { id: 1, role: 'documentation', modules: ['desk'], permissions: { transactions: 'edit' } };
const doc = { id: 9, title: 'Synthetic document', validation: 'Pending', review_version: 'a'.repeat(64), has_file: true, file_name: 'Primary.pdf', files: [{ index: 0, file_name: 'A.pdf', client_name: 'A' }] };
const remove = { type: 'remove', document: doc, kind: 'indexed', index: 0, label: 'A · A.pdf' };
test('Checklist action permission matrix and payload validation reject invalid/unauthorized requests', () => {
  const api = adapter(); assert.equal(api.canChecklistAction({ ...user, role: 'agent' }, { type: 'create', title: 'QA' }), true);
  for (const type of ['readiness', 'remove']) assert.equal(api.canChecklistAction({ ...user, role: 'agent' }, { ...remove, type }), false);
  for (const value of [{ ...user, modules: [] }, { ...user, permissions: { transactions: 'view' } }, null]) assert.equal(api.canChecklistAction(value, remove), false);
  assert.equal(api.canChecklistAction(user, { ...remove, document: { ...doc, validation: 'Valid' } }), false); assert.equal(api.canChecklistAction({ ...user, role: 'admin' }, { ...remove, document: { ...doc, validation: 'Valid' } }), true);
  for (const action of [{ type: 'create', title: ' ' }, { type: 'create', title: 'x'.repeat(256) }, { ...remove, index: 8 }, { type: 'readiness', ready: 'Other', remarks: null, version: 'b'.repeat(64) }]) assert.throws(() => api.checklistRequest(user, 2, action));
});
test('Narrow authenticated requests never send a document collection; readiness clears irrelevant remarks', async () => {
  const requests = []; const api = adapter(async (url, options) => { requests.push({ url, method: options.method, body: JSON.parse(options.body) }); assert.equal(options.headers.Authorization, 'Bearer synthetic'); return { ok: true }; });
  await api.saveChecklistAction('synthetic', user, 2, { type: 'create', title: ' QA Extra ' }); await api.saveChecklistAction('synthetic', user, 2, { type: 'readiness', ready: 'Yes', remarks: 'Clear', version: 'b'.repeat(64) }); await api.saveChecklistAction('synthetic', user, 2, remove);
  assert.deepEqual(requests[0].body, { title: 'QA Extra' }); assert.equal(requests[0].url.endsWith('/documents/manual'), true); assert.equal(requests[1].body.remarks, null); assert.equal(requests[2].method, 'DELETE'); assert.deepEqual(requests[2].body, { kind: 'indexed', index: 0, review_version: doc.review_version });
  assert.equal(requests.every(request => !Object.hasOwn(request.body, 'documents')), true);
});
test('Uncertain/conflict responses block retries and explicit server rejections remain distinct', async () => {
  for (const status of [null, 409, 500, 403, 422]) { let calls = 0; const api = adapter(async () => { calls++; if (status === null) throw Error('lost'); return { ok: false, status }; }); await assert.rejects(api.saveChecklistAction('synthetic', user, 2, remove), error => (error instanceof api.UnconfirmedChecklistActionError) === [null, 409, 500].includes(status)); assert.equal(calls, 1); }
});
for (const scenario of ['create', 'readiness', 'remove', 'agent-create', 'view-only', 'uncertain', 'permission-loss', 'cached-error']) test(`Checklist tools ${scenario} confirm changes and enforce session/state controls`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let auth = { token: 'synthetic', user: { ...user, ...(scenario === 'agent-create' ? { role: 'agent' } : {}), ...(scenario === 'view-only' ? { permissions: { transactions: 'view' } } : {}) } }, sends = 0, closes = 0, alerts = [], invalidations = [], sentAction; const textChanges = {};
  const query = { data: { documents: [doc], reco_audit_ready: null, reco_audit_remarks: null, reco_audit_version: 'b'.repeat(64) }, isFetching: false, isError: scenario === 'cached-error', error: Error('Synthetic rejection'), refetch: async () => {} };
  const primitive = ({ children }) => React.createElement('div', null, children), api = adapter(), exports = {};
  vm.runInNewContext(source('components/checklist-tools-sheet.tsx'), { exports, Error, AbortController, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, View: primitive, ActivityIndicator: primitive, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children), TextInput: ({ value, onChangeText, editable, accessibilityLabel }) => { textChanges[accessibilityLabel] = onChangeText; return React.createElement('input', { value, onChange: event => onChangeText(event.target.value), disabled: !editable, 'aria-label': accessibilityLabel }); } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name === '@tanstack/react-query') return { useQuery: () => query, useQueryClient: () => ({ invalidateQueries: async value => invalidations.push(value.queryKey) }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => auth };
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff', border: '#ddd', text: '#111' }) };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('transactions-api')) return { fetchTransactionDocuments() {} };
    if (name.includes('checklist-actions-api')) return { ...api, saveChecklistAction: async (token, principal, txn, action) => { sends++; sentAction = action; assert.equal(token, 'synthetic'); api.checklistRequest(principal, txn, action); if (scenario === 'uncertain') throw new api.UnconfirmedChecklistActionError('Unconfirmed checklist change.'); } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root')); const render = () => root.render(React.createElement(exports.ChecklistToolsSheet, { transactionId: 2, onClose: () => closes++ })); const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  try {
    await React.act(async () => render());
    if (scenario === 'view-only' || scenario === 'cached-error') { assert.equal(document.querySelector('[aria-label="Confirm document creation"]'), null); assert.equal(document.querySelector('[aria-label="Confirm RECO readiness"]'), null); assert.equal(document.querySelector('[aria-label="Remove file Primary.pdf"]'), null); assert.equal(sends, 0); }
    else {
      if (scenario === 'create' || scenario === 'agent-create') {
        if (scenario === 'agent-create') { assert.equal(document.querySelector('[aria-label="Confirm RECO readiness"]'), null); assert.equal(document.querySelector('[aria-label="Remove file Primary.pdf"]'), null); }
        assert.ok(document.querySelector('[aria-label="New document title"]'));
        await React.act(async () => textChanges['New document title']('QA Extra'));
        await React.act(async () => document.querySelector('[aria-label="Confirm document creation"]').click());
      } else if (scenario === 'readiness') { await React.act(async () => document.querySelector('[aria-label="RECO readiness: No"]').click()); await React.act(async () => document.querySelector('[aria-label="Confirm RECO readiness"]').click()); }
      else await React.act(async () => document.querySelector('[aria-label="Remove file Primary.pdf"]').click());
      assert.equal(sends, 0); assert.equal(alerts.length, 1); assert.equal(alerts[0][2][0].text, 'Cancel'); assert.equal(alerts[0][2][0].onPress, undefined);
      if (scenario === 'permission-loss') { auth = { ...auth, user: { ...user, permissions: { transactions: 'view' } } }; await React.act(async () => render()); }
      await React.act(async () => alerts[0][2][1].onPress()); await settle();
      if (scenario === 'permission-loss') assert.equal(sends, 0);
      else if (scenario === 'uncertain') { assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(document.querySelector('[aria-label="Remove file Primary.pdf"]').disabled, true); await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1); }
      else { assert.equal(sends, 1); assert.equal(closes, 1); assert.equal(invalidations.length, 3); assert.equal(sentAction.type, scenario === 'agent-create' ? 'create' : scenario); }
    }
    await React.act(async () => root.unmount());
  } finally { global.window = oldWindow; global.document = oldDocument; dom.window.close(); }
});
