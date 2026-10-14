/* global __dirname */
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

test('Notifications paginate, reset filters, mark individual alerts and require bulk confirmation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  let confirmation, closed = false, read = false;
  const item = { key: 'direct:21', source: 'direct', notification_id: 21, transaction_id: 0, title: 'Synthetic alert', unread: true, link: '/crm/lead/42' };
  const api = {
    fetchNotifications: async (_token, options) => {
      calls.push(['list', options.filter, options.offset, options.source]);
      return { items: options.filter === 'unread' && read ? [] : [{ ...item, unread: !read }], total: 31, limit: 30, unread: 1 };
    },
    markNotificationRead: async (_token, notification) => { calls.push(['read', notification.notification_id]); read = true; },
    markAllNotificationsRead: async () => { calls.push(['all']); return { marked: 3, failed: 1 }; },
  };
  const primitive = ({ children }) => React.createElement('div', null, children);
  const Pressable = ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/notifications-sheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@tanstack/react-query') return query;
    if (name === 'react-native') return { Pressable, Modal: primitive, ActivityIndicator: primitive,
      TextInput: () => null, ScrollView: primitive, View: primitive,
      Alert: { alert: (...args) => { confirmation = args; } }, StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: primitive };
    if (name.includes('native-push-controls')) return { NativePushControls: () => null };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({ primary: '#4433cc', background: '#fff' }) };
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic-only' }) };
    if (name.includes('notifications-api')) return api;
    if (name.includes('notification-target')) {
      const targetApi = {};
      vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/notifications/notification-target.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText, { exports: targetApi });
      return targetApi;
    }
    if (name.includes('lead-detail-sheet')) return { LeadDetailSheet: ({ leadId, onClose }) => React.createElement('button', { onClick: onClose }, `Return from lead ${leadId}`) };
    if (name.includes('transaction-detail-sheet')) return { TransactionDetailSheet: primitive };
    if (name.includes('notification-preferences-sheet')) return { NotificationPreferencesSheet: ({ onClose }) => React.createElement('button', { onClick: onClose }, 'Back from preferences') };
    throw new Error(`Unexpected import ${name}`);
  } });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const click = async (label) => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
    assert.ok(button, `Missing ${label}`); assert.equal(button.disabled, false);
    await React.act(async () => button.click()); await settle();
  };
  try {
    await React.act(async () => root.render(React.createElement(query.QueryClientProvider, { client },
      React.createElement(exports.NotificationsSheet, { onClose: () => { closed = true; } }))));
    await settle();
    assert.equal(calls.some(([kind]) => kind !== 'list'), false);
    await click('Preferences');
    await click('Back from preferences');
    await click('Open related record');
    await click('Return from lead 42');
    assert.ok(document.body.textContent.includes('Synthetic alert'));
    assert.equal(calls.some(([kind]) => kind !== 'list'), false);
    await click('Next');
    assert.ok(calls.some(([kind, , offset]) => kind === 'list' && offset === 30));
    await click('Alerts');
    assert.ok(calls.some(([kind, , offset, source]) => kind === 'list' && offset === 0 && source === 'direct'));
    await click('Reminders');
    assert.ok(calls.some(([kind, , offset, source]) => kind === 'list' && offset === 0 && source === 'reminder'));
    await click('All categories');
    await click('Unread');
    assert.ok(calls.some(([kind, filter, offset]) => kind === 'list' && filter === 'unread' && offset === 0));
    await click('Mark read');
    assert.ok(calls.some(([kind, id]) => kind === 'read' && id === 21));
    assert.ok(document.body.textContent.includes('No matching notifications.'));
    await click('Mark all read');
    assert.equal(calls.some(([kind]) => kind === 'all'), false);
    assert.ok(confirmation[1].includes('outside this page and filter'));
    assert.equal(confirmation[2][0].style, 'cancel');
    await React.act(async () => confirmation[2][1].onPress()); await settle();
    assert.equal(calls.filter(([kind]) => kind === 'all').length, 1);
    assert.ok(document.body.textContent.includes('1 could not be updated'));
    await click('Close'); assert.equal(closed, true);
  } finally {
    await React.act(async () => root.unmount()); client.clear(); dom.window.close();
    global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
