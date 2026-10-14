const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');

test('Deleted leads screen searches, paginates, confirms restore and refreshes safely', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let grant = 'edit', restored = false, actions, inputChange, finishRestore, closed = false;
  const calls = []; let writes = 0;
  const primitive = ({ children }) => React.createElement('div', null, children);
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/deleted-leads-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return query;
      if (name === 'react-native') return { View: primitive, Modal: primitive, ActivityIndicator: primitive,
        Alert: { alert: (_title, _message, value) => { actions = value; } },
        TextInput: ({ value, onChangeText }) => { inputChange = onChangeText; return React.createElement('input', { value, readOnly: true }); },
        Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children),
        FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }) => React.createElement('div', null, ListHeaderComponent, data.length ? data.map(item => React.createElement('div', { key: item.id }, renderItem({ item }))) : ListEmptyComponent) };
      if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1, modules: ['crm'], permissions: { lead: grant } } }) };
      if (name.includes('deleted-leads-api')) return {
        fetchDeletedLeads: async (token, page, search, signal) => {
          assert.equal(token, 'synthetic'); assert.ok(signal); calls.push({ page, search });
          return { data: restored ? [] : [{ id: page, name: search || `Lead page ${page}`, email: null, deleted_at: null }], meta: { page, per_page: 50, total: restored ? 0 : 51, last_page: restored ? 1 : 2 } };
        },
        restoreDeletedLead: async (token, id) => {
          assert.equal(token, 'synthetic'); assert.equal(id, 1); writes++;
          await new Promise(resolve => { finishRestore = resolve; }); restored = true;
        },
      };
      throw Error(name);
    },
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['leads'], { synthetic: true });
  const root = createRoot(document.getElementById('root'));
  const render = () => React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(api.DeletedLeadsSheet, { onClose: () => { closed = true; } }))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
  const click = async text => { assert.ok(button(text)); await React.act(async () => button(text).click()); await settle(); };
  try {
    await render(); await settle();
    await click('Next page'); assert.match(document.body.textContent, /Lead page 2/);
    await React.act(async () => inputChange('  Synthetic recovery  '));
    await click('Search'); assert.deepEqual(calls.at(-1), { page: 1, search: 'Synthetic recovery' });
    assert.match(document.body.textContent, /Synthetic recovery/);
    grant = 'view'; await render(); assert.equal(button('Restore lead'), undefined);
    grant = 'edit'; await render(); await click('Restore lead'); assert.equal(writes, 0);
    assert.equal(actions[0].text, 'Cancel');
    await React.act(async () => { actions[1].onPress(); actions[1].onPress(); });
    assert.equal(writes, 1); assert.equal(button('Back to leads').disabled, true);
    await React.act(async () => finishRestore()); await settle();
    assert.match(document.body.textContent, /Lead restored/); assert.match(document.body.textContent, /No deleted leads/);
    assert.equal(client.getQueryState(['leads']).isInvalidated, true);
    assert.equal(button('Restore lead'), undefined);
    await click('Back to leads'); assert.equal(closed, true);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = previous.window; global.document = previous.document; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
