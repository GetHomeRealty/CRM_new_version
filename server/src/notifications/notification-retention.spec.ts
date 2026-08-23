import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { CrmEventNotifier } from './crm-events.service';
import { NotificationRetentionService } from './notification-retention.service';
import { LeadTaskReminderService } from '../leads/lead-task-reminder.service';
import { RETENTION_MONTHS } from '../retention/retention.service';

/**
 * SIX-MONTH RETENTION THAT CANNOT HAND BACK PERMISSION TO SEND.
 *
 * ================================================================================================
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER RETENTION SWEEP. The other ones delete history:
 * removing an old audit row or an emptied Recycle Bin entry loses information and changes nothing
 * else. `notification_deliveries` is not history — it is the record that STOPS a notification being
 * sent again, so deleting a row is an ACTION, not just a forgetting.
 *
 * For most categories that is harmless, because the event is over and nothing can produce it again.
 * For `lead_task_due` it is not: a follow-up stays `pending` until a person completes it, and the
 * sweep selects `due_date <= today` with no lower bound. A task that fell due eight months ago and
 * was never done is still selected today. Purge its ledger row on age alone and the very next sweep
 * finds no record, treats the occurrence as new, and emails the agent about a follow-up they were
 * told about eight months ago — every thirty minutes, until somebody closes it.
 *
 * The last test in this file is the one that matters: purge, then actually run the reminder sweep,
 * and assert nothing is sent. Testing the DELETE alone would prove the row went away, which was
 * never in doubt.
 * ================================================================================================
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/*
 * ==================================================================================================
 * THE WHOLE FIXTURE LIVES IN 2019, AND THAT IS ISOLATION RATHER THAN WHIMSY.
 *
 * These sweeps are global: `sweep()` deletes every expired row there is, and `plan()` counts every
 * one. The obvious way to get exact numbers is to empty the tables first — which is what this file
 * did, and it was wrong. A table-wide DELETE inside a transaction locks every row in it, the other
 * notification suites are inserting into those same tables at the same time under jest's parallel
 * workers, and the two block each other until the 5s test timeout fires. It passed alone and failed
 * in the full run, which is the most expensive way for a test to be wrong.
 *
 * Dating the fixture to 2019 removes the need for isolation instead of fighting for it. Nothing in
 * the database predates 2026-08, so with `NOW` at 2020-01-01 the cutoff lands in 2019-07 and no
 * pre-existing row is eligible for anything. The sweep can only ever see rows this file created, no
 * lock is taken on anybody else's, and the counts are exact without deleting a thing.
 * ==================================================================================================
 */
const NOW = new Date('2020-01-01T12:00:00.000Z');
/** Comfortably outside a six-month window, and comfortably inside it. */
const LONG_AGO = new Date('2019-01-01T12:00:00.000Z');
const RECENTLY = new Date('2019-12-01T12:00:00.000Z');

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `Retention user ${tag()}`, email: `retention-${tag()}@example.test`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return u.id;
}

async function makeLead(tx: PrismaService, ownerId: number): Promise<number> {
  const now = new Date();
  const lead = await tx.leads.create({
    data: {
      name: `Retention lead ${tag()}`, email: `retention-lead-${tag()}@example.test`,
      owner_user_id: ownerId, created_at: now, updated_at: now,
    } as never,
  });
  return lead.id;
}

/** A ledger row for one occurrence, on all three channels, stamped at `at`. */
async function ledger(tx: PrismaService, userId: number, category: string, key: string, at: Date) {
  await tx.notification_deliveries.createMany({
    data: ['in_app', 'email', 'push'].map((channel) => ({
      user_id: userId, category, dedupe_key: key, channel, status: 'sent', created_at: at, updated_at: at,
    })),
    skipDuplicates: true,
  });
}

const service = (tx: PrismaService) => new NotificationRetentionService(tx);

/** Run a sweep with deletion switched on, then put the environment back. */
async function withDeletionEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.NOTIFICATION_RETENTION_ENABLED;
  process.env.NOTIFICATION_RETENTION_ENABLED = 'true';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.NOTIFICATION_RETENTION_ENABLED;
    else process.env.NOTIFICATION_RETENTION_ENABLED = saved;
  }
}

