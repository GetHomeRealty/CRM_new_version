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

test('Inbox interactions open only on tap, toggle read state, filter and paginate using synthetic transport', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  const alerts = [];
  let editReply;
  const item = { id: 7, from_email: 'lead@example.test', from_name: 'Test Lead', subject: 'Synthetic inquiry',
    snippet: 'Synthetic snippet', received_at: '2030-01-01T12:00:00Z', seen: false, lead_id: null, lead_name: null };
  const api = {
    fetchInboxReplyContext: async (_token, area, id) => {
      calls.push(['reply', area, id]);
      return { message_id: id, from: 'agent@example.test', to: 'lead@example.test', subject: 'Re: Synthetic inquiry', recipient_source: 'sender', sending_enabled: false };
    },
    fetchInbox: async (_token, area, options) => {
      calls.push(['list', area, options.page, options.unread]);
      return { data: options.unread && item.seen ? [] : [item], unread: item.seen ? 0 : 1,
        mailbox: { address: 'agent@example.test' }, meta: { page: options.page, last_page: 2 } };
    },
    openInboxMessage: async (_token, area, id) => {
      calls.push(['open', area, id]); item.seen = true;
      return { ...item, to_email: 'agent@example.test', body_text: 'Synthetic full body',
        body_html: '<img src="https://forbidden.example/tracker">' };
    },
    setInboxMessageSeen: async (_token, area, id, seen) => {
      calls.push(['seen', area, id, seen]); item.seen = seen; return { seen };
    },
  };
  const primitive = ({ children }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled, accessibilityLabel }) => React.createElement('button',
    { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/inbox-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, AbortController, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { Pressable, Modal: primitive, ActivityIndicator: primitive,
      KeyboardAvoidingView: primitive, Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) },
      TextInput: ({ value, onChangeText }) => { editReply = onChangeText; return React.createElement('textarea', { value, readOnly: true }); },
      ScrollView: primitive, View: primitive, StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive, SafeAreaProvider: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('reply-send-controls')) return { ReplySendControls: () => React.createElement('button', { disabled: true }, 'Sending unavailable') };
    if (name === './mail-attachments') return { MailAttachments: primitive };
    if (name === './sent-mail-sheet') return { SentMailSheet: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic-only' }) };
    if (name.includes('reply-attachments')) return { pickReplyAttachment: async () => ({ filename: 'test.txt', size: 4, data: 'dGVzdA==', content_type: 'text/plain' }) };
    if (name.includes('inbox-api')) return api;
    if (name.includes('message-body')) return require('./message-body-loader.cjs');
    throw new Error(`Unexpected import ${name}`);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  const click = async (label) => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label || el.getAttribute('aria-label') === label);
    assert.ok(button, `Missing button ${label}`);
    assert.equal(button.disabled, false);
    await React.act(async () => button.click()); await settle();
  };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client },
      React.createElement(exports.InboxSheet, { area: 'crm', onClose() {} }))));
    await settle();
    assert.equal(calls.filter(([kind]) => kind === 'open').length, 0);
    await click('Next');
    assert.ok(calls.some(([kind, , page]) => kind === 'list' && page === 2));
    await click('Show unread only');
    assert.ok(calls.some(([kind, , page, unread]) => kind === 'list' && page === 1 && unread));
    await click('Unread: Synthetic inquiry, from Test Lead');
    assert.ok(document.body.textContent.includes('Synthetic full body'));
    assert.equal(document.querySelectorAll('img,iframe').length, 0);
    await click('Mark unread');
    assert.equal(item.seen, false);
    await click('Mark read');
    assert.equal(item.seen, true);
    await click('Draft reply');
    assert.ok(document.body.textContent.includes('To: lead@example.test'));
    assert.equal([...document.querySelectorAll('button')].find(el => el.textContent === 'Sending unavailable').disabled, true);
    await React.act(async () => editReply('Synthetic draft only'));
    await click('Back to message');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][2][0].text, 'Keep editing');
    assert.equal(document.querySelector('textarea').value, 'Synthetic draft only');
    await React.act(async () => alerts[0][2][1].onPress());
    await settle();
    assert.equal(document.querySelector('textarea'), null);
    await click('Draft reply');
    assert.equal(document.querySelector('textarea').value, '');
    await click('Add attachment');
    assert.ok(document.body.textContent.includes('test.txt'));
    await click('Remove test.txt');
    assert.ok(!document.body.textContent.includes('test.txt'));
    await click('Add attachment');
    await click('Back to message');
    assert.equal(alerts.length, 2, 'Attachment-only drafts require confirmation');
    await React.act(async () => alerts[1][2][1].onPress());
    await settle();
    await click('Draft reply');
    assert.ok(document.body.textContent.includes('Attachments (0/5)'));
    await click('Back to message');
    await click('Back to messages');
    assert.ok(document.body.textContent.includes('No unread messages.'));
    assert.equal(calls.filter(([kind]) => kind === 'open').length, 1);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = oldWindow; global.document = oldDocument;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
