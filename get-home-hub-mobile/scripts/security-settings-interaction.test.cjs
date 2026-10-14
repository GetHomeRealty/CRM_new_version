const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client');
test('Security screen opens browser controls and hides stale status after a failed refresh', async () => {
  const dom = new JSDOM('<div id="root"></div>'), old = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const api = {}, opened = []; let failed = false, foreground, removed = false;
  const primitive = ({ children }) => React.createElement('div', null, children);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/security-settings-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive,
        AppState: { addEventListener: (_, callback) => { foreground = callback; return { remove: () => { removed = true; } }; } },
        Linking: { openURL: async url => { opened.push(url); } },
        Pressable: ({ children, disabled, onPress }) => React.createElement('button', { disabled, onClick: onPress }, children) };
      if (name.includes('safe-area')) return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { email: 'test@example.invalid', modules: ['crm'] } }) };
      if (name.includes('access-policy')) return { hasModule: (user, area) => user.modules.includes(area) };
      if (name.includes('security-api')) return { securityPageUrl: (area, target) => `https://crm.example.invalid/${area}/${target}`, fetchSecurityStatus: async () => { if (failed) throw Error('offline'); return { enabled: true, methods: ['totp'], recoveryCodesRemaining: 8, trustedDeviceCount: 1, obligation: 'none' }; } };
      throw Error(name);
    },
  });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(api.SecuritySettingsSheet, { onClose() {} })));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.match(document.body.textContent, /Two-step verification: Enabled/);
    const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label);
    await React.act(async () => button('Open CRM password controls').click());
    assert.equal(opened.length, 1); assert.match(document.body.textContent, /does not change your security settings/);
    assert.equal(document.querySelectorAll('input').length, 0);
    failed = true; await React.act(async () => foreground('active'));
    assert.doesNotMatch(document.body.textContent, /Two-step verification: Enabled/);
    assert.match(document.body.textContent, /No security changes were made/);
  } finally { await React.act(async () => root.unmount()); assert.equal(removed, true); dom.window.close(); Object.assign(global, old); }
});
