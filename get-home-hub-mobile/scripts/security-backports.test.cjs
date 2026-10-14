/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { generateKeyPairSync } = require('node:crypto');
const { createRequire } = require('node:module');
const { verifyVendor, verifyBackports } = require('./verify-security-backports.cjs');
const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'package.json'));
const braces = appRequire('braces');
const forge = appRequire('node-forge');
const a = forge.asn1;
const nested = n => '{'.repeat(n) + 'a,b' + '}'.repeat(n);
const key = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 3 });
const privateKey = forge.pki.privateKeyFromPem(key.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
const publicKey = forge.pki.publicKeyFromPem(key.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString());
const md = algorithm => forge.md[algorithm].create().update('LOCAL QA signature fixture');
function digestInfo(algorithm, parameters, extra = []) {
  const digest = md(algorithm).digest().getBytes();
  const alg = [a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.oids[algorithm]).getBytes()), ...parameters, ...extra];
  return { digest, info: a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, alg), a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest)]) };
}
function signedInfo(value) { return forge.pki.rsa.encrypt(a.toDer(value.info).getBytes(), privateKey, 0x01); }
const emptyNull = () => a.create(a.Class.UNIVERSAL, a.Type.NULL, false, '');
test('installed backports match provenance and all transitive resolution paths', () => assert.equal(verifyBackports().length, 2));
test('integrity gate rejects modified backport source', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghh-backport-integrity-'));
  try { fs.cpSync(path.join(root, 'vendor/braces'), temp, { recursive: true }); fs.appendFileSync(path.join(temp, 'lib/compile.js'), '\n// tampered\n'); assert.throws(() => verifyVendor(temp), /integrity mismatch/); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('braces rejects deep patterns across parse/compile/expand/stringify and options cannot bypass', () => {
  for (const operation of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(nested(4000), { maxDepth: Infinity, maxLength: Infinity }), error => error instanceof SyntaxError && /security limit/.test(error.message));
  }
  assert.throws(() => braces.compile('('.repeat(4000) + 'a' + ')'.repeat(4000)), /security limit/);
  assert.throws(() => braces.parse('{'.repeat(4000)), /security limit/);
});
test('direct AST walker entry points reject deeply nested or cyclic nodes', () => {
  let node = { type: 'text', value: 'safe' };
  for (let i = 0; i < 1000; i++) node = { type: 'root', nodes: [node] };
  const cyclic = { type: 'root', nodes: [] }; cyclic.nodes.push(cyclic);
  for (const ast of [node, cyclic]) for (const operation of [braces.compile, braces.expand, braces.stringify]) assert.throws(() => operation(ast), /security limit/);
});
test('ordinary braces and Metro micromatch behavior remain compatible', () => {
  assert.deepEqual(braces.expand('src/{crm,leads}/{a,b}.ts'), ['src/crm/a.ts', 'src/crm/b.ts', 'src/leads/a.ts', 'src/leads/b.ts']);
  assert.deepEqual(braces.expand('x{1..3}'), ['x1', 'x2', 'x3']);
  assert.equal(braces.stringify(braces.parse('x{a,b}')), 'x{a,b}');
  assert.doesNotThrow(() => braces.compile(nested(16)));
  assert.doesNotThrow(() => braces.compile('\\{'.repeat(200) + 'literal'));
  const mm = appRequire('micromatch'); assert.deepEqual(mm(['src/crm/a.ts', 'src/account/a.ts'], 'src/{crm,leads}/*.ts'), ['src/crm/a.ts']);
});
test('RSA signature verification rejects surplus nested elements and nonempty NULL contents', () => {
  for (const parameters of [[emptyNull()], []]) {
    const value = digestInfo('sha256', parameters, [a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, 'garbage')]);
    assert.throws(() => publicKey.verify(value.digest, signedInfo(value)), /DigestInfo/);
  }
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const value = digestInfo(algorithm, [a.create(a.Class.UNIVERSAL, a.Type.NULL, false, 'garbage')]);
    assert.throws(() => publicKey.verify(value.digest, signedInfo(value)), /DigestInfo/);
  }
});
test('legitimate RSA signatures and digest mismatch retain verification semantics', () => {
  for (const algorithm of ['sha256', 'sha1', 'md5']) {
    const value = digestInfo(algorithm, [emptyNull()]);
    const signature = signedInfo(value);
    assert.equal(publicKey.verify(value.digest, signature), true);
    assert.equal(publicKey.verify(md(algorithm).update('changed').digest().getBytes(), signature), false);
  }
  const absent = digestInfo('sha256', []);
  assert.equal(publicKey.verify(absent.digest, signedInfo(absent)), true);
  const md5Absent = digestInfo('md5', []);
  assert.throws(() => publicKey.verify(md5Absent.digest, signedInfo(md5Absent)), /Missing algorithm/);
});
test('Expo certificate signing, validation and manifest signature round-trip use patched forge', () => {
  const certs = appRequire('@expo/code-signing-certificates');
  const keyPair = { privateKey, publicKey };
  const now = Date.now();
  const certificate = certs.generateSelfSignedCodeSigningCertificate({ keyPair, commonName: 'LOCAL QA security backport', validityNotBefore: new Date(now - 60000), validityNotAfter: new Date(now + 60000) });
  assert.doesNotThrow(() => certs.validateSelfSignedCertificate(certificate, keyPair));
  const signature = certs.signBufferRSASHA256AndVerify(privateKey, certificate, Buffer.from('LOCAL QA manifest fixture'));
  assert.equal(typeof signature, 'string');
});

test('integrity gate rejects a manifest changed to bless tampered source', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghh-backport-manifest-'));
  try {
    fs.cpSync(path.join(root, 'vendor/braces'), temp, { recursive: true });
    const file = path.join(temp, 'SECURITY-MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.runtimeFiles['lib/compile.js'] = 'altered';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyVendor(temp), /manifest integrity mismatch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
