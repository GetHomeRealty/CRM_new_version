import { InboxReplyService } from './inbox-reply.service';

const key = '12345678-1234-4123-8123-123456789abc';
const input = { request_key: key, body_text: 'Hello <world>', attachments: [] };
function fixture() {
  const rows = new Map<string, any>();
  const identity = (where: any) => JSON.stringify(where.user_id_request_key);
  const db = {
    inbox_reply_submissions: {
      findUnique: jest.fn(async ({ where }) => rows.get(identity(where)) ?? null),
      create: jest.fn(async ({ data }) => {
        const k = JSON.stringify({ user_id: data.user_id, request_key: data.request_key });
        if (rows.has(k)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        rows.set(k, { ...data }); return data;
      }),
      update: jest.fn(async ({ where, data }) => { const row = { ...rows.get(identity(where)), ...data }; rows.set(identity(where), row); return row; }),
    },
    inbound_emails: { findFirst: jest.fn().mockResolvedValue({ account_id: 11, message_id: '<original@example.invalid>' }) },
  };
  const inbox = { replyContext: jest.fn().mockResolvedValue({ to: 'lead@example.invalid', subject: 'Re: Test' }) };
  const mailer = { sendOwnedReplyOnce: jest.fn().mockResolvedValue(undefined) };
  return { db, inbox, mailer, service: new InboxReplyService(db as never, inbox as never, mailer as never) };
}
describe('reply receipts and recovery (mock database and transport)', () => {
  const previous = process.env.INBOX_REPLY_SENDING_ENABLED;
  beforeEach(() => { process.env.INBOX_REPLY_SENDING_ENABLED = 'true'; });
  afterEach(() => { if (previous === undefined) delete process.env.INBOX_REPLY_SENDING_ENABLED; else process.env.INBOX_REPLY_SENDING_ENABLED = previous; });
  it('allows only one transport invocation for concurrent identical submissions', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 4 }, () => f.service.submit(7, 'crm', 23, input)));
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
    expect(await f.service.recover(7, key)).toMatchObject({ status: 'accepted' });
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledWith(7, 11, 'lead@example.invalid', 'Re: Test', '<div>Hello &lt;world&gt;</div>', [], '<original@example.invalid>');
  });
  it('rejects changed payloads and isolates recovery to the sender', async () => {
    const f = fixture(); await f.service.submit(7, 'crm', 23, input);
    await expect(f.service.submit(7, 'crm', 23, { ...input, body_text: 'different' })).rejects.toThrow('different reply');
    await expect(f.service.recover(8, key)).rejects.toThrow('not found');
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain sends non-retryable across service restarts', async () => {
    const f = fixture(); f.mailer.sendOwnedReplyOnce.mockRejectedValue(new Error('private SMTP detail'));
    expect(await f.service.submit(7, 'crm', 23, input)).toMatchObject({ status: 'uncertain' });
    const restarted = new InboxReplyService(f.db as never, f.inbox as never, f.mailer as never);
    expect(await restarted.submit(7, 'crm', 23, input)).toMatchObject({ status: 'uncertain' });
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
  });
  it('retains pending when recording SMTP acceptance fails; repeat never sends again', async () => {
    const f = fixture(); f.db.inbox_reply_submissions.update.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.submit(7, 'crm', 23, input)).rejects.toThrow('database unavailable');
    expect(await f.service.submit(7, 'crm', 23, input)).toMatchObject({ status: 'pending' });
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
  });
  it('fails closed when disabled or message access is denied', async () => {
    const f = fixture(); process.env.INBOX_REPLY_SENDING_ENABLED = 'false';
    await expect(f.service.submit(7, 'crm', 23, input)).rejects.toThrow('not enabled');
    process.env.INBOX_REPLY_SENDING_ENABLED = 'true'; f.inbox.replyContext.mockRejectedValue(new Error('Message not found.'));
    await expect(f.service.submit(7, 'crm', 23, input)).rejects.toThrow('not found');
    expect(f.db.inbox_reply_submissions.create).not.toHaveBeenCalled();
    expect(f.mailer.sendOwnedReplyOnce).not.toHaveBeenCalled();
  });
  it('composes from the owned primary mailbox and binds recipient changes to the key', async () => {
    const f = fixture();
    (f.inbox as any).composeContext = jest.fn().mockResolvedValue({ account_id: 11 });
    const draft = { ...input, to: 'new@example.invalid', subject: 'New message' };
    await f.service.submit(7, 'crm', 0, draft);
    expect(f.mailer.sendOwnedReplyOnce).toHaveBeenCalledWith(7, 11, 'new@example.invalid', 'New message', '<div>Hello &lt;world&gt;</div>', [], null);
    expect(f.db.inbound_emails.findFirst).not.toHaveBeenCalled();
    await expect(f.service.submit(7, 'crm', 0, { ...draft, to: 'other@example.invalid' })).rejects.toThrow('different reply');
  });
});
