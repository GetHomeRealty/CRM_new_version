import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { InboxReplyService } from './inbox-reply.service';
import { InboxService } from './inbox.service';

const url = process.env.INBOX_TEST_DATABASE_URL;
const allowed = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/gh_mobile_test';
const suite = allowed ? describe : describe.skip;
suite('reply receipts against isolated local PostgreSQL (delivery mocked)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url || 'postgresql://localhost/unused' } } });
  const keys: string[] = [];
  const previous = process.env.INBOX_REPLY_SENDING_ENABLED;
  const transport = jest.fn().mockResolvedValue(undefined);
  const adapter = { inbox_reply_submissions: db.inbox_reply_submissions,
    inbound_emails: { findFirst: async () => ({ account_id: 11, message_id: '<test@example.invalid>' }) } };
  const service = () => new InboxReplyService(adapter as never,
    { replyContext: async () => ({ to: 'test@example.invalid', subject: 'Test only' }) } as never,
    { sendOwnedReplyOnce: transport } as never);
  const input = () => { const key = randomUUID(); keys.push(key); return { request_key: key, body_text: 'Never deliver' }; };
  beforeAll(() => { process.env.INBOX_REPLY_SENDING_ENABLED = 'true'; });
  afterAll(async () => {
    // Only this test run's tracked random keys. Never clear other receipts.
    await db.inbox_reply_submissions.deleteMany({ where: { user_id: 1, request_key: { in: keys } } });
    await db.$disconnect();
    if (previous === undefined) delete process.env.INBOX_REPLY_SENDING_ENABLED; else process.env.INBOX_REPLY_SENDING_ENABLED = previous;
  });
  beforeEach(() => { transport.mockReset().mockResolvedValue(undefined); });
  it('unique constraint admits one sender across simultaneous service instances', async () => {
    const draft = input();
    await Promise.all(Array.from({ length: 6 }, () => service().submit(1, 'crm', 23, draft)));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await db.inbox_reply_submissions.count({ where: { user_id: 1, request_key: draft.request_key } })).toBe(1);
    expect(await service().recover(1, draft.request_key)).toMatchObject({ status: 'accepted' });
    await expect(service().recover(2, draft.request_key)).rejects.toThrow('not found');
    await expect(service().submit(1, 'crm', 23, { ...draft, body_text: 'changed' })).rejects.toThrow('different reply');
  });
  it('uncertain SMTP results survive restart without replay', async () => {
    const draft = input(); transport.mockRejectedValue(new Error('timeout'));
    expect(await service().submit(1, 'crm', 23, draft)).toMatchObject({ status: 'uncertain' });
    expect(await service().submit(1, 'crm', 23, draft)).toMatchObject({ status: 'uncertain' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('a persisted pending receipt is never automatically taken over after a crash', async () => {
    const draft = input();
    await service().submit(1, 'crm', 23, draft);
    await db.inbox_reply_submissions.update({ where: { user_id_request_key: { user_id: 1, request_key: draft.request_key } }, data: { status: 'pending' } });
    transport.mockClear();
    expect(await service().submit(1, 'crm', 23, draft)).toMatchObject({ status: 'pending' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('real mailbox ownership, Reply-To, compose and attachment mapping work together', async () => {
    const rollback = 'INBOX_TEST_ROLLBACK';
    try {
      await db.$transaction(async tx => {
        const user = await tx.users.create({ data: { name: 'Isolated inbox test', email: `${randomUUID()}@example.invalid`, password: 'unused', role: 'Agent' } });
        const account = await tx.mail_accounts.create({ data: { name: 'Synthetic owned mailbox', user_id: user.id, from_email: 'agent@example.invalid', host: 'smtp.example.invalid', port: 587, is_active: true, is_default: true } });
        const message = await tx.inbound_emails.create({ data: { user_id: user.id, account_id: account.id, uid: 1, from_email: 'from@example.invalid', reply_to_email: 'reply@example.invalid', subject: 'Hello', received_at: new Date() } });
        const inbox = new InboxService(tx as never);
        const service = new InboxReplyService(tx as never, inbox, { sendOwnedReplyOnce: transport } as never);
        const attachment = { filename: 'test.txt', content_type: 'text/plain', data: 'dGVzdA==' };
        await service.submit(user.id, 'crm', message.id, { request_key: randomUUID(), body_text: 'Reply test', attachments: [attachment] });
        expect(transport).toHaveBeenLastCalledWith(user.id, account.id, 'reply@example.invalid', 'Re: Hello', '<div>Reply test</div>', [{ name: 'test.txt', mime: 'text/plain', data: 'dGVzdA==' }], null);
        await service.submit(user.id, 'crm', 0, { request_key: randomUUID(), to: 'new@example.invalid', subject: 'New email', body_text: 'Compose test', attachments: [attachment] });
        expect(transport).toHaveBeenLastCalledWith(user.id, account.id, 'new@example.invalid', 'New email', '<div>Compose test</div>', [{ name: 'test.txt', mime: 'text/plain', data: 'dGVzdA==' }], null);
        await expect(inbox.replyContext(user.id + 100000, 'crm', message.id)).rejects.toThrow('Message not found');
        expect(transport).toHaveBeenCalledTimes(2);
        throw new Error(rollback);
      });
    } catch (error) { if ((error as Error).message !== rollback) throw error; }
  });
});
