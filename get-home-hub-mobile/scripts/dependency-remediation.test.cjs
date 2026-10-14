/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');
const appRequire = createRequire(path.join(__dirname, '../package.json'));
for (const parent of ['eslint', '@expo/fingerprint']) {
  test(`patched brace expansion preserves ${parent} glob integration`, () => {
    const parentRequire = createRequire(appRequire.resolve(parent + '/package.json'));
    const mm = parentRequire('minimatch');
    const match = typeof mm === 'function' ? mm : mm.minimatch;
    assert.equal(match('src/leads/a.ts', 'src/{leads,crm}/*.ts'), true);
    assert.equal(match('src/account/a.ts', 'src/{leads,crm}/*.ts'), false);
    const braceRequire = createRequire(parentRequire.resolve('minimatch'));
    const brace = braceRequire('brace-expansion');
    const expand = typeof brace === 'function' ? brace : brace.expand;
    assert.deepEqual(expand('x{1..3}'), ['x1', 'x2', 'x3']);
    assert.doesNotThrow(() => expand('{a}' + '}'.repeat(8000) + ',z}'));
  });
}
test('shell quoting rejects comment-line escape and preserves ordinary quoting', () => {
  const shell = appRequire('shell-quote');
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => shell.quote([{ comment: 'safe' }, terminator + 'echo injected']), TypeError);
  }
  assert.deepEqual(shell.parse(shell.quote(['hello world', 'a;b', 'plain'])), ['hello world', 'a;b', 'plain']);
});
test('source maps reject amplified offsets while preserving valid indexed mappings', () => {
  const { SourceMapConsumer } = appRequire('source-map-js');
  const map = { version: 3, sources: ['input.ts'], names: [], mappings: 'AAAA' };
  assert.throws(() => new SourceMapConsumer({ version: 3, sections: [{ offset: { line: 10000001, column: 0 }, map }] }), /must not exceed/);
  const consumer = new SourceMapConsumer({ version: 3, sections: [{ offset: { line: 1, column: 0 }, map }] });
  assert.equal(consumer.originalPositionFor({ line: 2, column: 1 }).source, 'input.ts');
});
test('compression releases its gzip stream on an aborted localhost response', { timeout: 7000 }, async () => {
  const original = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  let stream;
  Object.defineProperty(zlib, 'createGzip', { ...original, value: (...args) => { stream = original.value(...args); return stream; } });
  const compression = appRequire('compression')({ threshold: 0 });
  const server = http.createServer((req, res) => compression(req, res, () => {
    res.setHeader('Content-Type', 'text/plain');
    res.write('LOCAL QA compressed response '.repeat(1000));
    res.flush();
  }));
  let request;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    request = http.get({ host: '127.0.0.1', port: server.address().port, headers: { 'Accept-Encoding': 'gzip' } });
    const [response] = await once(request, 'response');
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert(stream);
    const closed = once(stream, 'close');
    response.destroy();
    await closed;
    assert.equal(stream.destroyed, true);
  } finally {
    request?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    Object.defineProperty(zlib, 'createGzip', original);
  }
});
