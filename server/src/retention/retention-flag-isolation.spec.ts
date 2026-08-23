import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RetentionService } from './retention.service';
import { NotificationRetentionService } from '../notifications/notification-retention.service';

/**
 * Two retention sweeps, two switches, and neither may reach the other's.
 *
 * THE DEFECT. Both services read `RETENTION_ENABLED`. They are not comparable operations:
 *
 *   notification retention   clears `notifications` and `notification_deliveries` — expired signals
 *   Transaction Desk         deletes trashed deals and CASCADES into ~20 child tables, including
 *                            `transaction_reviews`, and removes `audit_logs` and
 *                            `transaction_reminders` BY AGE ALONE, live parents included
 *
 * So `RETENTION_ENABLED=true`, set to switch on notification housekeeping, also armed a purge of
 * Transaction Desk business records. The variable's name gave no hint of the second effect, and
 * production had it set. Nobody agreed to that; they agreed to the small one.
 *
 * WHAT THESE TESTS PIN DOWN. Each flag is exercised across the full matrix — both off, both
 * missing, each on alone — and asserted against BOTH services every time. A test that only checked
 * the service it was about would have passed happily while the flags were shared.
 *
 * The delete-scope cases run inside a rolled-back transaction, so nothing here touches real data.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const FLAGS = ['NOTIFICATION_RETENTION_ENABLED', 'DESK_RETENTION_ENABLED', 'RETENTION_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const f of FLAGS) { saved[f] = process.env[f]; delete process.env[f]; } });
afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f] as string;
  }
});

/** Both verdicts at once — the only shape that can catch one flag answering for the other. */
const verdicts = () => ({
  notification: NotificationRetentionService.enabled(),
  desk: new RetentionService(null as never, null as never).enabled(),
});

// =================================================================================================

describe('the switch matrix', () => {
  it('both variables MISSING — neither sweep may delete', () => {
    expect(process.env.NOTIFICATION_RETENTION_ENABLED).toBeUndefined();
    expect(process.env.DESK_RETENTION_ENABLED).toBeUndefined();
    // A destructive default has to be the one that does nothing.
    expect(verdicts()).toEqual({ notification: false, desk: false });
  });

  it('both explicitly false — neither sweep may delete', () => {
    process.env.NOTIFICATION_RETENTION_ENABLED = 'false';
    process.env.DESK_RETENTION_ENABLED = 'false';
    expect(verdicts()).toEqual({ notification: false, desk: false });
  });

  it('notification ON, desk OFF — the approved production configuration', () => {
    process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
    process.env.DESK_RETENTION_ENABLED = 'false';
    expect(verdicts()).toEqual({ notification: true, desk: false });
  });

  it('notification ON while desk is entirely ABSENT still leaves desk off', () => {
    // The real deployment shape: one flag is added, the other was never written.
    process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
    expect(verdicts()).toEqual({ notification: true, desk: false });
  });

  it('desk ON, notification OFF — the mirror case', () => {
    process.env.DESK_RETENTION_ENABLED = 'true';
    process.env.NOTIFICATION_RETENTION_ENABLED = 'false';
    expect(verdicts()).toEqual({ notification: false, desk: true });
  });

  it('desk ON while notification is ABSENT still leaves notification off', () => {
    process.env.DESK_RETENTION_ENABLED = 'true';
    expect(verdicts()).toEqual({ notification: false, desk: true });
  });
});

describe('the retired shared flag', () => {
  it('RETENTION_ENABLED=true enables NEITHER sweep', () => {
    /*
     * The heart of it. Production carries this value today, so a fallback to it — however
     * well-meant as a transition measure — would keep the Desk purge armed by exactly the setting
     * this separation exists to stop honouring.
     */
    process.env.RETENTION_ENABLED = 'true';
    expect(verdicts()).toEqual({ notification: false, desk: false });
  });

  it('does not interfere when the real flags are set', () => {
    process.env.RETENTION_ENABLED = 'true';
    process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
    process.env.DESK_RETENTION_ENABLED = 'false';
    expect(verdicts()).toEqual({ notification: true, desk: false });
  });
});

describe('malformed values fail CLOSED', () => {
  for (const v of ['', ' ', 'yes', '1', 'on', 'True!', 'enabled', 'null', 'undefined']) {
    it(`${JSON.stringify(v)} enables neither sweep`, () => {
      process.env.NOTIFICATION_RETENTION_ENABLED = v;
      process.env.DESK_RETENTION_ENABLED = v;
      expect(verdicts()).toEqual({ notification: false, desk: false });
    });
  }

  it('surrounding whitespace around a real value is still honoured', () => {
    process.env.NOTIFICATION_RETENTION_ENABLED = '  true  ';
    expect(verdicts().notification).toBe(true);
  });
});

describe('the months figure belongs to notification retention alone', () => {
  it('is read from NOTIFICATION_RETENTION_MONTHS and is independent of either switch', () => {
    const was = process.env.NOTIFICATION_RETENTION_MONTHS;
    try {
      process.env.NOTIFICATION_RETENTION_MONTHS = '6';
      process.env.DESK_RETENTION_ENABLED = 'true';
      expect(NotificationRetentionService.months()).toBe(6);
      expect(NotificationRetentionService.enabled()).toBe(false);
    } finally {
      if (was === undefined) delete process.env.NOTIFICATION_RETENTION_MONTHS;
      else process.env.NOTIFICATION_RETENTION_MONTHS = was;
    }
  });
});

// =================================================================================================

