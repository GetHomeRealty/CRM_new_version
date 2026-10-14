const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
const React = require('react'), { createRoot } = require('react-dom/client'), { JSDOM } = require('jsdom');
for (const mode of ['disabled', 'local', 'production', 'release', 'expired', 'interrupted', 'revoked']) test(`Campaign review ${mode} enforces review and environment gates`, async () => {
  const dom = new JSDOM('<div id="root"></div>'); const previous = { window: global.window, document: global.document };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const fields = {}, calls = []; let active = true, actions, acknowledged = false, sent = false, recovered = false;
  let grant = 'edit';
  let now = Date.now(); const local = ['local', 'release', 'expired', 'interrupted', 'revoked'].includes(mode);
  const primitive = ({ children }) => React.createElement('div', null, children);
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/campaign-review-sheet.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: api, AbortController, Error, Date: { now: () => now }, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-native') return { Modal: primitive, ScrollView: primitive, ActivityIndicator: primitive, StyleSheet: { create: x => x }, Alert: { alert: (_t, _m, a) => { actions = a; } }, TextInput: ({ accessibilityLabel, onChangeText }) => { fields[accessibilityLabel] = onChangeText; return null; }, Pressable: ({ children, onPress, disabled }) => React.createElement('button', { onClick: onPress, disabled }, children) };
    if (name === 'react-native-safe-area-context') return { SafeAreaProvider: primitive, SafeAreaView: primitive };
    if (name.includes('themed-text')) return { ThemedText: primitive };
    if (name.includes('use-theme')) return { useTheme: () => ({}) };
    if (name.includes('access-policy')) return require('./access-policy-loader.cjs');
    if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'synthetic', user: { id: 1, modules: ['crm'], permissions: { campaigns: grant } } }) };
    if (name.includes('environment')) return { environment: { campaignSendingEnabled: mode === 'release', localCampaignSendTesting: mode !== 'disabled', apiUrl: ['production', 'release'].includes(mode) ? 'https://gethomehub.ca' : 'http://localhost:8000' } };
    if (name.includes('campaign-send-guard')) return { readCampaignAttempt: async () => acknowledged && !sent ? null : ({ state: mode === 'interrupted' && sent && !recovered ? 'pending' : 'confirmed', requestKey: '00000000-0000-4000-8000-000000000001', campaignId: 9, startedAt: '2026-09-29T10:00:00Z' }), recoverPendingCampaign: async () => { recovered = true; return { id: 9, status: 'scheduled' }; }, verifyConfirmedCampaign: async () => ({ id: 9, status: 'sending' }), acknowledgeConfirmedCampaign: async (userId, id) => { assert.equal(userId, 1); assert.equal(id, 9); acknowledged = true; }, guardedSubmitCampaign: async (userId, token, draft) => { assert.equal(userId, 1); assert.equal(token, 'synthetic'); calls.push({ submitted: draft }); sent = true; if (mode === 'interrupted') throw Error('Outcome unknown. Do not resubmit.'); return { id: 9, status: 'sending' }; } };
    if (name.includes('campaign-write-api')) return { campaignPayload: draft => { if (!draft.name) throw Error('Enter a name'); return {}; }, submitCampaign: () => { throw Error('Review must never submit'); } };
    if (name.includes('template-text')) return { templateText: () => 'Safe body preview' };
    if (name.includes('campaign-preview-api')) return { fetchCampaignTemplates: async () => [{ id: 1, is_active: active, subject: 'Fresh subject', content: '<p>Body</p>', attachment_count: 1, attachments: [{ id: 2, filename: 'fixture.txt', size: 4 }] }], previewCampaignAudience: async (_token, tag, _signal, filters) => { calls.push({ tag, filters }); return { count: 1, sample: [{ name: 'Synthetic', email: 'qa@example.invalid' }] }; } };
    throw Error(name);
  } });
  const root = createRoot(document.getElementById('root'));
  const click = text => React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === text).click());
  try {
    await React.act(async () => root.render(React.createElement(api.CampaignReviewSheet, { template: { id: 1, name: 'Original' }, filters: { leadStatus: 'hot' }, tag: 'QA', onClose: () => {} })));
    assert.match(document.body.textContent, /Campaign #9 was confirmed/);
    await click('Verify previous campaign'); assert.match(document.body.textContent, /Verified campaign #9: sending/);
    await click('Acknowledge verified campaign'); assert.equal(acknowledged, true); assert.doesNotMatch(document.body.textContent, /Previous attempt/);
    await click('Refresh campaign review'); assert.match(document.body.textContent, /Enter a name/); assert.equal(calls.length, 0);
    await React.act(async () => fields['Campaign name']('Synthetic campaign'));
    await click('Refresh campaign review');
    assert.match(document.body.textContent, /Fresh subject/); assert.match(document.body.textContent, /fixture.txt/); assert.match(document.body.textContent, /qa@example.invalid/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { tag: 'QA', filters: { leadStatus: 'hot' } });
    if (!local) assert.match(document.body.textContent, /Sending is not enabled/);
    await React.act(async () => fields['Campaign schedule']('changed'));
    assert.doesNotMatch(document.body.textContent, /Fresh subject/);
    active = false; await click('Refresh campaign review'); assert.match(document.body.textContent, /inactive or unavailable/);
    await click('Back to campaign tools'); assert.equal(actions[0].text, 'Keep editing');
    if (local) {
      active = true; await React.act(async () => fields['Campaign schedule'](''));
      await click('Refresh campaign review'); await click(mode === 'release' ? 'Confirm campaign submission' : 'Confirm local test submission');
      assert.equal(calls.filter(call => call.submitted).length, 0); assert.equal(actions[0].text, 'Keep reviewing');
      if (mode === 'expired') now += 61000;
      if (mode === 'revoked') {
        grant = 'view';
        await React.act(async () => root.render(React.createElement(api.CampaignReviewSheet, { template: { id: 1, name: 'Original' }, filters: { leadStatus: 'hot' }, tag: 'QA', onClose: () => {} })));
        await React.act(async () => actions[1].onPress());
        assert.equal(calls.filter(call => call.submitted).length, 0);
        assert.doesNotMatch(document.body.textContent, /Confirm local test submission/);
        return;
      }
      await React.act(async () => { actions[1].onPress(); actions[1].onPress(); });
      if (mode === 'expired') { assert.equal(calls.filter(call => call.submitted).length, 0); assert.match(document.body.textContent, /Review expired/); return; }
      assert.equal(calls.filter(call => call.submitted).length, 1);
      if (mode === 'interrupted') {
        assert.match(document.body.textContent, /Outcome unresolved/); assert.doesNotMatch(document.body.textContent, /accepted with status/);
        await click('Refresh campaign review');
        const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm local test submission');
        assert.equal(confirm.disabled, true);
        await click('Recover submission status');
        assert.match(document.body.textContent, /Verified campaign #9: scheduled/);
        assert.equal(calls.filter(call => call.submitted).length, 1);
        return;
      }
      assert.match(document.body.textContent, /Campaign #9 accepted/);
      assert.match(document.body.textContent, /Acceptance is not proof of delivery/);
    } else assert.equal(calls.filter(call => call.submitted).length, 0);
  } finally { await React.act(async () => root.unmount()); dom.window.close(); global.window = previous.window; global.document = previous.document; delete global.IS_REACT_ACT_ENVIRONMENT; }
});