describe('the window is the brokerage’s one retention policy', () => {
  it('is six months, and the same constant Transaction Desk retention uses', () => {
    expect(RETENTION_MONTHS).toBe(6);
    expect(NotificationRetentionService.months()).toBe(6);
  });

  it('can be tuned or switched off without touching the Desk policy', () => {
    const saved = process.env.NOTIFICATION_RETENTION_MONTHS;
    try {
      process.env.NOTIFICATION_RETENTION_MONTHS = '12';
      expect(NotificationRetentionService.months()).toBe(12);
      process.env.NOTIFICATION_RETENTION_MONTHS = '0';
      expect(NotificationRetentionService.months()).toBe(0);
      // Nonsense falls back to the shared policy rather than to "delete everything".
      process.env.NOTIFICATION_RETENTION_MONTHS = 'soon';
      expect(NotificationRetentionService.months()).toBe(RETENTION_MONTHS);
    } finally {
      if (saved === undefined) delete process.env.NOTIFICATION_RETENTION_MONTHS;
      else process.env.NOTIFICATION_RETENTION_MONTHS = saved;
    }
  });

/**
 * Force the sweep OFF for a test that is about the disabled behaviour.
 *
 * These two used to assert "deletes nothing" while simply not setting `NOTIFICATION_RETENTION_ENABLED` — which
 * passed only for as long as no deployment set it. The brokerage has now chosen a retention policy
 * and turned it on in `.env`, and both tests failed: they were asserting a default, not a rule.
 * Setting it explicitly makes each test state the condition it is actually testing.
 */
async function withRetentionDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.NOTIFICATION_RETENTION_ENABLED;
  process.env.NOTIFICATION_RETENTION_ENABLED = 'false';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.NOTIFICATION_RETENTION_ENABLED;
    else process.env.NOTIFICATION_RETENTION_ENABLED = saved;
  }
}

  it('deletes nothing until NOTIFICATION_RETENTION_ENABLED is set, however old the rows are', async () => {
    await withRetentionDisabled(async () => inRollback(async (tx) => {
      const user = await makeUser(tx);
      await ledger(tx, user, 'campaign_completed', 'campaign-completed:1:1', LONG_AGO);

      const result = await service(tx).sweep(NOW);

      expect(result).toEqual({ deliveries: 0, notifications: 0, skipped: true });
      expect(await tx.notification_deliveries.count({ where: { user_id: user } })).toBe(3);
    }));
  });

  it('reports what it would remove, without removing it', async () => {
    await withRetentionDisabled(async () => inRollback(async (tx) => {
      const user = await makeUser(tx);
      await ledger(tx, user, 'campaign_completed', 'campaign-completed:1:1', LONG_AGO);
      await ledger(tx, user, 'campaign_completed', 'campaign-completed:2:1', RECENTLY);

      const plan = await service(tx).plan(NOW);

      expect(plan.enabled).toBe(false);
      expect(plan.months).toBe(6);
      expect(plan.deliveries).toBe(3);
      expect(await tx.notification_deliveries.count({ where: { user_id: user } })).toBe(6);
    }));
  });
});

describe('what is purged, and what is kept', () => {
  it('removes ledger rows and notifications older than the window', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await ledger(tx, user, 'campaign_completed', 'campaign-completed:1:1', LONG_AGO);
      await tx.notifications.create({
        data: {
          user_id: user, category: 'campaign_completed', title: 'Old', dedupe_key: 'old-1', created_at: LONG_AGO,
        },
      });

      const result = await withDeletionEnabled(() => service(tx).sweep(NOW));

      expect(result.deliveries).toBe(3);
      expect(result.notifications).toBe(1);
      expect(await tx.notification_deliveries.count({ where: { user_id: user } })).toBe(0);
      expect(await tx.notifications.count({ where: { user_id: user } })).toBe(0);
    });
  });

  it('keeps anything inside the window untouched', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await ledger(tx, user, 'campaign_completed', 'campaign-completed:2:1', RECENTLY);
      await tx.notifications.create({
        data: {
          user_id: user, category: 'campaign_completed', title: 'Recent', dedupe_key: 'recent-1', created_at: RECENTLY,
        },
      });

      const result = await withDeletionEnabled(() => service(tx).sweep(NOW));

      expect(result).toMatchObject({ deliveries: 0, notifications: 0 });
      expect(await tx.notification_deliveries.count({ where: { user_id: user } })).toBe(3);
      expect(await tx.notifications.count({ where: { user_id: user } })).toBe(1);
    });
  });
});

