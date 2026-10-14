const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');

for (const scenario of ['accepted', 'uncertain', 'revoked', 'read-only']) test(`CSV import screen: ${scenario}`, async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let grant = scenario === 'read-only' ? 'view' : 'edit', record = null, actions, submissions = 0, closed = false;
  const primitive = ({ children }) => React.createElement('div', null, children);
  const api = {};
  const job = { job_id: 'synthetic-job', status: 'Completed', total_rows: 1, processed_rows: 1, percent: 100, imported: 1, tagged: 0, duplicate: 0, invalid: 0, failure_reason: null, message: '1 imported', done: true };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/lead-import-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return query;
      if (name === 'react-native') return { View: primitive, Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive,
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Alert: { alert: (_title, _message, value) => { actions = value; } },
        TextInput: ({ value }) => React.createElement('input', { value, readOnly: true }),
        Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children) };
      if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1, modules: ['crm'], permissions: { lead: grant } } }) };
      if (name.includes('environment')) return { environment: { leadImportEnabled: true } };
      if (name.includes('lead-import-api')) return { validateImport() {}, fetchRecentLeadImports: async () => record?.state === 'confirmed' ? [job] : [] };
      if (name.includes('lead-import-file')) return { chooseImportCsv: async () => ({ name: 'synthetic.csv', csv: 'name,email\nTest,test@example.invalid' }) };
      if (name.includes('lead-import-guard')) return {
        readImportAttempt: async () => record,
        guardedImport: async () => { submissions++; record = { version: 1, state: 'pending', jobId: null }; if (scenario === 'uncertain') throw Error('Response lost'); record = { version: 1, state: 'confirmed', jobId: job.job_id }; return job; },
        acknowledgeImport: async () => { record = null; },
      };
      throw Error(name);
    },
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const render = () => React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(api.LeadImportSheet, { onClose: () => { closed = true; } }))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
  const click = async text => { assert.ok(button(text), text); await React.act(async () => button(text).click()); await settle(); };
  try {
    await render(); await settle(); assert.match(document.body.textContent, /No recent imports/);
    if (scenario === 'read-only') { assert.equal(button('Choose CSV file'), undefined); await click('Back to leads'); assert.equal(closed, true); return; }
    await click('Choose CSV file'); assert.match(document.body.textContent, /synthetic.csv/);
    await click('Review and import'); assert.equal(submissions, 0); assert.equal(actions[0].text, 'Cancel');
    if (scenario === 'revoked') { grant = 'none'; await render(); }
    await React.act(async () => { actions[1].onPress(); actions[1].onPress(); }); await settle();
    assert.equal(submissions, scenario === 'revoked' ? 0 : 1);
    if (scenario === 'accepted') {
      assert.match(document.body.textContent, /Import accepted/); assert.match(document.body.textContent, /1 imported/);
      await click('Acknowledge accepted import'); assert.ok(button('Choose CSV file')); assert.equal(record, null);
      await click('Back to leads'); assert.equal(closed, true);
    } else if (scenario === 'uncertain') {
      assert.match(document.body.textContent, /previous submission is unconfirmed/);
      assert.equal(button('Review and import'), undefined);
      await click('Refresh import history'); assert.equal(submissions, 1);
    } else assert.doesNotMatch(document.body.textContent, /synthetic.csv/);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = previous.window; global.document = previous.document; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
