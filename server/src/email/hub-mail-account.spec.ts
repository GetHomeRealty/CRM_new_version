import { emailLimitFor } from './agent-email-limit';
import { MailAccountService } from './mail-account.service';

describe('Hub-wide personal email accounts', () => {
  it('lists the same personal accounts regardless of the requesting area', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { mail_accounts: { findMany } };
    const service = new MailAccountService(prisma as never, {} as never);

    await service.indexForUser(42, 'crm');
    await service.indexForUser(42, 'desk');

    expect(findMany).toHaveBeenNthCalledWith(1, { where: { user_id: 42 } });
    expect(findMany).toHaveBeenNthCalledWith(2, { where: { user_id: 42 } });
  });

  it('uses the user primary mailbox across both areas', async () => {
    const account = { id: 7, user_id: 42, is_active: true, is_default: true };
    const findFirst = jest.fn().mockResolvedValue(account);
    const prisma = { mail_accounts: { findFirst } };
    const service = new MailAccountService(prisma as never, {} as never);

    await expect(service.senderFor(42, 'desk')).resolves.toBe(account);
    expect(findFirst).toHaveBeenCalledWith({
      where: { user_id: 42, is_active: true, is_default: true },
    });
  });

  it('counts an agent mailbox once across the whole Hub', async () => {
    const prisma = {
      users: { findUnique: jest.fn().mockResolvedValue({ role: 'agent' }) },
      mail_accounts: { count: jest.fn().mockResolvedValue(1) },
    };

    await expect(emailLimitFor(prisma as never, 42, 'crm')).resolves.toEqual({
      max: 1, used: 1, canAdd: false,
    });
    expect(prisma.mail_accounts.count).toHaveBeenCalledWith({ where: { user_id: 42 } });
  });
});