describe('a live occurrence is never handed back permission to send', () => {
  /** An expired ledger row for a follow-up that is still pending — the case the guard exists for. */
  async function overdueAndUnfinished(tx: PrismaService) {
    const user = await makeUser(tx);
    const lead = await makeLead(tx, user);
    const dueDate = new Date(Date.UTC(2019, 1, 1)); // 2019-02-01, eleven months before NOW
    const now = new Date();
    const task = await tx.lead_tasks.create({
      data: {
        lead_id: lead, title: 'Never done', due_date: dueDate, status: 'pending',
        assigned_to: user, created_at: now, updated_at: now,
      } as never,
    });
    const key = `lead-task-due:${task.id}:2019-02-01`;
    await ledger(tx, user, 'lead_task_due', key, LONG_AGO);
    return { user, task, key };
  }

  it('keeps the ledger row of a still-pending follow-up, however old it is', async () => {
    await inRollback(async (tx) => {
      const { key } = await overdueAndUnfinished(tx);

      const result = await withDeletionEnabled(() => service(tx).sweep(NOW));

      expect(result.deliveries).toBe(0);
      expect(await tx.notification_deliveries.count({ where: { dedupe_key: key } })).toBe(3);
    });
  });

  it('counts it as protected rather than as purgeable', async () => {
    await inRollback(async (tx) => {
      await overdueAndUnfinished(tx);

      const plan = await service(tx).plan(NOW);

      expect(plan.deliveries).toBe(0);
      expect(plan.protected).toBe(3);
    });
  });

  /**
   * THE ASSERTION THE WHOLE FILE EXISTS FOR. Not "the row survived" — that is a means — but that a
   * sweep run AFTER the purge still sends nothing. This is what a reader should check the guard
   * against, because it is the behaviour the policy actually promises.
   */
  it('the reminder sweep still sends nothing after a purge has run', async () => {
    await inRollback(async (tx) => {
      const { user, task } = await overdueAndUnfinished(tx);

      await withDeletionEnabled(() => service(tx).sweep(NOW));

      const sends: string[] = [];
      const notifier = {
        leadTaskDue: async (task: { id: number }, _l: unknown, uid: number, occurrence: string) => {
          sends.push(`${task.id}:${occurrence}`);
          await ledger(tx, uid, 'lead_task_due', `lead-task-due:${task.id}:${occurrence}`, new Date());
        },
      } as unknown as CrmEventNotifier;

      const reminders = new LeadTaskReminderService(tx, notifier, null as never, null as never);
      await reminders.sweep(NOW);
      // Named rather than counted: the sweep is global, and what must be true is that THIS occurrence
      // was not resurrected — not that the database happened to hold no other due task.
      expect(sends.filter((s) => s.startsWith(`${task.id}:`))).toEqual([]);
      expect(user).toBeGreaterThan(0);
    });
  });

  /**
   * The other half of the guard: once the task IS completed, nothing can produce the occurrence
   * again, so the row becomes ordinary history and is purged on the next pass.
   */
  it('purges the row once the follow-up has been completed', async () => {
    await inRollback(async (tx) => {
      const { task, key } = await overdueAndUnfinished(tx);
      await tx.lead_tasks.update({ where: { id: task.id }, data: { status: 'completed' } });

      const result = await withDeletionEnabled(() => service(tx).sweep(NOW));

      expect(result.deliveries).toBe(3);
      expect(await tx.notification_deliveries.count({ where: { dedupe_key: key } })).toBe(0);
    });
  });

  /**
   * The guard must be narrow. An expired `lead_task_due` row whose task is gone entirely — deleted,
   * or never existed — is not protecting anything and must not be kept for ever on the strength of
   * its category alone.
   */
  it('does not keep an expired row whose task no longer exists', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await ledger(tx, user, 'lead_task_due', 'lead-task-due:2146000000:2019-02-01', LONG_AGO);

      const result = await withDeletionEnabled(() => service(tx).sweep(NOW));

      expect(result.deliveries).toBe(3);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
