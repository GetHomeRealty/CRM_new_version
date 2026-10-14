const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');
for (const scenario of ['delete', 'export', 'revoked']) test(`Selected lead screen ${scenario} requires selection and confirmation`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const old = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let grant = 'edit', actions, calls = 0, shares = 0;
  const primitive = ({ children }) => React.createElement('div', null, children); const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/lead-bulk-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return query;
      if (name === 'react-native') return { View: primitive, Modal: primitive, ActivityIndicator: primitive,
        Alert: { alert: (_title, _message, value) => { actions = value; } },
        Pressable: ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
        FlatList: ({ data, renderItem }) => React.createElement('div', null, data.map(item => React.createElement('div', { key: item.id }, renderItem({ item })))) };
      if (name.includes('safe-area')) return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1, modules: ['crm'], permissions: { lead: grant } } }) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('lead-bulk-api')) return { moveLeadsToDeleted: async (_token, ids) => { assert.deepEqual([...ids], [1]); calls++; return 0; }, exportSelectedLeads: async (_token, ids) => { assert.deepEqual([...ids], [1]); calls++; return { data: [{ Name: 'One' }] }; } };
      if (name.includes('lead-export-share')) return { shareLeadExport: async () => { shares++; } };
      throw Error(name);
    },
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const render = () => React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(api.LeadBulkSheet, { leads: [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }], onClose() {} }))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const button = name => [...document.querySelectorAll('button')].find(el => el.textContent === name || el.getAttribute('aria-label') === name);
  const click = async name => { assert.ok(button(name)); await React.act(async () => button(name).click()); await settle(); };
  try {
    await render(); assert.equal(button('Export selected').disabled, true);
    await click('Select One'); assert.match(document.body.textContent, /1 selected/);
    await click(scenario === 'export' ? 'Export selected' : 'Move selected to deleted'); assert.equal(calls, 0);
    if (scenario === 'revoked') { grant = 'none'; await render(); }
    await React.act(async () => { actions[1].onPress(); actions[1].onPress(); }); await settle();
    assert.equal(calls, scenario === 'revoked' ? 0 : 1);
    if (scenario === 'delete') { assert.match(document.body.textContent, /0 of 1/); assert.equal(button('Move selected to deleted').disabled, true); }
    if (scenario === 'export') { assert.equal(shares, 1); assert.match(document.body.textContent, /Share sheet closed/); }
    if (scenario === 'revoked') assert.doesNotMatch(document.body.textContent, /Select One/);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close(); global.window = old.window; global.document = old.document; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