describe('with ONLY notification retention enabled, business records are untouched', () => {
  /**
   * The scope assertion the brief asks for, made against real rows rather than by reading the
   * queries. A transaction is created with the review and reminder history that the Desk sweep
   * would cascade away, then the notification sweep is run over data old enough to purge.
   */
  it('deletes notifications and ledger rows, and nothing else', async () => {
    await inRollback(async (tx) => {
      process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
      process.env.DESK_RETENTION_ENABLED = 'false';

      const t = tag();
      const now = new Date();
      const old = new Date(now.getTime() - 400 * 86400_000);   // well past any six-month cutoff

      const user = await tx.users.create({
        data: { name: `Ret ${t}`, email: `ret-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
      });

      // Business records, all older than the cutoff — the Desk sweep's targets.
      const txn = await tx.transactions.create({
        data: { trade_no: `RET-${t}`, type: 'sale', created_at: old, updated_at: old, deleted_at: old },
      });
      const reminder = await tx.transaction_reminders.create({
        data: { transaction_id: txn.id, kind: 'test', scheduled_for: old, delivery_method: 'email', delivery_status: 'sent', created_at: old },
      });
      const audit = await tx.audit_logs.create({
        data: { domain: 'desk', action: `retention-probe-${t}`, created_at: old },
      });

      // Notification records, equally old — the notification sweep's targets.
      const note = await tx.notifications.create({
        data: { user_id: user.id, category: 'lead_assigned', title: `probe ${t}`, body: 'x', created_at: old },
      });

      const before = {
        txn: await tx.transactions.count({ where: { id: txn.id } }),
        reminder: await tx.transaction_reminders.count({ where: { id: reminder.id } }),
        audit: await tx.audit_logs.count({ where: { id: audit.id } }),
        note: await tx.notifications.count({ where: { id: note.id } }),
      };
      expect(before).toEqual({ txn: 1, reminder: 1, audit: 1, note: 1 });

      const svc = new NotificationRetentionService(tx);
      const result = await svc.sweep(now);

      expect(result.skipped).toBe(false);                      // it really ran and really deleted
      expect(await tx.notifications.count({ where: { id: note.id } })).toBe(0);

      // Everything the brief forbids, asserted individually so a failure names the table.
      expect(await tx.transactions.count({ where: { id: txn.id } })).toBe(1);
      expect(await tx.transaction_reminders.count({ where: { id: reminder.id } })).toBe(1);
      expect(await tx.audit_logs.count({ where: { id: audit.id } })).toBe(1);
    });
  });

  it('a trashed transaction and its review survive — the Desk cascade never fires', async () => {
    await inRollback(async (tx) => {
      process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
      process.env.DESK_RETENTION_ENABLED = 'false';

      const t = tag();
      const now = new Date();
      const old = new Date(now.getTime() - 400 * 86400_000);
      // Trashed AND old: everything the Desk sweep needs to purge it and cascade into its children.
      const txn = await tx.transactions.create({
        data: { trade_no: `RET-${t}`, type: 'sale', created_at: old, updated_at: old, deleted_at: old },
      });
      const review = await tx.transaction_reviews.create({
        data: { transaction_id: txn.id, decision: 'approved', created_at: old, updated_at: old },
      });

      await new NotificationRetentionService(tx).sweep(now);

      expect(await tx.transactions.count({ where: { id: txn.id } })).toBe(1);
      expect(await tx.transaction_reviews.count({ where: { id: review.id } })).toBe(1);
    });
  });

  it('the live-occurrence protection still holds a ledger row past the cutoff', async () => {
    await inRollback(async (tx) => {
      process.env.NOTIFICATION_RETENTION_ENABLED = 'true';

      const t = tag();
      const now = new Date();
      const old = new Date(now.getTime() - 400 * 86400_000);
      const user = await tx.users.create({
        data: { name: `Ret ${t}`, email: `ret3-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
      });
      const lead = await tx.leads.create({
        data: { name: `Lead ${t}`, email: `lead-${t}@example.test`, created_at: now, updated_at: now },
      });
      // A follow-up nobody has completed. The sweep can still re-select it, so its ledger row must
      // be kept however old it is — purging it would let the same reminder be sent again.
      const due = new Date('2026-01-05T00:00:00Z');
      const task = await tx.lead_tasks.create({
        data: { lead_id: lead.id, title: `Follow up ${t}`, status: 'pending', due_date: due, created_at: old, updated_at: old },
      });
      const key = `lead-task-due:${task.id}:2026-01-05`;
      const kept = await tx.notification_deliveries.create({
        data: { user_id: user.id, category: 'lead_task_due', channel: 'inapp', dedupe_key: key, status: 'sent', created_at: old, updated_at: old },
      });
      const purgeable = await tx.notification_deliveries.create({
        data: { user_id: user.id, category: 'lead_task_due', channel: 'inapp', dedupe_key: `stale-${t}`, status: 'sent', created_at: old, updated_at: old },
      });

      await new NotificationRetentionService(tx).sweep(now);

      expect(await tx.notification_deliveries.count({ where: { id: kept.id } })).toBe(1);
      expect(await tx.notification_deliveries.count({ where: { id: purgeable.id } })).toBe(0);
    });
  });

  it('with the flag off, the same run deletes nothing at all', async () => {
    await inRollback(async (tx) => {
      // No flags set — the default deployment state, and the one that must be inert.
      const t = tag();
      const now = new Date();
      const old = new Date(now.getTime() - 400 * 86400_000);
      const user = await tx.users.create({
        data: { name: `Ret ${t}`, email: `ret4-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
      });
      const note = await tx.notifications.create({
        data: { user_id: user.id, category: 'lead_assigned', title: `probe ${t}`, body: 'x', created_at: old },
      });

      const result = await new NotificationRetentionService(tx).sweep(now);

      expect(result.skipped).toBe(true);
      expect(result.notifications).toBe(0);
      expect(await tx.notifications.count({ where: { id: note.id } })).toBe(1);
    });
  });
});
