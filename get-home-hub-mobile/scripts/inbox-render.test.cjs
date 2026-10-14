const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('Inbox renders synthetic messages and controls without automatically opening or modifying mail', () => {
  const exports = {};
  const primitive = ({ children }) => React.createElement('div', null, children);
  const forbidden = () => { throw new Error('No network or mutation allowed while rendering'); };
  const source = fs.readFileSync(path.join(__dirname, '../src/components/inbox-sheet.tsx'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { ActivityIndicator: primitive, Modal: primitive,
      Pressable: primitive, ScrollView: primitive, View: primitive, StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive, SafeAreaProvider: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('reply-send-controls')) return { ReplySendControls: primitive };
    if (name === './mail-attachments') return { MailAttachments: primitive };
    if (name === './provider-sent-sheet') return { ProviderSentSheet: primitive };
    if (name === './mail-message-body') return { MailMessageBody: primitive };
    if (name === './sent-mail-sheet') return { SentMailSheet: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic-only' }) };
    if (name.includes('reply-attachments')) return { pickReplyAttachment: forbidden };
    if (name.includes('message-body')) return require('./message-body-loader.cjs');
    if (name.includes('inbox-api')) return { fetchInbox: forbidden, openInboxMessage: forbidden, setInboxMessageSeen: forbidden };
    if (name === '@tanstack/react-query') return {
      useQueryClient: () => ({ invalidateQueries: forbidden }),
      useMutation: () => ({ mutate: forbidden, reset() {}, isPending: false }),
      useQuery: () => ({ data: { mailbox: { address: 'agent@example.test' }, unread: 1,
        meta: { page: 1, last_page: 2 }, data: [{ id: 1, seen: false, subject: 'Synthetic inquiry',
          from_email: 'lead@example.test', snippet: 'Local test only', received_at: '2030-01-01T12:00:00Z' }] } }),
    };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const markup = renderToStaticMarkup(React.createElement(exports.InboxSheet, { area: 'crm', onClose() {} }));
  for (const text of ['Synthetic inquiry', 'Mailbox Sent', 'agent@example.test', 'Show unread only', 'Refresh', 'Previous', 'Next', 'Close inbox', 'Page 1 of 2']) {
    assert.ok(markup.includes(text), `Missing ${text}`);
  }
});
