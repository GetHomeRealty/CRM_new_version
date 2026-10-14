const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/campaigns/delivery-summary.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Hard, soft and unknown bounces have distinct actionable explanations', () => {
  assert.match(api.deliverySummary({ bounce_type: 'hard' }), /Permanent/);
  const soft = api.deliverySummary({ bounce_type: 'soft', retry_count: 2, next_retry_at: '2026-10-01T12:00:00Z' });
  assert.match(soft, /Temporary/); assert.match(soft, /retries: 2/); assert.match(soft, /2026-10-01/);
  assert.match(api.deliverySummary({ bounce_type: 'soft' }), /No next retry time/);
  assert.match(api.deliverySummary({ bounce_type: 'unknown' }), /does not establish/);
});
test('Sent and pending labels do not claim delivery or trigger an action', () => {
  assert.match(api.deliverySummary({ status: 'sent' }), /does not confirm inbox/);
  assert.match(api.deliverySummary({ status: 'pending' }), /Awaiting processing/);
  assert.match(api.deliverySummary({ status: 'failed' }), /no retry is triggered/);
});
test('Missing classifications and future statuses fall back without exposing raw errors', () => {
  assert.match(api.deliverySummary({ bounced: true }), /No bounce classification/);
  const result = api.deliverySummary({ status: 'future-status', error: 'secret SMTP diagnostics' });
  assert.match(result, /No additional/); assert.doesNotMatch(result, /secret/);
});
