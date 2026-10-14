const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');

test('Sent navigation, pagination, errors, recovery, unavailable history and close', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previousWindow = global.window, previousDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = []; let fail = false, closed = false;
  const row = { id: '12345678-1234-4123-8123-123456789abc', subject: 'Synthetic sent mail', to_email: 'test@example.invalid', sent_at: '2026-10-05T00:00:00Z' };
  const primitive = ({ children }) => React.createElement('div', null, children);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/sent-mail-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { ActivityIndicator: primitive, Modal: primitive, ScrollView: primitive,
      Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive, SafeAreaProvider: primitive };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1 } }) };
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff' }) };
    if (name === './themed-text') return { ThemedText: primitive };
    if (name === './mail-attachments') return { MailAttachments: primitive };
    if (name.includes('mail-archive-api')) return {
      sentPage: async (_token, area, page) => { calls.push(['list', area, page]); if (fail) throw new Error('Synthetic offline'); return { data: page === 1 ? [row] : [], page, has_more: page === 1 }; },
      sentDetail: async (_token, area, id) => { calls.push(['detail', area, id]); return { ...row, body_text: null, content_available: false }; },
    };
    throw new Error(name);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  const click = async label => {
    const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes(label));
    assert.ok(button, label); assert.equal(button.disabled, false);
    await React.act(async () => button.click()); await settle();
  };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(exports.SentMailSheet, { area: 'crm', onClose: () => { closed = true; } }))));
    await settle();
    assert.ok(document.body.textContent.includes('not your provider’s entire Sent folder'));
    assert.equal(calls.filter(c => c[0] === 'detail').length, 0);
    await click('Synthetic sent mail');
    assert.ok(document.body.textContent.includes('Content was not archived'));
    await click('Back to sent list');
    await click('Next sent page');
    assert.ok(document.body.textContent.includes('No accepted Hub emails'));
    await click('Previous sent page');
    fail = true; await click('Refresh sent mail');
    assert.ok(document.body.textContent.includes('Synthetic offline'));
    assert.equal(document.body.textContent.includes('Synthetic sent mail'), false);
    fail = false; await click('Refresh sent mail');
    assert.ok(document.body.textContent.includes('Synthetic sent mail'));
    await click('Close sent mail'); assert.equal(closed, true);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = previousWindow; global.document = previousDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
