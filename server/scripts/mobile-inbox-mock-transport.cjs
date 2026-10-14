// Explicit preload for isolated native UI testing. Never loaded by normal startup.
const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.NODE_ENV !== 'test' || url.hostname !== '127.0.0.1' || url.pathname !== '/gh_mobile_test' || process.env.RUN_SCHEDULERS !== 'false') {
  throw new Error('Mock inbox transport requires the isolated local mobile test environment.');
}
const { MailerService } = require('../src/email/mailer.service');
MailerService.prototype.sendOwnedReplyOnce = async function (_userId, _accountId, _to, _subject, _html, attachments) {
  // No SMTP client, credentials, or recipient content leave this process.
  process.stdout.write(`LOCAL_INBOX_MOCK_ACCEPTED attachments=${attachments.length}\n`);
};
