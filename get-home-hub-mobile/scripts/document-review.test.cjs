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
function adapter(fetch) {
  const exports = {};
  vm.runInNewContext(source('transactions/document-review-api.ts'), { exports, Error, fetch, require: name => name.includes('access-policy') ? policy : { environment: { apiUrl: 'http://127.0.0.1:8000' } } }); return exports;
}
const user = { role: 'documentation', modules: ['desk'], permissions: { transactions: 'edit' } };
const doc = { id: 9, title: 'Synthetic offer', status: 'Received', validation: 'Pending', manual: true, is_condition: false, review_version: 'a'.repeat(64), remarks: null };
test('Review policy denies view-only/missing-module/unknown roles and restricts agent changes', () => {
  const api = adapter();
  for (const value of [{ ...user, modules: [] }, { ...user, permissions: { transactions: 'view' } }, { ...user, role: 'unknown' }]) assert.throws(() => api.reviewBody(value, doc, { validation: 'Invalid' }));
  assert.throws(() => api.reviewBody({ ...user, role: 'agent' }, doc, { validation: 'Valid' }));
  assert.throws(() => api.reviewBody({ ...user, role: 'agent' }, { ...doc, manual: false }, { agent_accepted: 'Accepted' }));
  assert.equal(api.reviewBody({ ...user, role: 'agent' }, doc, { agent_accepted: 'Accepted' }).agent_accepted, 'Accepted');
  for (const patch of [{ title: 'Changed' }, { validation: 'Other' }, { remarks: 'x'.repeat(5001) }, { reminder: 'true' }, {}]) assert.throws(() => api.reviewBody(user, doc, patch));
});
test('One authenticated PUT targets only the chosen document and includes its snapshot version', async () => {
  let calls = 0;
  const api = adapter(async (url, options) => { calls++; assert.equal(url, 'http://127.0.0.1:8000/api/transactions/2/documents/9/review'); assert.equal(options.method, 'PUT'); assert.equal(options.headers.Authorization, 'Bearer synthetic'); assert.deepEqual(JSON.parse(options.body), { review_version: doc.review_version, validation: 'Invalid' }); return { ok: true }; });
  await api.saveDocumentReview('synthetic', user, 2, doc, { validation: 'Invalid' }); assert.equal(calls, 1);
});
test('Conflicts, transport loss and 5xx require refresh and never auto-retry; rejected requests remain distinct', async () => {
  for (const status of [null, 409, 500, 403, 422]) { let calls = 0;
    const api = adapter(async () => { calls++; if (status === null) throw Error('lost'); return { ok: false, status }; });
    await assert.rejects(api.saveDocumentReview('synthetic', user, 2, doc, { validation: 'Invalid' }), error => (error instanceof api.RefreshDocumentReviewError) === [null, 409, 500].includes(status)); assert.equal(calls, 1);
  }
});
for (const scenario of ['success', 'uncertain', 'permission-loss', 'agent', 'view-only']) test(`Review screen ${scenario} uses guarded confirmation and role-specific controls`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let auth = { token: 'synthetic', user: { ...user, ...(scenario === 'agent' ? { role: 'agent' } : {}), ...(scenario === 'view-only' ? { permissions: { transactions: 'view' } } : {}) } }, sends = 0, closes = 0, alerts = [], invalidations = [];
  const primitive = ({ children }) => React.createElement('div', null, children), api = adapter(), exports = {};
  vm.runInNewContext(source('components/document-review-sheet.tsx'), { exports, Error, AbortController, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children), TextInput: ({ value, onChangeText, editable, accessibilityLabel }) => React.createElement('textarea', { value, onChange: event => onChangeText(event.target.value), disabled: !editable, 'aria-label': accessibilityLabel }) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries: async value => invalidations.push(value.queryKey) }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => auth };
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff', text: '#111', border: '#444' }) };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('document-review-api')) return { ...api, saveDocumentReview: async (token, principal, txn, document, patch) => { sends++; api.reviewBody(principal, document, patch); assert.equal(token, 'synthetic'); assert.equal(txn, 2); if (scenario === 'uncertain') throw new api.RefreshDocumentReviewError('Save could not be confirmed.'); } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root')); const render = () => root.render(React.createElement(exports.DocumentReviewSheet, { transactionId: 2, document: doc, onClose: () => closes++ }));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  try {
    await React.act(async () => render());
    if (scenario === 'view-only') { assert.equal(document.body.textContent, ''); assert.equal(sends, 0); }
    else {
      if (scenario === 'agent') { assert.equal(document.querySelector('[aria-label="Validation: Valid"]'), null); assert.equal(document.querySelector('textarea'), null); }
      await React.act(async () => document.querySelector(`[aria-label="${scenario === 'agent' ? 'Document acceptance: Not Accepted' : 'Validation: Invalid'}"]`).click());
      await React.act(async () => document.querySelector('[aria-label="Confirm document review"]').click()); assert.equal(sends, 0); assert.equal(alerts[0][2][0].text, 'Cancel'); assert.equal(alerts[0][2][0].onPress, undefined);
      if (scenario === 'permission-loss') { auth = { ...auth, user: { ...user, permissions: { transactions: 'view' } } }; await React.act(async () => render()); }
      await React.act(async () => alerts[0][2][1].onPress()); await settle();
      if (scenario === 'permission-loss') { assert.equal(sends, 0); assert.equal(document.body.textContent, ''); }
      else if (scenario === 'uncertain') { assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(document.querySelector('[aria-label="Confirm document review"]').disabled, true); await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1); }
      else { assert.equal(sends, 1); assert.equal(closes, 1); assert.equal(invalidations.length, 2); }
    }
    await React.act(async () => root.unmount());
  } finally { global.window = oldWindow; global.document = oldDocument; dom.window.close(); }
});
