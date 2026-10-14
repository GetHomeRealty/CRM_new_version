const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('Lead export creates a private fixed-name CSV and cleans it after success or failure', async () => {
  for (const failure of [false, true]) {
    const api = {}; let deleted = 0, written, shared = 0;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-export-share.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports: api, require: name => {
        if (name === 'expo-file-system') return { Paths: { cache: 'private-cache' }, Directory: class { exists = true; constructor(root, name) { assert.equal(root, 'private-cache'); assert.match(name, /^hub-lead-export-/); } create() {} delete() { deleted++; } }, File: class { uri = 'file:///private-cache/export.csv'; constructor(_dir, name) { assert.equal(name, 'selected-leads.csv'); } write(value) { written = value; } } };
        if (name === 'expo-crypto') return { randomUUID: () => 'synthetic' };
        if (name === 'expo-sharing') return { isAvailableAsync: async () => true, shareAsync: async (_uri, options) => { shared++; assert.equal(options.mimeType, 'text/csv'); if (failure) throw Error('Share failed'); } };
        if (name.includes('lead-bulk-api')) return { leadExportCsv: () => 'safe-csv' };
        throw Error(name);
      },
    });
    if (failure) await assert.rejects(api.shareLeadExport([{ Name: 'Test' }])); else await api.shareLeadExport([{ Name: 'Test' }]);
    assert.equal(written, '\uFEFFsafe-csv'); assert.equal(deleted, 1); assert.equal(shared, 1);
    await assert.rejects(api.shareLeadExport([]), /No eligible/);
  }
});
