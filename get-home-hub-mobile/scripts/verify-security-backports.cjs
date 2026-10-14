/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const manifestHashes = {
  braces: '84f2d679729d3d601276f14ef0ca60ef06e9cd85d52660731fb52e640c5b1086',
  'node-forge': '0662e04d235c4d1ea2e8acaed297425d7cfaf7115467d9e677256d2f97263f2a',
};
function verifyVendor(base) {
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'SECURITY-MANIFEST.json'), 'utf8'));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(base, 'SECURITY-MANIFEST.json'))).digest('hex'), manifestHashes[manifest.name], 'Security manifest integrity mismatch');
  for (const [relative, expected] of Object.entries(manifest.runtimeFiles)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Unsafe manifest path');
    const actual = createHash('sha256').update(fs.readFileSync(path.join(base, relative))).digest('hex');
    assert.equal(actual, expected, `${manifest.name}/${relative}: security backport integrity mismatch`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.name, manifest.name);
  assert.equal(pkg.version, manifest.upstreamVersion, 'Never manufacture an upstream fixed version');
  assert(!pkg.devDependencies && !pkg.scripts, 'Vendor runtime must not install upstream development tools');
  return manifest;
}
function verifyBackports(root = path.resolve(__dirname, '..')) {
  const appRequire = createRequire(path.join(root, 'package.json'));
  const pkg = appRequire('./package.json');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [name, parent] of [['braces', 'micromatch'], ['node-forge', '@expo/code-signing-certificates']]) {
    const base = path.join(root, 'vendor', name);
    const manifest = verifyVendor(base);
    assert.equal(pkg.dependencies[name], 'file:vendor/' + name);
    assert.equal(pkg.overrides[name], '$' + name);
    const parentRequire = createRequire(appRequire.resolve(parent + '/package.json'));
    assert(fs.realpathSync(parentRequire.resolve(name)).startsWith(fs.realpathSync(base) + path.sep), `${parent} resolved unpatched ${name}`);
    for (const relative of Object.keys(lock.packages)) {
      if (relative === 'node_modules/' + name || relative.endsWith('/node_modules/' + name)) {
        assert.equal(fs.realpathSync(path.join(root, relative)), fs.realpathSync(base), `Unpatched nested ${name} copy`);
      }
    }
    if (name === 'node-forge') {
      assert.equal(manifest.backports[0].sha, 'ceba34402e329f0365134f23fe19898756527d65');
      assert.equal(manifest.backports[1].sha, '683ab3344899cc08a581e4d5675a33e87aff7b04');
    }
  }
  return ['GHSA-vfj7-8cjw-p6xm: locally depth-limited', 'GHSA-86w9-cpqp-85rv: locally strict-parsing backport'];
}
module.exports = { verifyVendor, verifyBackports };
if (require.main === module) {
  try { for (const result of verifyBackports()) console.log('PASS ' + result); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
