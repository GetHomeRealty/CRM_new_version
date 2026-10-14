import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MailArchiveController } from './mail-archive.controller';
import { InboxReplyService } from './inbox-reply.service';
import { InboxService } from './inbox.service';
import { archiveFiles } from './mail-archive';

const url = process.env.INBOX_TEST_DATABASE_URL;
const allowed = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/gh_mobile_test';
(allowed ? describe : describe.skip)('mail archive local database integration (rollback, mocked delivery)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url || 'postgresql://localhost/unused' } } });
  const previousArchive = process.env.INBOX_ARCHIVE_ENABLED, previousSend = process.env.INBOX_REPLY_SENDING_ENABLED;
  beforeAll(() => { process.env.INBOX_ARCHIVE_ENABLED = 'true'; process.env.INBOX_REPLY_SENDING_ENABLED = 'true'; });
  afterAll(async () => {
    await db.$disconnect();
    if (previousArchive === undefined) delete process.env.INBOX_ARCHIVE_ENABLED; else process.env.INBOX_ARCHIVE_ENABLED = previousArchive;
    if (previousSend === undefined) delete process.env.INBOX_REPLY_SENDING_ENABLED; else process.env.INBOX_REPLY_SENDING_ENABLED = previousSend;
  });
  it('captures before sending, lists only accepted own messages and downloads own archived attachments', async () => {
    const rollback = new Error('ROLLBACK_ARCHIVE_TEST');
    try {
      await db.$transaction(async tx => {
        const user = await tx.users.create({ data: { name: 'Archive test only', email: `${randomUUID()}@example.invalid`, password: 'unused', role: 'Agent' } });
        const account = await tx.mail_accounts.create({ data: { name: 'Synthetic', user_id: user.id, from_email: 'agent@example.invalid', host: 'smtp.example.invalid', port: 587, is_active: true, is_default: true } });
        const inbound = await tx.inbound_emails.create({ data: { user_id: user.id, account_id: account.id, uid: 1, from_email: 'lead@example.invalid', received_at: new Date(), attachments: archiveFiles([{ filename: 'test.pdf', content: Buffer.from('%PDF-test') }]) } });
        const key = randomUUID();
        const transport = jest.fn(async () => {
          const pending = await tx.inbox_reply_submissions.findUniqueOrThrow({ where: { user_id_request_key: { user_id: user.id, request_key: key } } });
          expect(pending.status).toBe('pending');
          expect(pending.snapshot).toMatchObject({ body_text: 'Synthetic archive test' });
        });
        const service = new InboxReplyService(tx as never, new InboxService(tx as never), { sendOwnedReplyOnce: transport } as never);
        await service.submit(user.id, 'crm', inbound.id, { request_key: key, body_text: 'Synthetic archive test', attachments: [{ filename: 'safe.txt', content_type: 'text/plain', data: 'dGVzdA==' }] });
        const archive = new MailArchiveController(tx as never), identity = { id: user.id } as never;
        const page = await archive.sent(identity, 'crm');
        expect(page.data.map(row => row.id)).toEqual([key]);
        expect(page.data[0]).not.toHaveProperty('snapshot');
        expect(await archive.sentDetail(identity, key, 'crm')).toMatchObject({ body_text: 'Synthetic archive test', content_available: true });
        expect(await archive.sentAttachment(identity, key, 0, 'crm')).toMatchObject({ data: 'dGVzdA==', filename: 'attachment-1.bin' });
        expect(await archive.inboundAttachment(identity, inbound.id, 0, 'crm')).toMatchObject({ filename: 'attachment-1.pdf' });
        await expect(archive.sentDetail({ id: user.id + 100000 } as never, key, 'crm')).rejects.toThrow('not found');
        await expect(archive.inboundAttachment({ id: user.id + 100000 } as never, inbound.id, 0, 'crm')).rejects.toThrow('not found');
        await tx.inbox_reply_submissions.update({ where: { user_id_request_key: { user_id: user.id, request_key: key } }, data: { status: 'uncertain' } });
        expect((await archive.sent(identity, 'crm')).data).toHaveLength(0);
        expect(transport).toHaveBeenCalledTimes(1);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  });
});
