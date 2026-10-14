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
const policy = {}, upload = {}, files = {};
vm.runInNewContext(source('auth/access-policy.ts'), { exports: policy });
vm.runInNewContext(source('transactions/document-upload.ts'), { exports: upload, Error, require: () => ({ environment: { apiUrl: 'http://127.0.0.1:8000' } }) });
vm.runInNewContext(source('transactions/document-files.ts'), { exports: files });
function adapter(fetch) {
  const exports = {};
  class Form { constructor() { this.values = []; } append(...args) { this.values.push(args); } }
  vm.runInNewContext(source('transactions/validation-attachment-api.ts'), { exports, Error, FormData: Form, fetch, require: name => name.includes('access-policy') ? policy : name.includes('document-upload') ? upload : { environment: { apiUrl: 'http://127.0.0.1:8000' } } }); return exports;
}
const user = { role: 'documentation', modules: ['desk'], permissions: { transactions: 'edit' } };
const doc = { id: 9, title: 'Synthetic offer', status: 'Received', validation: 'Invalid', review_version: 'a'.repeat(64), has_validation_file: true, validation_file_name: 'Reason.pdf', remarks: 'Replace page two.' };
const file = { uri: 'file:///synthetic-review.pdf', name: 'Review.pdf', size: 4, mimeType: 'application/pdf' };
test('Attachment adapter requires reviewer edit/module, Invalid document and snapshot; enforces file limits', async () => {
  let calls = 0; const api = adapter(async () => { calls++; return { ok: true }; });
  for (const value of [{ ...user, role: 'agent' }, { ...user, modules: [] }, { ...user, permissions: { transactions: 'view' } }, { ...user, role: 'unknown' }]) await assert.rejects(api.changeValidationAttachment('synthetic', value, 2, doc, file));
  for (const value of [{ ...doc, validation: 'Valid' }, { ...doc, review_version: undefined }, { ...doc, id: -1 }]) await assert.rejects(api.changeValidationAttachment('synthetic', user, 2, value, file));
  await assert.rejects(api.changeValidationAttachment('synthetic', user, 2, doc, { ...file, size: 20 * 1024 * 1024 + 1 })); assert.equal(calls, 0);
});
test('Versioned upload and removal make one scoped authenticated multipart/JSON request', async () => {
  let calls = 0; const api = adapter(async (url, options) => { calls++; assert.equal(url, 'http://127.0.0.1:8000/api/transactions/2/documents/9/validation-attachment'); assert.equal(options.headers.Authorization, 'Bearer synthetic');
    if (options.method === 'POST') { assert.equal(options.headers['Content-Type'], undefined); assert.equal(options.body.values[0][1], doc.review_version); assert.equal(options.body.values[1][1].uri, file.uri); }
    else { assert.equal(options.method, 'DELETE'); assert.deepEqual(JSON.parse(options.body), { review_version: doc.review_version }); } return { ok: true }; });
  await api.changeValidationAttachment('synthetic', user, 2, doc, file); await api.changeValidationAttachment('synthetic', user, 2, doc, null); assert.equal(calls, 2);
});
test('Lost responses/conflicts/5xx require refresh without retry; explicit rejections differ', async () => {
  for (const status of [null, 409, 500, 403, 413, 422]) { let calls = 0; const api = adapter(async () => { calls++; if (status === null) throw Error('lost'); return { ok: false, status }; });
    await assert.rejects(api.changeValidationAttachment('synthetic', user, 2, doc, null), error => (error instanceof api.UnconfirmedValidationAttachmentError) === [null, 409, 500].includes(status)); assert.equal(calls, 1);
  }
});
for (const scenario of ['upload', 'remove', 'uncertain', 'agent-share', 'oversized', 'picker-cancel', 'permission-loss', 'logout-download']) test(`Validation attachment screen ${scenario} protects files and user intent`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let auth = { token: 'synthetic', user: { ...user, ...(scenario === 'agent-share' ? { role: 'agent' } : {}) } }, sends = 0, closes = 0, deletes = 0, shares = 0, disposals = 0, downloadSignal, resolveDownload, alerts = [], invalidations = [];
  const primitive = ({ children }) => React.createElement('div', null, children), api = adapter(), exports = {};
  vm.runInNewContext(source('components/validation-attachment-sheet.tsx'), { exports, Error, AbortController, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name === 'expo-file-system') return { File: class { size = scenario === 'oversized' ? 20 * 1024 * 1024 + 1 : 4; delete() { deletes++; } } };
    if (name === 'expo-document-picker') return { getDocumentAsync: async () => scenario === 'picker-cancel' ? { canceled: true } : { canceled: false, assets: [file] } };
    if (name === 'expo-sharing') return { isAvailableAsync: async () => true, shareAsync: async uri => { assert.equal(uri, 'file:///downloaded-reason.pdf'); shares++; } };
    if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries: async value => invalidations.push(value.queryKey) }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => auth };
    if (name.includes('access-policy')) return policy;
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff' }) };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('validation-attachment-api')) return { ...api, changeValidationAttachment: async (token, principal, txn, document, chosen) => { sends++; assert.equal(token, 'synthetic'); assert.equal(txn, 2); assert.equal(api.canEditValidationAttachment(principal, document), true); if (scenario === 'remove' || scenario === 'uncertain') assert.equal(chosen, null); else assert.equal(chosen.name, 'Review.pdf'); if (scenario === 'uncertain') throw new api.UnconfirmedValidationAttachmentError('Unconfirmed attachment change.'); } };
    if (name.includes('document-upload')) return upload;
    if (name.includes('document-files')) return files;
    if (name.includes('document-download')) return { downloadDocument: async (token, attachment, signal) => { assert.equal(token, 'synthetic'); assert.equal(attachment.path, '/api/documents/9/validation-file'); downloadSignal = signal; const result = { uri: 'file:///downloaded-reason.pdf', dispose: () => disposals++ }; return scenario === 'logout-download' ? new Promise(resolve => { resolveDownload = () => resolve(result); }) : result; } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root')); const render = () => root.render(React.createElement(exports.ValidationAttachmentSheet, { transactionId: 2, document: doc, onClose: () => closes++ }));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  try {
    await React.act(async () => render());
    if (scenario === 'agent-share' || scenario === 'logout-download') {
      if (scenario === 'agent-share') { assert.equal(document.querySelector('[aria-label="Choose validation attachment"]'), null); assert.equal(document.querySelector('[aria-label="Confirm validation removal"]'), null); }
      await React.act(async () => document.querySelector('[aria-label="Open validation attachment"]').click()); await settle();
      if (scenario === 'logout-download') { auth = { token: null, user: null }; await React.act(async () => render()); assert.equal(downloadSignal.aborted, true); await React.act(async () => resolveDownload()); await settle(); assert.equal(shares, 0); assert.equal(disposals, 1); }
      else { assert.equal(shares, 1); assert.equal(disposals, 0); } assert.equal(sends, 0);
    } else {
      if (['upload', 'oversized', 'picker-cancel'].includes(scenario)) { await React.act(async () => document.querySelector('[aria-label="Choose validation attachment"]').click()); await settle(); }
      if (scenario === 'oversized' || scenario === 'picker-cancel') { assert.equal(document.querySelector('[aria-label="Confirm validation upload"]').disabled, true); assert.equal(sends, 0); assert.equal(deletes, scenario === 'oversized' ? 1 : 0); }
      else {
        await React.act(async () => document.querySelector(`[aria-label="${scenario === 'upload' ? 'Confirm validation upload' : 'Confirm validation removal'}"]`).click()); assert.equal(sends, 0); assert.equal(alerts[0][2][0].text, 'Cancel'); assert.equal(alerts[0][2][0].onPress, undefined);
        if (scenario === 'permission-loss') { auth = { ...auth, user: { ...user, permissions: { transactions: 'view' } } }; await React.act(async () => render()); }
        await React.act(async () => alerts[0][2][1].onPress()); await settle();
        if (scenario === 'permission-loss') { assert.equal(sends, 0); assert.equal(document.querySelector('[aria-label="Confirm validation removal"]'), null); }
        else if (scenario === 'uncertain') { assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(document.querySelector('[aria-label="Confirm validation removal"]').disabled, true); await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1); }
        else { assert.equal(sends, 1); assert.equal(closes, 1); assert.equal(invalidations.length, 1); if (scenario === 'upload') assert.equal(deletes, 1); }
      }
    }
    await React.act(async () => root.unmount()); if (scenario === 'agent-share') assert.equal(disposals, 1);
  } finally { global.window = oldWindow; global.document = oldDocument; dom.window.close(); }
});
