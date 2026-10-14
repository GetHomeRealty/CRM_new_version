const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client'), query = require('@tanstack/react-query');

test('Campaign tools require explicit preview, recover errors, invalidate old counts and abort on exit', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let setText, fail = true, pending = false, signal, resolve, closed = false;
  let templateFailure = '';
  let grant = 'edit';
  let templatePending = false, templateSignal, resolveTemplate;
  const previews = [];
  const submittedFilters = [];
  const primitive = ({ children }) => React.createElement('div', null, children);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/campaign-tools-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, AbortController, Error, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return query;
      if (name === 'react-native') return { View: primitive, Modal: primitive, ActivityIndicator: primitive, StyleSheet: { create: v => v },
        TextInput: ({ value, onChangeText, editable }) => { setText = onChangeText; return React.createElement('input', { value, readOnly: true, disabled: !editable }); },
        Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children),
        FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }) => React.createElement('div', null, ListHeaderComponent, data.length ? data.map(item => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))) : ListEmptyComponent) };
      if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('template-metadata-editor')) return { TemplateMetadataEditor: primitive };
      if (name.includes('campaign-review-sheet')) return { CampaignReviewSheet: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'], permissions: { campaigns: grant } } }) };
      if (name.includes('template-text')) {
        const helper = {};
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/campaigns/template-text.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: helper });
        return helper;
      }
      if (name.includes('campaign-preview-api')) return {
        fetchAudienceOptions: async () => ({ leadStatus: ['hot'], leadType: ['buyer'], leadSource: ['website'], clientType: ['Move-up Buyer'] }),
        fetchCampaignTemplates: async (_token, passedSignal) => {
          templateSignal = passedSignal;
          if (templatePending) return new Promise(resolve => { resolveTemplate = resolve; });
          if (templateFailure) throw Error(templateFailure);
          return [{ id: 1, name: 'Synthetic template', subject: '<img src="invalid">', category: 'custom', is_active: false, attachment_count: 2, attachments: [{ id: 1, filename: '<img>.pdf', content_type: 'application/pdf', size: 512 }, { id: 2, filename: 'empty.txt', content_type: 'text/plain', size: 0 }], content: '<p>Hello {{first_name}}</p><img src="https://example.invalid/tracker"><script>bad()</script>' }];
        },
        previewCampaignAudience: async (token, tag, passedSignal, filters) => {
          submittedFilters.push(JSON.parse(JSON.stringify(filters)));
          assert.equal(token, 'synthetic'); previews.push(tag); signal = passedSignal;
          if (pending) return new Promise(r => { resolve = r; });
          if (fail) throw Error('Synthetic preview failure'); return { count: tag ? 0 : 1, sample: [] };
        },
      };
      throw Error(name);
    },
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root')); let mounted = true;
  const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const find = label => [...document.querySelectorAll('button')].find(b => b.textContent === label);
  const click = async label => { assert.ok(find(label)); await React.act(async () => find(label).click()); await settle(); };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(exports.CampaignToolsSheet, { onClose: () => { closed = true; } })))); await settle();
    assert.match(document.body.textContent, /Create template/);
    grant = 'view';
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(exports.CampaignToolsSheet, { onClose: () => { closed = true; } }))));
    assert.doesNotMatch(document.body.textContent, /Create template|Edit name and subject|Edit email body|Review campaign with this template/);
    assert.match(document.body.textContent, /View text preview/);
    grant = 'edit';
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(exports.CampaignToolsSheet, { onClose: () => { closed = true; } }))));
    assert.equal(previews.length, 0); assert.match(document.body.textContent, /Synthetic template/); assert.match(document.body.textContent, /Inactive.*2 attachments/);
    assert.equal(document.querySelector('img'), null);
    assert.doesNotMatch(document.body.textContent, /Hello/);
    await click('View text preview'); assert.match(document.body.textContent, /Hello \{\{first_name\}\}/);
    assert.equal(document.querySelector('img, script, iframe'), null); assert.doesNotMatch(document.body.textContent, /bad\(\)/);
    assert.match(document.body.textContent, /<img>\.pdf/); assert.match(document.body.textContent, /512 bytes/); assert.match(document.body.textContent, /0 bytes/);
    assert.equal(document.querySelector('a'), null);
    for (const message of ['You do not have access to campaign tools.', 'Could not connect to the server. Check your connection and retry.']) {
      templateFailure = message;
      await click('Refresh templates');
      assert.ok(document.body.textContent.includes(message));
      assert.doesNotMatch(document.body.textContent, /Synthetic template|Hello|empty\.txt|512 bytes/);
      assert.doesNotMatch(document.body.textContent, /No templates found/);
      assert.ok(client.getQueryData(['campaign-templates']), 'Keep cached data in this test to prove the UI hides it');
      templateFailure = '';
      await click('Refresh templates');
      assert.match(document.body.textContent, /Synthetic template/);
      assert.match(document.body.textContent, /Hello/);
      assert.match(document.body.textContent, /empty\.txt/);
      assert.ok(!document.body.textContent.includes(message));
      assert.equal(previews.length, 0);
    }
    await click('Hide text preview'); assert.doesNotMatch(document.body.textContent, /Hello/); assert.equal(previews.length, 0);
    assert.doesNotMatch(document.body.textContent, /empty\.txt/);
    for (const [label, value] of [['Status', 'hot'], ['Type', 'buyer'], ['Source', 'website'], ['Client type', 'Move-up Buyer']]) {
      await click(`${label}: Any`); await click(value);
    }
    assert.equal(previews.length, 0);
    await click('Preview audience count'); assert.match(document.body.textContent, /Synthetic preview failure/); assert.equal(find('Preview audience count').disabled, false);
    assert.deepEqual(submittedFilters[0], { leadStatus: 'hot', leadType: 'buyer', leadSource: 'website', clientType: 'Move-up Buyer' });
    fail = false; await click('Preview audience count'); assert.match(document.body.textContent, /1 eligible recipients/);
    await React.act(async () => setText('NO-MATCH')); assert.doesNotMatch(document.body.textContent, /eligible recipients/); assert.equal(previews.length, 2);
    await click('Preview audience count'); assert.equal(previews.at(-1), 'NO-MATCH'); assert.match(document.body.textContent, /0 eligible recipients/);
    pending = true; await click('Preview audience count'); assert.equal(find('Preview audience count').disabled, true); assert.equal(document.querySelector('input').disabled, true);
    await click('Preview audience count'); assert.equal(previews.length, 4);
    templatePending = true;
    const cachedTemplates = client.getQueryData(['campaign-templates']);
    await click('Refresh templates'); assert.equal(templateSignal.aborted, false);
    await click('Back'); assert.equal(closed, true);
    await React.act(async () => root.unmount()); mounted = false; assert.equal(signal.aborted, true);
    assert.equal(templateSignal.aborted, true);
    await React.act(async () => resolve({ count: 99, sample: [] }));
    await React.act(async () => resolveTemplate([{ id: 99, name: 'Late response must not replace cached templates' }]));
    assert.equal(client.getQueryData(['campaign-templates']), cachedTemplates);
    assert.equal(document.getElementById('root').textContent, '');
  } finally {
    if (mounted) await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = previous.window; global.document = previous.document; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
