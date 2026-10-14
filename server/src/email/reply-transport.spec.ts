import * as nodemailer from 'nodemailer';
import { MailerService } from './mailer.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
function fixture() {
  const sendMail = jest.fn().mockResolvedValue({});
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
  const db = { mail_accounts: { findFirst: jest.fn().mockResolvedValue({ id: 11, user_id: 7, from_email: 'agent@example.invalid', host: 'localhost', port: 587 }) } };
  const service = new MailerService(db as never, {} as never, {} as never);
  return { db, sendMail, service };
}
describe('owned reply transport (SMTP completely mocked)', () => {
  beforeEach(() => jest.clearAllMocks());
  it('uses an active owned account and preserves validated threading headers', async () => {
    const f = fixture();
    await f.service.sendOwnedReplyOnce(7, 11, 'lead@example.invalid', 'Re: Test', '<div>Hello</div>', [], '<original@example.invalid>');
    expect(f.db.mail_accounts.findFirst).toHaveBeenCalledWith({ where: { id: 11, user_id: 7, is_active: true } });
    expect(f.sendMail).toHaveBeenCalledTimes(1);
    expect(f.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'agent@example.invalid', headers: { 'In-Reply-To': '<original@example.invalid>', References: '<original@example.invalid>' } }));
  });
  it('does not fall back when the owned account is unavailable', async () => {
    const f = fixture(); f.db.mail_accounts.findFirst.mockResolvedValue(null);
    await expect(f.service.sendOwnedReplyOnce(7, 11, 'lead@example.invalid', 'Test', 'Hello', [])).rejects.toThrow('unavailable');
    expect(f.db.mail_accounts.findFirst).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it('never retries an uncertain SMTP outcome', async () => {
    const f = fixture(); f.sendMail.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await expect(f.service.sendOwnedReplyOnce(7, 11, 'lead@example.invalid', 'Test', 'Hello', [])).rejects.toThrow('timeout');
    expect(f.sendMail).toHaveBeenCalledTimes(1);
  });
  it('does not forward unsafe stored threading headers', async () => {
    const f = fixture();
    await f.service.sendOwnedReplyOnce(7, 11, 'lead@example.invalid', 'Test', 'Hello', [], '<x@y>\r\nBcc: x@y');
    expect(f.sendMail.mock.calls[0][0].headers).toBeUndefined();
  });
});
