const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(relative, imports) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText,
    { exports, URLSearchParams, require: imports });
  return exports;
}
test('Mobile status query reaches the real CRM filter builder with search and scope intact', async () => {
  const constants = load('../../server/src/leads/lead.constants.ts', () => ({}));
  const backend = load('../../server/src/leads/leads.service.ts', (name) => name === '@nestjs/common' ? { Injectable: () => (target) => target } : name === './lead.constants' ? constants : {});
  let query;
  const mobile = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/leads/leads-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: mobile, URLSearchParams,
    require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url) => { query = Object.fromEntries(new URL(url).searchParams); return { ok: true, json: async () => ({ data: [] }) }; },
  });
  for (const status of ['', 'hot', 'warm', 'offer submitted']) {
    await mobile.fetchLeads('synthetic-token', 'Alice', undefined, 1, status);
    const filter = JSON.parse(JSON.stringify(backend.LeadsService.prototype.buildWhere.call({ scopeWhere: () => ({ owner_user_id: 42 }) }, { id: 42 }, query)));
    assert.deepEqual(filter.AND[0], { deleted_at: null });
    assert.deepEqual(filter.AND[1], { owner_user_id: 42 });
    assert.equal(filter.AND[2].OR[0].name.contains, 'Alice');
    const clause = filter.AND.find((item) => 'lead_status' in item);
    if (!status) assert.equal(clause, undefined);
    else assert.deepEqual(clause.lead_status, status === 'warm' ? { in: ['warm', 'mild'] } : status);
  }
});
