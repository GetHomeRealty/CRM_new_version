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

for (const scenario of ['results', 'failure', 'empty', 'cancel', 'scheduled']) test(`Campaign screen ${scenario} preserves scoped interaction`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let fail = scenario === 'failure', closed = false, pendingSignal, mounted = true;
  const calls = [];
  let alertActions, cancellationCount = 0;
  const summary = { id: 7, name: 'Synthetic campaign', status: 'completed', stats: { total: 1, sent: 1, failed: 0, opened: 1, bounced: 0, unsubscribed: 0 } };
  const detail = { ...summary, subject: '<img src="https://example.invalid/pixel">', recipients: [{ id: 1, name: 'Synthetic recipient', email: 'qa@example.invalid', status: 'sent', opened: true, bounced: false, unsubscribed: false }] };
  if (scenario === 'scheduled') detail.status = 'scheduled';
  const transpile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const api = {};
  vm.runInNewContext(transpile('../src/campaigns/campaigns-api.ts'), { exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }), fetch: async (url, options) => {
    assert.equal(new URL(url).hostname, 'localhost'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer synthetic'); calls.push(url);
    if (scenario === 'cancel' && url.endsWith('/7')) {
      pendingSignal = options.signal;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
    }
    const status = fail ? 403 : 200;
    return { ok: status === 200, status, json: async () => url.endsWith('/7') ? detail : scenario === 'empty' ? [] : [summary] };
  } });
  const primitive = ({ children }) => React.createElement('div', null, children);
  const exports = {};
  vm.runInNewContext(transpile('../src/components/campaigns-sheet.tsx'), { exports, AbortController, Error, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { Alert: { alert: (_title, _message, actions) => { alertActions = actions; } }, View: primitive, Modal: primitive, ActivityIndicator: primitive, StyleSheet: { create: value => value },
      Pressable: ({ children, onPress, accessibilityLabel, disabled }) => React.createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
      FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }) => React.createElement('div', null, ListHeaderComponent, data.length ? data.map(item => React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item }))) : ListEmptyComponent) };
    if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ background: '#fff' }) };
    if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'], permissions: { campaigns: 'edit' } } }) };
    if (name.includes('campaigns-api')) return api;
    if (name.includes('campaign-write-api')) return { cancelScheduledCampaign: async (token, id) => { assert.equal(token, 'synthetic'); assert.equal(id, 7); cancellationCount++; detail.status = 'draft'; } };
    if (name.includes('delivery-summary')) { const helpers = {}; vm.runInNewContext(transpile('../src/campaigns/delivery-summary.ts'), { exports: helpers }); return helpers; }
    if (name.includes('campaign-tools-sheet')) return { CampaignToolsSheet: ({ onClose }) => React.createElement('button', { onClick: onClose }, 'Return from tools') };
    if (name.includes('campaign-suppressions-sheet')) return { CampaignSuppressionsSheet: ({ onClose }) => React.createElement('button', { onClick: onClose }, 'Return from suppressions') };
    throw Error(`Unexpected import ${name}`);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const click = async label => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
    assert.ok(el, label); await React.act(async () => el.click()); await settle();
  };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(exports.CampaignsSheet, { onClose: () => { closed = true; } }))));
    await settle(); assert.equal(calls.length, 1);
    if (scenario === 'results') {
      await click('Do-not-email list'); await click('Return from suppressions');
      await click('Templates and audience preview'); await click('Return from tools');
      assert.equal(calls.length, 2, 'Returning from creation tools refreshes the list');
    }
    if (scenario === 'empty') { assert.match(document.body.textContent, /No campaigns found/); await click('Close'); assert.equal(closed, true); return; }
    if (scenario === 'failure') {
      assert.match(document.body.textContent, /do not have access/); assert.doesNotMatch(document.body.textContent, /No campaigns found/);
      fail = false; await click('Refresh campaigns');
    }
    await click('View campaign Synthetic campaign');
    if (scenario === 'scheduled') {
      await click('Cancel scheduled campaign'); assert.equal(cancellationCount, 0); assert.equal(alertActions[0].text, 'Keep scheduled');
      await React.act(async () => { alertActions[1].onPress(); alertActions[1].onPress(); }); await settle();
      assert.equal(cancellationCount, 1); assert.match(document.body.textContent, /Cancellation confirmed/); assert.match(document.body.textContent, /Status: draft/);
      return;
    }
    if (scenario === 'cancel') {
      assert.ok(pendingSignal); await React.act(async () => root.unmount()); mounted = false; assert.equal(pendingSignal.aborted, true); return;
    }
    assert.match(document.body.textContent, /Synthetic recipient/); assert.match(document.body.textContent, /Open tracked/);
    assert.equal(document.querySelector('img'), null); // Subject is text; no HTML pixels are loaded.
    const count = calls.length; await click('Refresh campaigns'); assert.equal(calls.length, count + 1); assert.ok(calls.at(-1).endsWith('/7'));
    fail = true; await click('Refresh campaigns'); assert.match(document.body.textContent, /do not have access/);
    assert.doesNotMatch(document.body.textContent, /Synthetic recipient/); // Hide cached details on denied refresh.
    fail = false; await click('Refresh campaigns'); assert.match(document.body.textContent, /Synthetic recipient/);
    await click('Back to campaigns'); assert.equal(closed, false); assert.doesNotMatch(document.body.textContent, /Synthetic recipient/);
    await click('Close'); assert.equal(closed, true);
  } finally {
    if (mounted) await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
