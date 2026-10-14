const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inboxBodyText } = require('./message-body-loader.cjs');
test('HTML-only mail becomes inert readable text without images or scripts', () => {
  const result = inboxBodyText({ body_text: null, body_html: '<head>private metadata</head><script>alert(1)</script><p>Hello &amp; welcome</p><p>Second<br>line</p><img src="https://tracking.invalid/pixel"><a href="javascript:alert(1)">Link text</a>' });
  assert.equal(result.converted, true);
  assert.match(result.text, /Hello & welcome\nSecond\nline\nLink text/);
  assert.doesNotMatch(result.text, /alert|tracking|metadata|<img|javascript/);
});
test('Mail body prefers plain text, handles blank fallback and announces truncation', () => {
  assert.equal(inboxBodyText({ body_text: 'Plain', body_html: '<p>HTML</p>' }).text, 'Plain');
  assert.equal(inboxBodyText({ body_text: '  ', body_html: '<p>HTML</p>' }).text, 'HTML');
  assert.match(inboxBodyText({ body_text: null, body_html: null }).text, /no readable/);
  const result = inboxBodyText({ body_text: 'x'.repeat(200001), body_html: null });
  assert.equal(result.text.length, 200000); assert.equal(result.truncated, true);
});
