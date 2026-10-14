const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/transactions/document-files.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: api });
test('Document attachments preserve primary, indexed and validation file routes', () => {
  const files = api.documentAttachments({ id: 9, has_file: true, file_name: 'Offer.pdf',
    files: [{ index: 0, client_name: 'Synthetic Buyer', file_name: 'ID.pdf' }], has_validation_file: true, validation_file_name: 'Review.pdf' });
  assert.equal(files.length, 3);
  assert.equal(files[0].path, '/api/documents/9/file');
  assert.equal(files[1].path, '/api/documents/9/files/0');
  assert.equal(files[2].path, '/api/documents/9/validation-file');
  assert.equal(files[1].label, 'Synthetic Buyer · ID.pdf');
});
test('Missing files do not become downloadable and filenames cannot control paths', () => {
  assert.equal(api.documentAttachments({ id: 9, has_file: false }).length, 0);
  const files = api.documentAttachments({ id: 9, has_file: true, file_name: '../../secret', files: [{ index: 0 }, { index: 0 }] });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, '/api/documents/9/file');
  assert.equal(files[1].label, 'Attachment 1');
});
test('Invalid document identifiers and attachment indexes fail closed', () => {
  for (const id of [0, -1, 1.5, NaN]) assert.throws(() => api.documentAttachments({ id }));
  for (const index of [-1, 1.5, Infinity]) assert.throws(() => api.documentAttachments({ id: 9, files: [{ index }] }));
});
