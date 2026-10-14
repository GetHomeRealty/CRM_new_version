const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(body, status = 200) {
  const api = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/leads/lead-bulk-api.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: api, require: () => ({ environment: { apiUrl: 'http://localhost:8000' } }),
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => body }; },
  });
  return { api, calls };
}
test('Bulk lead actions cannot broaden empty or invalid selection into all leads', async () => {
  const { api, calls } = load({ deleted: 1 });
  for (const ids of [[], [0], [1.2], Array.from({ length: 51 }, (_, i) => i + 1)]) {
    await assert.rejects(api.moveLeadsToDeleted('synthetic', ids));
    await assert.rejects(api.exportSelectedLeads('synthetic', ids));
  }
  assert.equal(calls.length, 0);
  assert.equal(await api.moveLeadsToDeleted('synthetic', [1, 1, 2]), 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { lead_ids: [1, 2] });
  assert.ok(calls[0].url.endsWith('/bulk-delete')); assert.equal(calls[0].options.method, 'POST');
  await assert.rejects(load({ deleted: 3 }).api.moveLeadsToDeleted('synthetic', [1]), /invalid/);
});
test('Selected export validates scoped totals and escapes spreadsheet formulas', async () => {
  const body = { data: [{ Name: '=CMD()', Email: 'test@example.invalid', Notes: 'a,"b"\nc' }], meta: { total: 1, returned: 1, truncated: false } };
  const { api, calls } = load(body);
  assert.equal(await api.exportSelectedLeads('synthetic', [1]), body);
  assert.ok(calls[0].url.endsWith('/export'));
  assert.match(api.leadExportCsv(body.data), /"'=CMD\(\)"/);
  assert.match(api.leadExportCsv(body.data), /a,""b""\nc/);
  for (const value of ['+123', '-123', '@SUM(1)', '\t=1', '  =1']) assert.ok(api.leadExportCsv([{ Name: value }]).includes(`"'${value}"`));
  await assert.rejects(load({ ...body, meta: { ...body.meta, total: 99 } }).api.exportSelectedLeads('synthetic', [1]), /invalid/);
  await assert.rejects(load({}, 403).api.exportSelectedLeads('synthetic', [1]), /permission/);
});
