import { InboxService } from './inbox.service';

/**
 * TD-171 - marking a message read or unread works in every mailbox the Inbox screen can open, not
 * only the default one. Prisma is stubbed: the question is which accounts the lookup allows.
 */
describe('mark as read reaches every mailbox the area can open (TD-171)', () => {
  const make = (messageAccount: number, areaAccounts: number[]) => {
    const updated: Array<Record<string, unknown>> = [];
    const prisma = {
      mail_accounts: { findMany: async () => areaAccounts.map((id) => ({ id })) },
      inbound_emails: {
        findFirst: async (a: { where: { id: number; account_id?: { in?: number[] } } }) =>
          (a.where.account_id?.in?.includes(messageAccount) ? { id: a.where.id } : null),
        update: async (a: { data: Record<string, unknown> }) => { updated.push(a.data); return {}; },
      },
    } as never;
    return { svc: new InboxService(prisma), updated };
  };

  it('marks a message in a second, non-default mailbox', async () => {
    const { svc, updated } = make(7, [5, 7]);
    await expect(svc.markSeen(1, 'crm', 99, true)).resolves.toEqual({ seen: true });
    expect(updated).toEqual([{ seen: true }]);
  });

  it('still refuses a message in a mailbox this area cannot open, and writes nothing', async () => {
    const { svc, updated } = make(9, [5, 7]);
    await expect(svc.markSeen(1, 'crm', 99, true)).rejects.toThrow();
    expect(updated).toEqual([]);
  });
});
