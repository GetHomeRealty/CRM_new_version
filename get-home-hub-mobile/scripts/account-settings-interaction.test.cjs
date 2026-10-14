const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');
test('Account screen loads personal data, confirms preference writes and blocks repeated submissions', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const old = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const api = {}, writes = []; let actions, finish;
  const primitive = ({ children }) => React.createElement('div', null, children);
  const profile = { name: 'Test Agent', username: 'test', phone: '', email: 'test@example.invalid', role: 'agent', status: 'Active' };
  const prefs = { signature: '', replyTemplate: '', forwardingAddress: '', autoSync: false, autoResponder: { enabled: false, message: '' } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/account-settings-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'react-native') return { View: primitive, Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive,
        Alert: { alert: (_title, _message, value) => { actions = value; } },
        Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children),
        TextInput: ({ value, onChangeText, accessibilityLabel }) => React.createElement('input', { value, 'aria-label': accessibilityLabel, onChange: event => onChangeText(event.target.value) }),
        Switch: ({ value, onValueChange, accessibilityLabel }) => React.createElement('button', { 'aria-label': accessibilityLabel, onClick: () => onValueChange(!value) }, String(value)) };
      if (name.includes('safe-area')) return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic' }) };
      if (name.includes('mailbox-editor')) return { MailboxEditor: primitive };
      if (name.includes('connect-mailbox-sheet')) return { ConnectMailboxSheet: primitive };
      if (name.includes('security-settings-sheet')) return { SecuritySettingsSheet: primitive };
      if (name.includes('account-api')) return { profileInput: value => value, preferencesInput: value => value, mailboxInput: value => value,
        accountRequest: async (_token, path, method = 'GET', body) => {
          if (method !== 'GET') { writes.push({ path, body }); await new Promise(resolve => { finish = resolve; }); return profile; }
          return path === 'profile' ? profile : path === 'settings' ? { emailSettings: prefs } : [];
        } };
      throw Error(name);
    },
  });
  const root = createRoot(document.getElementById('root'));
  const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label);
  try {
    await React.act(async () => root.render(React.createElement(api.AccountSettingsSheet, { onClose() {} })));
    assert.match(document.body.textContent, /test@example.invalid/);
    assert.match(document.body.textContent, /No connected mailboxes/);
    await React.act(async () => button('Save email preferences').click());
    assert.equal(writes.length, 0);
    await React.act(async () => { actions[1].onPress(); actions[1].onPress(); });
    assert.equal(writes.length, 1); assert.equal(writes[0].path, 'settings');
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].body)), { emailSettings: prefs });
    assert.equal(button('Save profile').disabled, true);
    await React.act(async () => finish());
    assert.match(document.body.textContent, /Email preferences saved/);
  } finally { if (finish) await React.act(async () => finish()); await React.act(async () => root.unmount()); dom.window.close(); Object.assign(global, old); }
});
