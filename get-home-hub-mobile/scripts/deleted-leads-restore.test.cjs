const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('Restore confirmation prevents duplicate submissions and rechecks revoked access', async () => {
  for (const scenario of ['success', 'revoked', 'lost-response', 'timeout', 'unmount']) {
    const revoke = scenario === 'revoked';
    const effects = []; let actions; let calls = 0; let release;
    const stateChanges = []; const invalidated = []; let timer; let requestSignal;
    const api = {};
    const primitive = () => null;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/components/deleted-leads-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      exports: api, Error, AbortController, setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {}, require: name => {
        if (name === 'react/jsx-runtime') return require(name);
        if (name === 'react') return { useState: x => [x, value => stateChanges.push(value)], useRef: x => ({ current: x }), useLayoutEffect: effect => { effects.push(effect()); } };
        if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries({ queryKey }) { invalidated.push(queryKey[0]); } }), useQuery: () => ({ data: { data: [{ id: 1, name: 'Synthetic lead', email: null, deleted_at: null }], meta: { total: 1, last_page: 1 } } }) };
        if (name === 'react-native') return { ActivityIndicator: primitive, Alert: { alert: (_title, _body, value) => { actions = value; } }, FlatList: 'list', Modal: primitive, Pressable: 'button', TextInput: primitive, View: primitive };
        if (name.includes('safe-area')) return { SafeAreaProvider: primitive, SafeAreaView: primitive };
        if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { modules: ['crm'], permissions: { lead: 'edit' } } }) };
        if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
        if (name.includes('deleted-leads-api')) return { restoreDeletedLead: async (_token, _id, signal) => {
          calls++; requestSignal = signal;
          await new Promise((resolve, reject) => {
            release = () => scenario === 'lost-response' ? reject(Error('Connection lost')) : resolve();
            signal.addEventListener('abort', () => reject(Error('Aborted')), { once: true });
          });
        } };
        if (name.includes('use-theme')) return { useTheme: () => ({}) };
        if (name.includes('themed-text')) return { ThemedText: primitive };
        throw Error(name);
      },
    });
    function find(node, match) {
      if (!node) return;
      if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return; }
      if (match(node)) return node;
      return find(node.props?.children, match);
    }
    const tree = api.DeletedLeadsSheet({ onClose() {} });
    const list = find(tree, x => x.type === 'list');
    const row = list.props.renderItem({ item: list.props.data[0] });
    find(row, x => x.props?.accessibilityLabel === 'Restore Synthetic lead').props.onPress();
    assert.equal(calls, 0); assert.equal(actions[0].text, 'Cancel');
    if (revoke) effects[0]();
    actions[1].onPress(); actions[1].onPress();
    assert.equal(calls, revoke ? 0 : 1);
    if (scenario === 'timeout') timer();
    else if (scenario === 'unmount') { for (const cleanup of effects) cleanup?.(); assert.equal(requestSignal.aborted, true); }
    else if (release) release();
    const changesBeforeSettling = stateChanges.length;
    await new Promise(resolve => setImmediate(resolve));
    if (scenario === 'success') assert.ok(stateChanges.includes('Lead restored.'));
    if (scenario === 'lost-response') { assert.ok(stateChanges.includes('Connection lost')); assert.ok(!stateChanges.includes('Lead restored.')); }
    if (scenario === 'timeout') assert.ok(stateChanges.some(x => typeof x === 'string' && x.includes('timed out')));
    if (scenario === 'unmount') assert.equal(stateChanges.length, changesBeforeSettling, 'Unmounted screen must not update state');
    assert.deepEqual(invalidated, revoke || scenario === 'unmount' ? [] : ['leads', 'deleted-leads']);
    actions[1].onPress();
    assert.equal(calls, revoke ? 0 : 1, 'An already attempted restore must not be silently repeated');
    for (const cleanup of effects) cleanup?.();
  }
});
