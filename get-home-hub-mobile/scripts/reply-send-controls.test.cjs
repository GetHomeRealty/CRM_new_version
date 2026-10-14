const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const { createRoot } = require('react-dom/client');

for (const mode of ['disabled', 'send', 'pending', 'storage-error']) test(`Reply controls ${mode}: synthetic only`, async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const oldWindow = global.window, oldDocument = global.document;
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [], alerts = [];
  let record = mode === 'pending' ? { key: 'saved-key', messageId: 23, status: 'pending' } : null;
  const primitive = ({ children }) => React.createElement('div', null, children);
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/reply-send-controls.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, AbortController, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'react-native') return { View: primitive, Alert: { alert: (...args) => alerts.push(args) }, Pressable: ({ children, onPress, disabled }) => React.createElement('button', { disabled, onClick: onPress }, children) };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'test', user: { id: 7 } }) };
      if (name.includes('environment')) return { environment: { inboxReplySendingEnabled: mode !== 'disabled' } };
      if (name.includes('reply-send-guard')) return {
        readReplyAttempt: async () => { if (mode === 'storage-error') throw new Error('disk'); return record; },
        guardedSubmitReply: async () => { calls.push('send'); record = { key: 'saved-key', messageId: 23, status: 'accepted' }; },
        recoverReplyAttempt: async () => { calls.push('recover'); record = { ...record, status: 'accepted' }; },
        acknowledgeAcceptedReply: async () => { calls.push('ack'); record = null; },
      };
      throw new Error(name);
    },
  });
  const root = createRoot(document.getElementById('root'));
  const settle = async () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
  try {
    await React.act(async () => root.render(React.createElement(api.ReplySendControls, { area: 'crm', messageId: 23, recipient: 'test@example.invalid', body: 'Test', attachments: [], picking: false, serverEnabled: true, onAccepted: () => calls.push('clear') })));
    await settle();
    if (mode === 'disabled' || mode === 'storage-error') {
      assert.equal(button(mode === 'disabled' ? 'Sending unavailable' : 'Send reply').disabled, true);
      assert.equal(calls.length, 0);
    } else if (mode === 'send') {
      await React.act(async () => button('Send reply').click());
      assert.equal(calls.length, 0, 'Confirmation is mandatory');
      assert.match(alerts[0][1], /test@example.invalid/);
      await React.act(async () => { alerts[0][2][1].onPress(); alerts[0][2][1].onPress(); });
      await settle(); assert.deepEqual(calls, ['send']);
      assert.match(document.body.textContent, /does not confirm delivery/);
    } else {
      assert.equal(button('Send reply'), undefined);
      await React.act(async () => button('Recover reply status').click()); await settle();
      assert.deepEqual(calls, ['recover']);
      await React.act(async () => button('Acknowledge accepted reply and clear draft').click()); await settle();
      assert.deepEqual(calls, ['recover', 'ack', 'clear']);
    }
  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); global.window = oldWindow; global.document = oldDocument; delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
