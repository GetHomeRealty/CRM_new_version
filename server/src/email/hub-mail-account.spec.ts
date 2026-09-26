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
    /*
     * THIS BROKERAGE HAS CHOSEN NO PRIMARY, which is what the double has to say now that `senderFor`
     * asks. It previously answered every query with `account`, so once the brokerage lookup was added
     * ahead of the personal one the method returned at the first call and the assertion below — on a
     * call that no longer happened — failed. Returning `account` for a query about the brokerage's
     * own mailboxes would have been a false statement about the database either way.
     *
     * Answering null here also pins the property that matters to this file: with no primary set, a
     * person's mailbox is still used on both sides, and the area is not part of the question.
     */
    const findFirst = jest.fn(({ where }: { where: { user_id: number | null } }) =>
      Promise.resolve(where.user_id === null ? null : account));
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
