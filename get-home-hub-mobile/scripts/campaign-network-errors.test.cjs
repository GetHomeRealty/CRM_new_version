const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
for (const [file, method] of [['campaigns-api.ts', 'fetchCampaigns'], ['campaign-preview-api.ts', 'fetchCampaignTemplates']]) {
  for (const mode of ['network', 'json', 'abort']) test(`${file}: ${mode} errors remain safe and cancellation is preserved`, async () => {
    const api = {}, controller = new AbortController(), nativeError = new Error('InternalNativeSource.swift:56 private implementation details');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/campaigns', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
      fetch: async () => {
        if (mode === 'abort') controller.abort();
        if (mode !== 'json') throw nativeError;
        return { ok: true, json: async () => { throw nativeError; } };
      },
    });
    await assert.rejects(api[method]('synthetic', controller.signal), error => {
      if (mode === 'abort') assert.equal(error, nativeError);
      else { assert.match(error.message, mode === 'network' ? /Check your connection and retry/ : /Could not read campaign data/); assert.doesNotMatch(error.message, /swift|private/i); }
      return true;
    });
  });
}
