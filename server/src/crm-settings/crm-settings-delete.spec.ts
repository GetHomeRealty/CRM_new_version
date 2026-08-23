import { CrmSettingsService } from './crm-settings.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Deleting a broadcast, and deleting a send-log row.
 *
 * Both are HARD deletes — neither table carries a `deleted_at` — so the two rules that stop them
 * being destructive in the wrong way are the only thing between "remove a row I no longer need"
 * and "erase evidence, or erase somebody else's".
 *
 *   A SEND STILL IN FLIGHT MUST BE REFUSED. Delivery runs off the request thread and writes
 *   progress back after every recipient. Deleting mid-send leaves that loop updating a row that no
 *   longer exists and destroys the only record of how far it reached.
 *
 *   DELETION MUST NOT REACH FURTHER THAN READING. `listLog` narrows to the caller's own sends
 *   unless they may read everyone's. If delete did not re-apply that, an id absent from somebody's
 *   list would still be removable by guessing the number.
 */

const NOW = new Date('2026-08-22T10:00:00Z');
const agent = { id: 7, name: 'Dana Okafor', role: 'agent', user_permissions: [] } as unknown as AuthUserRecord;

function auditSink() {
  const written: Record<string, unknown>[] = [];
  return { written, audit_logs: { create: async ({ data }: { data: Record<string, unknown> }) => { written.push(data); return data; } } };
}

describe('deleting a broadcast', () => {
  function service(row: Record<string, unknown> | null) {
    const sink = auditSink();
    const deleted: number[] = [];
    const prisma = {
      audit_logs: sink.audit_logs,
      crm_broadcasts: {
        findUnique: async () => row,
        delete: async ({ where }: { where: { id: number } }) => { deleted.push(where.id); return row; },
      },
    } as unknown as PrismaService;
    return { svc: new CrmSettingsService(prisma, null as never, null as never), deleted, audit: sink.written };
  }

  const finished = {
    id: 4, message: 'Office closed Monday', status: 'completed',
    attempted: 31, recipients: 31, created_at: NOW,
  };

  it('removes a finished broadcast', async () => {
    const { svc, deleted } = service(finished);
    await expect(svc.deleteBroadcast(agent, 4)).resolves.toEqual({ deleted: true });
    expect(deleted).toEqual([4]);
  });

  it('refuses one that is still going out, and deletes nothing', async () => {
    const { svc, deleted } = service({ ...finished, status: 'sending', recipients: 12 });
    await expect(svc.deleteBroadcast(agent, 4)).rejects.toThrow(/still going out/i);
    expect(deleted).toEqual([]);
  });

  it('records the deletion, so removing the row does not remove the fact', async () => {
    const { svc, audit } = service(finished);
    await svc.deleteBroadcast(agent, 4);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('CRM broadcast deleted');
    expect(String(audit[0].details)).toContain('Office closed Monday');
    expect(audit[0].who).toBe('Dana Okafor');
  });

  it('says so plainly when the row has already gone', async () => {
    const { svc } = service(null);
    await expect(svc.deleteBroadcast(agent, 4)).rejects.toThrow(/no longer exists/i);
  });
});

describe('deleting a CRM send-log entry', () => {
  function service(row: Record<string, unknown> | null) {
    const sink = auditSink();
    const deleted: number[] = [];
    const prisma = {
      audit_logs: sink.audit_logs,
      crm_email_log: {
        findUnique: async () => row,
        delete: async ({ where }: { where: { id: number } }) => { deleted.push(where.id); return row; },
      },
    } as unknown as PrismaService;
    const svc = new CrmAdvancedEmailService(prisma, null as never, null as never, null as never);
    return { svc, deleted, audit: sink.written };
  }

  const mine = {
    id: 12, kind: 'custom', recipient: 'client@example.test', subject: 'Following up',
    sent_by: 'Dana Okafor', created_at: NOW,
  };

  it('refuses a row belonging to somebody else — and does not confirm it exists', async () => {
    const { svc, deleted } = service({ ...mine, sent_by: 'Priya Raman' });
    /*
     * "No longer exists" rather than "forbidden" on purpose: a distinct refusal would tell an
     * agent that a log row with that id is there and simply not theirs, which is precisely what
     * `listLog`'s filtering already refuses to reveal.
     */
    await expect(svc.deleteLogEntry(agent, 12)).rejects.toThrow(/no longer exists/i);
    expect(deleted).toEqual([]);
  });

  it('refuses a row that is not there at all, with the same words', async () => {
    const { svc } = service(null);
    await expect(svc.deleteLogEntry(agent, 12)).rejects.toThrow(/no longer exists/i);
  });

  it('the ownership check runs BEFORE the row is touched', async () => {
    // Guards the ordering: if the delete ever moved above the check, this would still pass on the
    // message alone. Asserting nothing was deleted is what makes the test about the rule.
    const { svc, deleted, audit } = service({ ...mine, sent_by: 'Someone Else' });
    await expect(svc.deleteLogEntry(agent, 12)).rejects.toThrow();
    expect(deleted).toEqual([]);
    expect(audit).toHaveLength(0);
  });
});
