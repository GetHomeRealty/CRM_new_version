const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/campaigns/template-text.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
test('Template text removes markup and non-content while preserving placeholders and line breaks', () => {
  assert.equal(api.templateText('<head>hidden</head><style>hidden</style><!--hidden--><p>Hello {{name}} &amp; team</p><p>Next<br>line</p><img src="tracker"><script>hidden</script>'), 'Hello {{name}} & team\nNext\nline');
});
test('Template text decodes entities safely and bounds input', () => {
  assert.equal(api.templateText('&#65; &#x1f600; &lt;b&gt; &#99999999;'), 'A 😀 <b> &#99999999;');
  assert.equal(api.templateText('x'.repeat(200001)).length, 200000);
  assert.equal(api.templateText('<script>unfinished'), '');
});
