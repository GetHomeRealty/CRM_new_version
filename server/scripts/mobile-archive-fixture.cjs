// Synthetic simulator fixture only. No transport is invoked.
const { PrismaClient } = require('@prisma/client');
const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/gh_mobile_test' || process.env.NODE_ENV !== 'test') throw new Error('Local test database required');
const db = new PrismaClient();
const key = 'a1000000-0000-4000-8000-000000000004';
async function main() {
  const account = await db.mail_accounts.findFirst({ where: { user_id: 1, from_email: 'agent@example.invalid', is_default: true } });
  if (!account) throw new Error('Synthetic default mailbox required');
  const attachments = { total: 2, files: [
    { name: 'Synthetic test note.txt', mime: 'application/octet-stream', size: 4, data: 'dGVzdA==' },
    { name: 'Oversize sample.pdf', mime: 'application/octet-stream', size: 6291456, unavailable: 'Not stored: exceeds the 5 MB message attachment limit.' },
  ] };
  const snapshot = { to: 'test@example.invalid', subject: 'LOCAL QA — archived message (not sent)', body_text: 'Synthetic inbox archive preview. No email was delivered.', account_id: account.id, attachments };
  await db.inbox_reply_submissions.upsert({ where: { user_id_request_key: { user_id: 1, request_key: key } },
    create: { user_id: 1, request_key: key, fingerprint: 'synthetic-ui-fixture', message_id: 0, status: 'accepted', snapshot }, update: { snapshot } });
  const existing = await db.inbound_emails.findFirst({ where: { user_id: 1, account_id: account.id, subject: 'LOCAL QA — incoming attachments' } });
  if (!existing) await db.inbound_emails.create({ data: { user_id: 1, account_id: account.id, uid: 1900000004, subject: 'LOCAL QA — incoming attachments', from_email: 'test@example.invalid', body_text: 'Synthetic local-only attachment preview.', received_at: new Date(), attachments } });
  console.log('Synthetic local Sent and incoming attachment fixtures ready. No email sent.');
}
main().finally(() => db.$disconnect());
