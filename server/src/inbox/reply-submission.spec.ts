import { parseComposeSubmission, parseReplySubmission, replyTextToHtml } from './reply-submission';

const key = '12345678-1234-4123-8123-123456789abc';
const file = { filename: 'test.txt', content_type: 'text/plain', data: 'dGVzdA==' };
const draft = () => ({ request_key: key, body_text: 'Hello', attachments: [file] });

describe('reply submission validation (no delivery or database)', () => {
  it('validates compose recipient/subject and binds them to the fingerprint', () => {
    const input = { ...draft(), to: 'a@example.invalid', subject: 'Hello' };
    const result = parseComposeSubmission(input);
    expect(result.to).toBe('a@example.invalid');
    expect(parseComposeSubmission({ ...input, to: 'b@example.invalid' }).fingerprint).not.toBe(result.fingerprint);
    expect(() => parseComposeSubmission({ ...input, to: 'a@example.invalid,b@example.invalid' })).toThrow('one valid');
    expect(() => parseComposeSubmission({ ...input, subject: 'bad\r\nBcc: x@y' })).toThrow('subject');
    expect(() => parseComposeSubmission({ ...input, from: 'spoof@example.invalid' })).toThrow('unsupported');
  });
  it('normalizes the receipt key and maps validated attachments', () => {
    expect(parseReplySubmission(7, { ...draft(), request_key: key.toUpperCase() })).toMatchObject({
      requestKey: key, bodyText: 'Hello', attachments: [{ name: 'test.txt', mime: 'text/plain', data: 'dGVzdA==' }],
    });
  });
  it.each(['to', 'from', 'account_id', 'headers', 'message_id', 'html'])('rejects client-controlled %s', field => {
    expect(() => parseReplySubmission(7, { ...draft(), [field]: 'override' })).toThrow('unsupported');
  });
  it.each(['', 'x', null, 42])('requires a valid durable request key %s', request_key => {
    expect(() => parseReplySubmission(7, { ...draft(), request_key })).toThrow('submission key');
  });
  it.each(['', '   ', '\0', 'x'.repeat(20001), null])('rejects invalid body', body_text => {
    expect(() => parseReplySubmission(7, { ...draft(), body_text })).toThrow('message');
  });
  it.each(['../file', 'a/b', 'a\\b', 'a\r\nBcc:x', ''])('rejects filename %s', filename => {
    expect(() => parseReplySubmission(7, { ...draft(), attachments: [{ ...file, filename }] })).toThrow('filename');
  });
  it.each(['', 'dGVzdA', 'dGVz$dA==', 'data:text/plain;base64,dGVzdA=='])('rejects invalid base64', data => {
    expect(() => parseReplySubmission(7, { ...draft(), attachments: [{ ...file, data }] })).toThrow();
  });
  it('enforces count and combined decoded size, not client size claims', () => {
    expect(() => parseReplySubmission(7, { ...draft(), attachments: Array(6).fill(file) })).toThrow('five');
    const large = { ...file, data: Buffer.alloc(3 * 1024 * 1024).toString('base64') };
    expect(() => parseReplySubmission(7, { ...draft(), attachments: [large, large] })).toThrow('5 MB');
    expect(() => parseReplySubmission(7, { ...draft(), attachments: [{ ...file, size: 1 }] })).toThrow('unsupported');
  });
  it('fingerprints message, body, and attachment bytes deterministically', () => {
    const first = parseReplySubmission(7, draft()).fingerprint;
    expect(parseReplySubmission(7, draft()).fingerprint).toBe(first);
    expect(parseReplySubmission(8, draft()).fingerprint).not.toBe(first);
    expect(parseReplySubmission(7, { ...draft(), body_text: 'Changed' }).fingerprint).not.toBe(first);
    expect(parseReplySubmission(7, { ...draft(), attachments: [{ ...file, data: 'bmV3' }] }).fingerprint).not.toBe(first);
  });
  it('escapes message HTML and preserves line breaks', () => {
    expect(replyTextToHtml('<img src="x">\r\nA & B')).toBe('<div>&lt;img src=&quot;x&quot;&gt;<br>A &amp; B</div>');
  });
});
