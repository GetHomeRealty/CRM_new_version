const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');

for (const scenario of ['success', 'failure', 'cancel']) test(`Document screen ${scenario} uses isolated downloads and cleanup`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let signal, resolveDownload, downloads = 0, shares = 0, disposals = 0, mounted = true;
  const primitive = ({ children }) => React.createElement('div', null, children);
  const exports = {};
  const transpile = (file) => ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(transpile('../src/components/document-files-sheet.tsx'), { exports, AbortController, Error, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ActivityIndicator: primitive, ScrollView: primitive, View: primitive,
      Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value, hairlineWidth: 1 },
      Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic' }) };
    if (name === 'expo-sharing') return { isAvailableAsync: async () => true, shareAsync: async (uri) => { assert.equal(uri, 'file:///synthetic.pdf'); shares++; } };
    if (name.includes('document-files')) { const api = {}; vm.runInNewContext(transpile('../src/transactions/document-files.ts'), { exports: api }); return api; }
    if (name.includes('document-download')) return { downloadDocument: async (token, attachment, passedSignal) => {
      assert.equal(token, 'synthetic'); assert.equal(attachment.path, '/api/documents/9/file');
      downloads++; signal = passedSignal;
      if (scenario === 'failure') throw Error('Synthetic download failure');
      const result = { uri: 'file:///synthetic.pdf', dispose: () => { disposals++; } };
      if (scenario === 'cancel') return new Promise((resolve) => { resolveDownload = () => resolve(result); });
      return result;
    } };
    throw Error(`Unexpected import ${name}`);
  } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  try {
    await React.act(async () => root.render(React.createElement(exports.DocumentFilesSheet, {
      document: { id: 9, title: 'Synthetic offer', has_file: true, file_name: 'Offer.pdf' }, onClose() {},
    })));
    assert.equal(downloads, 0); assert.equal(shares, 0);
    const button = document.querySelector('[aria-label="Open or save Offer.pdf"]');
    await React.act(async () => button.click()); await settle();
    assert.equal(downloads, 1);
    if (scenario === 'failure') {
      assert.ok(document.body.textContent.includes('Synthetic download failure'));
      assert.equal(button.disabled, false); assert.equal(shares, 0);
    } else if (scenario === 'success') {
      assert.equal(shares, 1); assert.equal(disposals, 0);
    } else {
      assert.equal(button.disabled, true);
    }
    await React.act(async () => root.unmount()); mounted = false;
    if (scenario === 'cancel') {
      assert.equal(signal.aborted, true);
      await React.act(async () => resolveDownload()); await settle();
      assert.equal(shares, 0);
    }
    assert.equal(disposals, scenario === 'failure' ? 0 : 1);
  } finally {
    if (mounted) await React.act(async () => root.unmount()); dom.window.close();
    global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
