import { InboxService } from './inbox.service';

function fixture() {
  const db = {
    mail_accounts: { findFirst: jest.fn()
      .mockResolvedValueOnce({ id: 11 })
      .mockResolvedValue({ from_email: 'agent@example.invalid' }) },
    inbound_emails: {
      findFirst: jest.fn().mockResolvedValue({ id: 23, account_id: 11, from_email: 'lead@example.invalid', subject: 'Question' }),
      update: jest.fn(),
    },
  };
  return { db, service: new InboxService(db as never) };
}

describe('read-only inbox reply preparation', () => {
  it('uses a stored Reply-To address rather than silently replying to From', async () => {
    const { db, service } = fixture();
    db.inbound_emails.findFirst.mockResolvedValue({ id: 23, account_id: 11, from_email: 'lead@example.invalid', reply_to_email: 'reply@example.invalid', subject: 'Question' } as never);
    expect(await service.replyContext(7, 'crm', 23)).toMatchObject({ to: 'reply@example.invalid', recipient_source: 'reply-to' });
  });
  it('scopes message and original sender to the caller without read-state mutation or sending', async () => {
    const { db, service } = fixture();
    expect(await service.replyContext(7, 'crm', 23)).toEqual({
      message_id: 23, from: 'agent@example.invalid', to: 'lead@example.invalid',
      subject: 'Re: Question', recipient_source: 'sender', sending_enabled: false,
    });
    expect(db.inbound_emails.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 23, user_id: 7, account_id: 11 } }));
    expect(db.mail_accounts.findFirst).toHaveBeenLastCalledWith({
      where: { id: 11, user_id: 7, is_active: true }, select: { from_email: true },
    });
    expect(db.inbound_emails.update).not.toHaveBeenCalled();
  });
  it('returns the same generic absence for inaccessible messages', async () => {
    const { db, service } = fixture(); db.inbound_emails.findFirst.mockResolvedValue(null);
    await expect(service.replyContext(7, 'crm', 23)).rejects.toThrow('Message not found.');
    expect(db.mail_accounts.findFirst).toHaveBeenCalledTimes(1);
  });
  it('does not substitute another account when the original account is inactive or no longer owned', async () => {
    const { db, service } = fixture(); db.mail_accounts.findFirst.mockResolvedValue(null);
    await expect(service.replyContext(7, 'desk', 23)).rejects.toThrow('original sending account is unavailable');
  });
  it.each([null, 'a@example.invalid\r\nBcc: x@example.invalid', 'a@example.invalid,b@example.invalid', 'not-an-address'])('rejects unsafe sender %s', async from_email => {
    const { db, service } = fixture();
    db.inbound_emails.findFirst.mockResolvedValue({ id: 23, account_id: 11, from_email, subject: 'Question' });
    await expect(service.replyContext(7, 'crm', 23)).rejects.toThrow('valid sender and recipient');
  });
  it('cleans header control characters without duplicating Re prefixes', async () => {
    const { db, service } = fixture();
    db.inbound_emails.findFirst.mockResolvedValue({ id: 23, account_id: 11, from_email: 'lead@example.invalid', subject: 'Re: Question\r\nTest' });
    expect(await service.replyContext(7, 'crm', 23)).toMatchObject({ subject: 'Re: Question  Test' });
  });
  it.each([0, -1, NaN, 1.5])('rejects invalid identifier %s before querying', async id => {
    const { db, service } = fixture();
    await expect(service.replyContext(7, 'crm', id)).rejects.toThrow('Message not found.');
    expect(db.mail_accounts.findFirst).not.toHaveBeenCalled();
  });
});
