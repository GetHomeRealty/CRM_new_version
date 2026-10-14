import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface ReplySubmission {
  requestKey: string;
  bodyText: string;
  attachments: { name: string; mime: string; data: string }[];
  fingerprint: string;
}

export function inboxAddress(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('Enter one valid email address.');
  const address = value.trim();
  if (address.length > 254 || !/^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(address) || /[\x00-\x1f\x7f]/.test(address)) throw new BadRequestException('Enter one valid email address.');
  return address;
}

export function parseComposeSubmission(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid message.');
  const { to, subject, ...rest } = input as Record<string, unknown>;
  const recipient = inboxAddress(to);
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 255 || /[\x00-\x1f\x7f]/.test(subject)) throw new BadRequestException('Enter a subject of 1–255 characters without line breaks.');
  const draft = parseReplySubmission(1, rest);
  draft.fingerprint = createHash('sha256').update(JSON.stringify(['compose', recipient, subject.trim(), draft.fingerprint])).digest('hex');
  return { ...draft, to: recipient, subject: subject.trim() };
}

/** The client cannot choose From, To, SMTP headers, account or original message ID.
 * Those must be derived from the authorized message at send time.
 * This validator does not send, enqueue, or claim a submission receipt.
 */
export function parseReplySubmission(messageId: number, input: unknown): ReplySubmission {
  const invalid = (message: string): never => { throw new BadRequestException(message); };
  if (!Number.isSafeInteger(messageId) || messageId < 1) invalid('Invalid message identifier.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid reply.');
  const data = input as Record<string, unknown>;
  const allowed = new Set(['request_key', 'body_text', 'attachments']);
  if (Object.keys(data).some(key => !allowed.has(key))) invalid('Reply contains unsupported fields.');
  if (typeof data.request_key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.request_key)) {
    invalid('A valid submission key is required.');
  }
  if (typeof data.body_text !== 'string' || !data.body_text.trim() || data.body_text.length > 20000 || data.body_text.includes('\0')) {
    invalid('Enter a message of 1–20,000 characters.');
  }
  const files = data.attachments ?? [];
  if (!Array.isArray(files) || files.length > 5) invalid('A maximum of five attachments is allowed.');
  let total = 0;
  const attachments = (files as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid attachment.');
    const file = value as Record<string, unknown>;
    if (Object.keys(file).some(key => !['filename', 'content_type', 'data'].includes(key))) invalid('Attachment contains unsupported fields.');
    if (typeof file.filename !== 'string' || !file.filename.trim() || file.filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(file.filename)) invalid('Invalid attachment filename.');
    if (typeof file.content_type !== 'string' || file.content_type.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.content_type)) invalid('Invalid attachment type.');
    if (typeof file.data !== 'string' || !file.data.length || file.data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) invalid('Attachments must total no more than 5 MB.');
    const encoded = file.data as string;
    // Check canonical encoding, not Buffer's permissive decoder (which ignores invalid bytes).
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded) invalid('Invalid attachment content.');
    total += bytes.length;
    if (total > 5 * 1024 * 1024) invalid('Attachments must total no more than 5 MB.');
    return { name: (file.filename as string).trim(), mime: file.content_type as string, data: encoded };
  });
  const bodyText = data.body_text as string;
  // Include attachment content, not merely filenames, in duplicate-request comparisons.
  const fingerprint = createHash('sha256').update(JSON.stringify([messageId, bodyText, attachments])).digest('hex');
  return { requestKey: (data.request_key as string).toLowerCase(), bodyText, attachments, fingerprint };
}

/** Plain text is escaped before using the existing HTML mail transport. */
export function replyTextToHtml(text: string): string {
  return `<div>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r\n|\r|\n/g, '<br>')}</div>`;
}
