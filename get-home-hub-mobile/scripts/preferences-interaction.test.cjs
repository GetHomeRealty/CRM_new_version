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

test('Preference screen preserves failed drafts, respects channel readiness, and confirms discard', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let confirmation, closed = false, fail = true;
  const writes = [];
  const category = { key: 'lead_new', label: 'New leads', description: 'Synthetic preference',
    channels: { in_app: 'live', email: 'live', push: 'pending' }, enabled: { in_app: true, email: true, push: true } };
  const current = { channels: ['in_app', 'email', 'push'], categories: [category,
    { ...category, key: 'desk_only', label: 'Desk only', areas: ['desk'] }] };
  const primitive = ({ children }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children);
  const Switch = ({ value, onValueChange, disabled, accessibilityLabel }) => React.createElement('button', {
    role: 'switch', 'aria-checked': value, 'aria-label': accessibilityLabel, disabled, onClick: () => onValueChange(!value),
  });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/notification-preferences-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { Pressable, Switch, Modal: primitive, ActivityIndicator: primitive,
      ScrollView: primitive, View: primitive, Alert: { alert: (...args) => { confirmation = args; } },
      StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'] } }) };
    if (name.includes('preferences-api')) return {
      fetchNotificationPreferences: async () => current,
      saveNotificationPreferences: async (_token, _current, draft) => {
        writes.push(JSON.parse(JSON.stringify(draft)));
        if (fail) throw new Error('Synthetic save failure');
        return { ...current, categories: [{ ...category, enabled: { ...category.enabled, email: false } }] };
      },
    };
    throw new Error(`Unexpected import ${name}`);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const find = (label) => [...document.querySelectorAll('button')].find((el) => el.textContent === label || el.getAttribute('aria-label') === label);
  const click = async (label) => { assert.ok(find(label)); assert.equal(find(label).disabled, false);
    await React.act(async () => find(label).click()); await settle(); };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client },
      React.createElement(exports.NotificationPreferencesSheet, { onClose: () => { closed = true; } }))));
    await settle();
    assert.equal(find('Save preferences').disabled, true);
    assert.equal(find('New leads: Push').disabled, true);
    assert.equal(document.body.textContent.includes('Desk only'), false);
    await click('New leads: Email');
    assert.equal(writes.length, 0);
    await click('Save preferences');
    assert.ok(document.body.textContent.includes('Synthetic save failure'));
    assert.equal(find('New leads: Email').getAttribute('aria-checked'), 'false');
    await click('Back'); assert.equal(closed, false);
    assert.equal(confirmation[2][0].style, 'cancel');
    fail = false; await click('Save preferences');
    assert.ok(document.body.textContent.includes('Preferences saved.'));
    assert.equal(find('Save preferences').disabled, true);
    assert.equal(writes[1].lead_new.email, false);
    await click('New leads: In-app'); await click('Back');
    await React.act(async () => confirmation[2][1].onPress()); assert.equal(closed, true);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
