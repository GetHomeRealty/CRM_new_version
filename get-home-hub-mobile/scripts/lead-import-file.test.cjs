const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
test('CSV picker handles cancellation, bounds file reads and strips UTF-8 BOM', async () => {
  const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-import-file.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  for (const scenario of ['cancel', 'large', 'wrong-extension', 'ok']) {
    const api = {}; let reads = 0;
    vm.runInNewContext(source, { exports: api, require: name => {
      if (name.includes('document-picker')) return { getDocumentAsync: async options => { assert.equal(options.copyToCacheDirectory, true); return scenario === 'cancel' ? { canceled: true } : { canceled: false, assets: [{ name: scenario === 'wrong-extension' ? 'test.xlsx' : 'test.csv', uri: 'file:///synthetic.csv' }] }; } };
      if (name.includes('file-system')) return { File: class { exists = true; size = scenario === 'large' ? 2 * 1024 * 1024 : 30; async text() { reads++; return '\uFEFFname,email\nTest,test@example.invalid'; } } };
      if (name.includes('lead-import-api')) return { validateImport: csv => assert.ok(csv.startsWith('name,email')) };
      throw Error(name);
    } });
    if (scenario === 'cancel') assert.equal(await api.chooseImportCsv(), null);
    else if (scenario !== 'ok') await assert.rejects(api.chooseImportCsv());
    else assert.equal((await api.chooseImportCsv()).name, 'test.csv');
    assert.equal(reads, scenario === 'ok' ? 1 : 0);
  }
});
