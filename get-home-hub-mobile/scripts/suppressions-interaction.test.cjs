const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');

test('Suppression screen paginates, hides denied cached records and stays read-only', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let allowed = true, fail = false, closed = false; const calls = [];
  const primitive = ({ children }) => React.createElement('div', null, children);
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/campaign-suppressions-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return query;
      if (name === 'react-native') return { View: primitive, Modal: primitive, ActivityIndicator: primitive, StyleSheet: { create: x => x },
        Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children),
        FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }) => React.createElement('div', null, ListHeaderComponent, data.length ? data.map(item => React.createElement('div', { key: item.id }, renderItem({ item }))) : ListEmptyComponent) };
      if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff' }) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1, modules: ['crm'], permissions: { campaigns: allowed ? 'view' : 'none' } } }) };
      if (name.includes('campaigns-api')) return { fetchSuppressions: async (token, page, signal) => {
        assert.equal(token, 'synthetic'); assert.ok(signal); calls.push(page);
        if (fail) throw Error('Access denied');
        return { data: [{ id: page, email: `page${page}@example.invalid`, reason: 'unsubscribe', updated_at: null }], meta: { page, per_page: 50, total: 51, last_page: 2 } };
      } };
      throw Error(name);
    },
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const render = () => React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(api.CampaignSuppressionsSheet, { onClose: () => { closed = true; } }))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
  const click = async text => { assert.ok(button(text)); await React.act(async () => button(text).click()); await settle(); };
  try {
    await render(); await settle();
    assert.match(document.body.textContent, /page1@example.invalid/);
    assert.equal(button('Previous page').disabled, true);
    await click('Next page'); assert.match(document.body.textContent, /page2@example.invalid/);
    assert.equal(button('Next page').disabled, true);
    fail = true; await click('Refresh do-not-email list');
    assert.match(document.body.textContent, /Access denied/); assert.doesNotMatch(document.body.textContent, /page2@example.invalid/);
    fail = false; await click('Refresh do-not-email list');
    allowed = false; await render();
    assert.doesNotMatch(document.body.textContent, /page2@example.invalid/);
    assert.match(document.body.textContent, /do not have access/);
    assert.equal(button('Refresh do-not-email list'), undefined);
    await click('Back to campaigns'); assert.equal(closed, true);
    assert.deepEqual(calls, [1, 2, 2, 2]);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = previous.window; global.document = previous.document; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
