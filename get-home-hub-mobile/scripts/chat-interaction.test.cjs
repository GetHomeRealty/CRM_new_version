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

test('Chat preserves failed drafts, sends selected mentions, disables pending actions and confirms discard', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  let inputProps, confirmation, fail = true, closed = false, complete;
  const calls = [];
  const primitive = ({ children }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled, accessibilityRole, accessibilityState }) => React.createElement('button',
    { onClick: onPress, disabled, role: accessibilityRole, 'aria-checked': accessibilityState?.checked }, children);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/transaction-chat-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { Pressable, Modal: primitive, ActivityIndicator: primitive,
      KeyboardAvoidingView: primitive, Platform: { OS: 'ios' }, ScrollView: primitive, View: primitive,
      TextInput: (props) => { inputProps = props; return React.createElement('textarea', { value: props.value, readOnly: true }); },
      Alert: { alert: (...args) => { confirmation = args; } }, StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic' }) };
    if (name.includes('messages-api')) return {
      fetchTransactionMessages: async (_token, id) => { assert.equal(id, 9); return []; },
      fetchMentionCandidates: async () => { calls.push(['candidates']); return [{ id: 2, name: 'Synthetic teammate' }]; },
      sendTransactionMessage: async (_token, id, body, mentions) => {
        calls.push(['send', id, body, [...mentions]]);
        if (fail) throw new Error('Synthetic send failure');
        return new Promise((resolve) => { complete = () => resolve([{ id: 1, author: 'Local', body, mine: true, mentions }]); });
      },
    };
    throw new Error(`Unexpected import ${name}`);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const find = (label) => [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  const click = async (label) => { assert.ok(find(label), label); assert.equal(find(label).disabled, false);
    await React.act(async () => find(label).click()); await settle(); };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client },
      React.createElement(exports.TransactionChatSheet, { transactionId: 9, onClose: () => { closed = true; } }))));
    await settle();
    assert.equal(calls.length, 0); assert.equal(find('Send message').disabled, true);
    await click('Mention people'); await click('Synthetic teammate');
    await React.act(async () => inputProps.onChangeText('Synthetic hello'));
    await click('Send message');
    assert.ok(document.body.textContent.includes('Synthetic send failure'));
    assert.equal(inputProps.value, 'Synthetic hello');
    assert.ok(find('✓ Synthetic teammate'));
    await click('Back'); assert.equal(closed, false); assert.equal(confirmation[2][0].style, 'cancel');
    fail = false; await click('Send message');
    assert.equal(find('Send message').disabled, true); assert.equal(find('Back').disabled, true);
    assert.equal(inputProps.editable, false);
    await React.act(async () => complete()); await settle();
    assert.equal(inputProps.value, ''); assert.ok(find('Synthetic teammate'));
    assert.ok(document.body.textContent.includes('Synthetic hello'));
    assert.deepEqual(calls.filter(([kind]) => kind === 'send').at(-1), ['send', 9, 'Synthetic hello', [2]]);
    await React.act(async () => inputProps.onChangeText('Unsent'));
    await click('Back'); await React.act(async () => confirmation[2][1].onPress()); assert.equal(closed, true);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
