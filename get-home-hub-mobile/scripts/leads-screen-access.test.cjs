const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('Leads screen denies cached data and disables both queries without view access', () => {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/leads.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const primitive = ({ children }) => React.createElement('div', null, children);
  for (const grant of ['view', 'none']) {
    const enabled = []; const api = {};
    vm.runInNewContext(source, { exports: api, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@tanstack/react-query') return { useQuery: options => {
        enabled.push(options.enabled);
        return { data: options.queryKey[0] === 'lead-options' ? { lead_status: ['Hot'] } : {
          data: [{ id: 1, name: 'Cached private lead' }], meta: { total: 1, current_page: 1, last_page: 1 },
        }, isPending: false, isError: false, isFetching: false };
      } };
      if (name === 'react-native') return { ActivityIndicator: primitive, Pressable: primitive, TextInput: primitive, View: primitive, StyleSheet: { create: x => x } };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'], permissions: { lead: grant } } }) };
      if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
      if (name.includes('mobile-screen')) return { MobileScreen: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('lead-detail-sheet')) return { LeadDetailSheet: () => React.createElement('span', null, 'Detail mounted') };
      if (name.includes('create-lead-sheet')) return { CreateLeadSheet: primitive };
      if (name.includes('deleted-leads-sheet')) return { DeletedLeadsSheet: primitive };
      if (name.includes('lead-import-sheet')) return { LeadImportSheet: primitive };
      if (name.includes('lead-bulk-sheet')) return { LeadBulkSheet: primitive };
      if (name.includes('record-list')) return { RecordList: ({ items }) => React.createElement('div', null, items.map(x => x.title).join(',')) };
      if (name.includes('constants/theme')) return { Spacing: {} };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('leads-api')) return {};
      throw Error(name);
    } });
    const html = renderToStaticMarkup(React.createElement(api.default));
    assert.deepEqual(enabled, [grant === 'view', grant === 'view']);
    if (grant === 'view') assert.match(html, /Cached private lead/);
    else { assert.match(html, /do not have access/); assert.doesNotMatch(html, /Cached private lead|Detail mounted|Hot/); }
  }
});
