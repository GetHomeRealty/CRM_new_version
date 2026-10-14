const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
function load(file, requireMock) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: requireMock });
  return exports;
}
const policy = load('../src/auth/access-policy.ts');
test('Calendar task and appointment handlers deny view-only writes before transport', () => {
  for (const file of ['../src/app/calendar.tsx', '../src/components/calendar-event-editor.tsx']) {
    const mutations = [];
    const primitive = () => null;
    const component = load(file, name => {
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'react') return { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] };
      if (name.includes('auth-context')) return { useMobileAuth: () => ({ token: 'test', user: { modules: ['crm'], permissions: { calendar: 'view' } } }) };
      if (name.includes('access-policy')) return policy;
      if (name.includes('calendar-api')) return { localDate: () => '2026-10-01', createEvent: () => assert.fail('transport'), deleteEvent: () => assert.fail('transport'), updateEvent: () => assert.fail('transport'), createTodo: () => assert.fail('transport'), updateTodo: () => assert.fail('transport'), deleteTodo: () => assert.fail('transport') };
      if (name === '@tanstack/react-query') return { useQueryClient: () => ({}), useQuery: () => ({}), useMutation: config => { mutations.push(config.mutationFn); return {}; } };
      if (name === 'react-native') return { ActivityIndicator: primitive, Alert: {}, Modal: primitive, Pressable: primitive, ScrollView: primitive, Switch: primitive, TextInput: primitive, View: primitive, StyleSheet: { create: x => x } };
      if (name.includes('safe-area')) return { SafeAreaView: primitive };
      if (name.includes('themed-text')) return { ThemedText: primitive };
      if (name.includes('themed-view')) return { ThemedView: primitive };
      if (name.includes('mobile-screen')) return { MobileScreen: primitive };
      if (name.includes('calendar-event-editor')) return { CalendarEventEditor: primitive };
      if (name.includes('constants/theme')) return { Spacing: {} };
      if (name.includes('use-theme')) return { useTheme: () => ({}) };
      throw Error(name);
    });
    if (component.default) component.default();
    else assert.equal(component.CalendarEventEditor({ event: null, area: 'crm', open: true }), null);
    assert.equal(mutations.length, component.default ? 3 : 2);
    for (const mutation of mutations) assert.throws(() => mutation({ id: 1 }), /permission/);
  }
});
