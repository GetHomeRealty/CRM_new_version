const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const React = require('react'), { JSDOM } = require('jsdom'), { createRoot } = require('react-dom/client');
for (const scenario of ['manual', 'limit', 'gmail-unavailable']) test(`Mailbox connection screen: ${scenario}`, async () => {
  const dom = new JSDOM('<div id="root"></div>'), old = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const api = {}, accounts = []; let confirmations, submissions = 0, browserOpens = 0, finish;
  const primitive = ({ children }) => React.createElement('div', null, children);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/connect-mailbox-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: api, Error, AbortController, setTimeout, clearTimeout, require: name => {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive,
        Alert: { alert: (_title, _message, options) => { confirmations = options; } }, Linking: { openURL: async () => { browserOpens++; } },
        Pressable: ({ children, disabled, onPress }) => React.createElement('button', { disabled, onClick: onPress }, children) };
      if (name.includes('safe-area')) return { SafeAreaProvider: primitive, SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1 } }) };
      if (name.includes('account-api')) return { mailboxInput: value => value };
      if (name.includes('mailbox-editor')) return { MailboxEditor: ({ onSave, busy }) => React.createElement('button', { disabled: busy, onClick: () => onSave({ username: 'synthetic' }, 'synthetic-secret') }, 'Submit synthetic mailbox') };
      if (name.includes('mailbox-connect')) return {
        emptyMailbox: {}, pendingMailbox: async () => false,
        mailboxConnections: async () => ({ accounts: [...accounts], limit: { max: 1, used: scenario === 'limit' ? 1 : accounts.length, canAdd: scenario !== 'limit' && accounts.length === 0 } }),
        connectMailbox: async () => { submissions++; await new Promise(resolve => { finish = resolve; }); accounts.push({ id: 2, from_email: 'test@example.invalid' }); },
        gmailConnectUrl: async () => { throw Error('Gmail is not configured on this server.'); },
      };
      throw Error(name);
    },
  });
  const root = createRoot(document.getElementById('root'));
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try {
    await React.act(async () => root.render(React.createElement(api.ConnectMailboxSheet, { onClose() {} }))); await settle();
    if (scenario === 'limit') { assert.equal(button('Connect Gmail').disabled, true); assert.equal(button('Connect with SMTP / IMAP').disabled, true); assert.match(document.body.textContent, /limit has been reached/); }
    else if (scenario === 'manual') {
      await React.act(async () => button('Connect with SMTP / IMAP').click());
      await React.act(async () => button('Submit synthetic mailbox').click()); assert.equal(submissions, 0);
      await React.act(async () => { confirmations[1].onPress(); confirmations[1].onPress(); }); assert.equal(submissions, 1);
      await React.act(async () => finish()); assert.match(document.body.textContent, /Mailbox saved/); assert.match(document.body.textContent, /Connected: test@example.invalid/);
    } else {
      await React.act(async () => button('Connect Gmail').click()); assert.equal(browserOpens, 0);
      await React.act(async () => confirmations[1].onPress()); assert.match(document.body.textContent, /not configured/); assert.equal(browserOpens, 0);
    }
  } finally { if (finish) await React.act(async () => finish()); await React.act(async () => root.unmount()); dom.window.close(); Object.assign(global, old); }
});
