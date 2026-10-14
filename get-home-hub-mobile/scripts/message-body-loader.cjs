const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies) {
  const api = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, require: () => dependencies });
  return api;
}
module.exports = load('../src/inbox/message-body.ts', load('../src/campaigns/template-text.ts'));
