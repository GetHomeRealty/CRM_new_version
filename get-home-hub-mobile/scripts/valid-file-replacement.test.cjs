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
function adapter(fetch) {
  const exports = {};
  class Form { constructor() { this.values = []; } append(...args) { this.values.push(args); } }
  vm.runInNewContext(source('transactions/valid-file-replacement-api.ts'), { exports, Error, FormData: Form, fetch, require: name => name.includes('access-policy') ? policy : name.includes('document-upload') ? upload : { environment: { apiUrl: 'http://127.0.0.1:8000' } } });
  return exports;
}
const policy = {}; vm.runInNewContext(source('auth/access-policy.ts'), { exports: policy });
const upload = {}; vm.runInNewContext(source('transactions/document-upload.ts'), { exports: upload, require: () => ({ environment: { apiUrl: 'http://127.0.0.1:8000' } }) });
const doc = { id: 9, title: 'Synthetic Valid offer', validation: 'Valid', has_file: true, file_name: 'Old.pdf', files: [], review_version: 'a'.repeat(64) };
const file = { uri: 'file:///synthetic.pdf', name: 'New.pdf', size: 4, mimeType: 'application/pdf' };
const principal = { role: 'admin', modules: ['desk'], permissions: { transactions: 'edit' } };
test('Replacement policy, target validation and multipart include snapshot and exact selection', async () => {
  let calls = 0; const api = adapter(async (url, options) => { calls++; assert.equal(url.endsWith('/documents/9/valid-file-replacement'), true); assert.equal(options.headers['Content-Type'], undefined); assert.equal(options.body.values[0][1], 'primary'); assert.equal(options.body.values[1][1], doc.review_version); return { ok: true }; });
  for (const role of ['manager', 'documentation', 'agent']) assert.equal(api.canReplaceValidFile({ ...principal, role }, doc), false);
  assert.throws(() => api.validateReplacementTarget(doc, { kind: 'indexed', index: 8 }));
  await api.replaceValidFile('synthetic', principal, 2, doc, { kind: 'primary', label: 'Old.pdf' }, file); assert.equal(calls, 1);
});
test('Replacement conflicts/lost response/5xx lock uncertainty without automatic retry', async () => {
  for (const status of [null, 409, 500, 403, 422]) { let calls = 0; const api = adapter(async () => { calls++; if (status === null) throw Error('lost'); return { ok: false, status }; }); await assert.rejects(api.replaceValidFile('synthetic', principal, 2, doc, { kind: 'primary', label: 'Old.pdf' }, file), error => (error instanceof api.UnconfirmedValidReplacementError) === [null, 409, 500].includes(status)); assert.equal(calls, 1); }
});
for (const scenario of ['confirm-success', 'uncertain', 'permission-loss', 'picker-cancel']) test(`Upload interaction ${scenario} enforces confirmation and session boundaries`, async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const primitive = ({ children }) => React.createElement('div', null, children);
  let auth = { token: 'synthetic', user: principal }, sends = 0, deletes = 0, closes = 0, alerts = [], invalidations = [], resolvePicker;
  const api = adapter();
  const exports = {};
  vm.runInNewContext(source('components/valid-file-replacement-sheet.tsx'), { exports, AbortController, Error, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, View: primitive, Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name === 'expo-file-system') return { File: class { size = 4; delete() { deletes++; } } };
    if (name === 'expo-document-picker') return { getDocumentAsync: async () => scenario === 'permission-loss' ? new Promise(resolve => { resolvePicker = resolve; }) : scenario === 'picker-cancel' ? { canceled: true } : { canceled: false, assets: [file] } };
    if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries: async value => invalidations.push(value.queryKey) }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => auth };
    if (name.includes('access-policy')) return policy;
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff' }) };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('document-upload')) return upload;
    if (name.includes('valid-file-replacement-api')) return { ...api, replaceValidFile: async () => { sends++; if (scenario === 'uncertain') throw new api.UnconfirmedValidReplacementError('Upload could not be confirmed.'); } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root'));
  const render = () => root.render(React.createElement(exports.ValidFileReplacementSheet, { transactionId: 2, document: doc, clients: [], onClose: () => { closes++; } }));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  try {
    await React.act(async () => render());
    await React.act(async () => document.querySelector('[aria-label="Replace target Old.pdf"]').click());
    await React.act(async () => document.querySelector('[aria-label="Choose replacement file"]').click()); await settle();
    if (scenario === 'permission-loss') {
      auth = { token: null, user: null }; await React.act(async () => render());
      await React.act(async () => resolvePicker({ canceled: false, assets: [file] })); await settle();
      assert.equal(document.body.textContent, ''); assert.equal(deletes, 1); assert.equal(sends, 0);
    } else if (scenario === 'picker-cancel') {
      assert.equal(document.querySelector('[aria-label="Confirm Valid file replacement"]').disabled, true); assert.equal(sends, 0); assert.equal(deletes, 0);
    } else {
      await React.act(async () => document.querySelector('[aria-label="Confirm Valid file replacement"]').click());
      assert.equal(sends, 0); assert.equal(alerts[0][2][0].text, 'Cancel'); assert.ok(alerts[0][1].includes('Validation will reset to Pending')); assert.equal(alerts[0][2][0].onPress, undefined);
      await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1);
      if (scenario === 'uncertain') {
        assert.equal(document.querySelector('[aria-label="Confirm Valid file replacement"]').disabled, true);
        await React.act(async () => alerts[0][2][1].onPress()); await settle(); assert.equal(sends, 1); assert.equal(closes, 0);
      } else { assert.equal(closes, 1); assert.equal(deletes, 1); assert.equal(invalidations.length, 2); }
    }
    await React.act(async () => root.unmount());
    if (scenario === 'uncertain') assert.equal(deletes, 1);
  } finally { global.window = oldWindow; global.document = oldDocument; dom.window.close(); }
});
