import { NotificationCenterService } from './notification-center.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * Deleting, dismissing and un-reading a notification.
 *
 * THE RULE THESE TESTS EXIST TO ENFORCE. The Centre shows five sources, and only one of them —
 * `direct` — is this application's own record. The other four are WINDOWS onto `audit_logs`,
 * `transaction_reminders` and the review trail: rows that are the brokerage's history, referenced
 * by screens with nothing to do with notifications, and in the audit log's case the one thing in
 * this application that must never be edited to suit a list.
 *
 * So "delete" means delete for `direct` and dismiss for everything else, and "mark unread" is
 * refused outright for a projection — un-setting `handled` on an audit row would not mark a
 * notification unread, it would record that a document review was never looked at.
 *
 * A "Clear all" that got this wrong would be the most destructive button in the application, and it
 * would look like housekeeping.
 */

const me = { id: 7, name: 'Dana Okafor' } as unknown as ResourceUser;

function harness() {
  const calls = { deleteMany: [] as unknown[], updateMany: [] as unknown[] };
  const prisma = {
    notifications: {
      deleteMany: async (args: Record<string, unknown>) => { calls.deleteMany.push(args); return { count: 1 }; },
      updateMany: async (args: Record<string, unknown>) => { calls.updateMany.push(args); return { count: 1 }; },
    },
  } as unknown as PrismaService;

  const svc = new NotificationCenterService(
    prisma, null as never, null as never, null as never,
  );
  return { svc, calls };
}

describe('mark as unread', () => {
  it('works for a direct notification, scoped to the caller', async () => {
    const { svc, calls } = harness();
    await expect(svc.markUnread(me, 'direct', 42)).resolves.toEqual({ ok: true, supported: true });

    const where = (calls.updateMany[0] as { where: Record<string, unknown> }).where;
    // The scope is IN THE UPDATE, so guessing another person's id changes nothing.
    expect(where.user_id).toBe(7);
    expect(where.id).toBe(42);
  });

  it('is refused for every projected source, rather than silently doing nothing', async () => {
    const { svc, calls } = harness();
    for (const source of ['agent-change', 'doc-review', 'review-decision', 'reminder'] as const) {
      await expect(svc.markUnread(me, source, 42)).resolves.toEqual({ ok: false, supported: false });
    }
    // Nothing was written for any of them — the refusal is not a failed attempt.
    expect(calls.updateMany).toHaveLength(0);
  });

  it('does nothing without a user', async () => {
    const { svc, calls } = harness();
    await expect(svc.markUnread(null, 'direct', 42)).resolves.toEqual({ ok: false, supported: false });
    expect(calls.updateMany).toHaveLength(0);
  });
});

describe('removing one notification', () => {
  it('DELETES a direct notification, scoped to the caller', async () => {
    const { svc, calls } = harness();
    await expect(svc.remove(me, 'direct', 42)).resolves.toEqual({ ok: true, deleted: true, dismissed: false });

    expect(calls.deleteMany).toHaveLength(1);
    const where = (calls.deleteMany[0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ id: 42, user_id: 7 });
  });

  it('DISMISSES a projected notification and deletes nothing', async () => {
    /*
     * The important assertion is `deleteMany` staying empty. An audit-log row behind a document
     * review is history; removing it to clear a list would destroy a record somebody may later have
     * to produce.
     */
    const marked: unknown[] = [];
    const { svc, calls } = harness();
    (svc as unknown as { markRead: unknown }).markRead = async (...args: unknown[]) => {
      marked.push(args); return { ok: true };
    };

    await expect(svc.remove(me, 'doc-review', 99)).resolves.toEqual({ ok: true, deleted: false, dismissed: true });
    expect(calls.deleteMany).toHaveLength(0);
    expect(marked).toHaveLength(1);
  });

  it('does nothing without a user', async () => {
    const { svc, calls } = harness();
    await expect(svc.remove(null, 'direct', 42)).resolves.toEqual({ ok: false, deleted: false, dismissed: false });
    expect(calls.deleteMany).toHaveLength(0);
  });
});

describe('clear all', () => {
  it('deletes only this user\'s own rows, and dismisses the rest', async () => {
    const { svc, calls } = harness();
    (svc as unknown as { markAllRead: unknown }).markAllRead = async () => ({ ok: true, marked: 3, failed: 0 });

    await expect(svc.clearAll(me)).resolves.toEqual({ deleted: 1, dismissed: 3 });

    // One delete, and its where clause names this user — never a bare deleteMany.
    expect(calls.deleteMany).toHaveLength(1);
    expect((calls.deleteMany[0] as { where: Record<string, unknown> }).where).toEqual({ user_id: 7 });
  });

  it('never issues an unscoped delete', async () => {
    const { svc, calls } = harness();
    (svc as unknown as { markAllRead: unknown }).markAllRead = async () => ({ ok: true, marked: 0, failed: 0 });
    await svc.clearAll(me);

    for (const call of calls.deleteMany) {
      const where = (call as { where?: Record<string, unknown> }).where;
      expect(where).toBeDefined();
      expect(where!.user_id).toBe(7);
    }
  });

  it('does nothing without a user', async () => {
    const { svc, calls } = harness();
    await expect(svc.clearAll(null)).resolves.toEqual({ deleted: 0, dismissed: 0 });
    expect(calls.deleteMany).toHaveLength(0);
  });
});
