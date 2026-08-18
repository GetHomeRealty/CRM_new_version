import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadGreetingsService } from './lead-greetings.service';
import { LeadWelcomeService } from './lead-welcome.service';
import { LeadTaskReminderService } from '../leads/lead-task-reminder.service';
import type { CrmEventNotifier } from '../notifications/crm-events.service';
import type { CrmAdvancedEmailService } from './crm-advanced-email.service';

/**
 * NO ELIGIBLE LEAD IS LEFT BEHIND THE BATCH LIMIT.
 *
 * ================================================================================================
 * THE DEFECT THESE TESTS EXIST FOR. All three CRM send-once sweeps fetched a batch of eligible
 * leads and then asked, per lead, whether the email had already gone:
 *
 *     SELECT ... FROM leads WHERE <eligible> ORDER BY id LIMIT 200   -- greetings
 *     findMany({ where: <eligible>, orderBy: id, take: 100 })        -- welcome
 *     then, in JavaScript: skip the ones already in crm_email_log
 *
 * A processed lead stays eligible, so it keeps occupying the limit. Pass one does the first batch;
 * every later pass fetches the SAME batch, finds it all done, and stops. Lead 201 (or 101) is never
 * reached at all.
 *
 * For a birthday that means silence for everyone past the batch on a busy date. For the welcome it
 * is worse: eligibility is "created in the last 24 hours", so the unreached leads age out of the
 * window and never get a welcome — with nothing logged, because nothing was ever attempted.
 *
 * The fix moves the exclusion into the query, before the limit. These tests are the proof, and they
 * are written to FAIL against the old code: with the exclusion in JavaScript, the second pass sends
 * nothing and the totals below never reach N.
 * ================================================================================================
 *
 * THE STUB WRITES `crm_email_log`, WHICH IS THE POINT. The real `dispatch` writes a row for every
 * attempt, and that row is what both the exclusion and the dedupe read. A stub that only counted
 * calls would leave the log empty, the exclusion would never exclude, and these tests would pass
 * against the broken code as well as the fixed one — proving nothing. No mail is sent either way.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

/**
 * EVERY SWEEP HERE IS GLOBAL, SO EACH TEST MUST OWN THE WHOLE TABLE.
 *
 * The rollback isolates what a test WRITES. It does nothing about what the database already
 * CONTAINS, and none of these sweeps is scoped to a brokerage — they ask "who is owed something
 * today?" across every row there is. So a developer database with one lead whose birthday is today,
 * or three pending follow-ups, silently joins the fixture and every exact total below is wrong by
 * however many happened to exist. That is not hypothetical: the completed/cancelled test read 4
 * where it expected 1, and the greeting tests pass today only because no stored birthday happens to
 * fall on today's date — a suite that starts failing on an arbitrary calendar day is worse than one
 * that fails now.
 *
 * So each test begins by making the pre-existing rows ineligible, which is safe precisely because
 * the transaction is thrown away afterwards. It is done HERE rather than per test so that a test
 * added later cannot forget it.
 *
 *   dates cleared          no stored birthday or anniversary can match today
 *   created_at pushed back out of the welcome sweep's recent-arrivals window
 *   follow-ups closed      no pending task is due
 *   the email log emptied  the send counts below are exact
 *
 * Fixtures are created after this runs, so they keep their own dates and are the only work in scope.
 *
 * THE LOG IS EMPTIED FOR THE COUNTS, not for eligibility. `sentCounts` asserts that no address was
 * written twice, and it reads the whole table — so one pre-existing address with two rows of the
 * same kind fails a test about leads that did not exist when it was written. The development
 * database happens to hold such pairs already, under other kinds.
 */
/*
 * NARROWED TO THE ROWS THAT COULD ACTUALLY INTERFERE, rather than the whole table.
 *
 * These statements used to carry no WHERE clause, so each one took a row lock on EVERY lead and
 * every task for the length of the transaction. That is a large lock held by a file that runs beside
 * others under jest's parallel workers — and `campaign-idempotency.spec.ts` deliberately commits
 * leads OUTSIDE a transaction, because its P2002 recovery cannot run inside one. The two met once in
 * a full run and produced two unexplained failures in `notification-chain.spec.ts`, which then
 * passed alone and in four subsequent runs.
 *
 * The predicates below select the same rows the sweeps could ever pick up — a stored birthday or
 * anniversary, a recently created lead, a pending task — and leave the rest untouched. The isolation
 * is identical; the lock is a fraction of the size.
 */
async function isolate(tx: PrismaService): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE leads SET date_of_birth = NULL, marriage_day = NULL
      WHERE date_of_birth IS NOT NULL OR marriage_day IS NOT NULL`,
  );
  // Only recent arrivals can be in the welcome sweep's window; older ones are already ineligible.
  await tx.$executeRawUnsafe(
    `UPDATE leads SET created_at = TIMESTAMP '2000-01-01 00:00:00'
      WHERE created_at > NOW() - INTERVAL '30 days'`,
  );
  await tx.$executeRawUnsafe("UPDATE lead_tasks SET status = 'completed' WHERE status = 'pending'");
  await tx.$executeRawUnsafe('DELETE FROM crm_email_log');
}

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await isolate(tx as unknown as PrismaService);
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 300_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** The batch limits the services compile in. Named so a change to either fails here loudly. */
const GREETING_BATCH = 200;
const WELCOME_BATCH = 100;

/**
 * An email stub that behaves like `dispatch`: records the call AND writes the log row.
 *
 * `success` is settable so the failure-policy tests can make a send fail while still logging the
 * attempt — which is what the real dispatch does, and what stops a failed send being retried for
 * ever.
 */
function stubEmail(tx: PrismaService, opts: { succeed?: boolean } = {}) {
  const calls: { kind: string; email: string }[] = [];
  const succeed = opts.succeed !== false;

  const record = async (kind: string, email: string) => {
    calls.push({ kind, email });
    await tx.crm_email_log.create({
      data: {
        kind, recipient: email, subject: `${kind} stub`, success: succeed,
        error: succeed ? null : 'stub failure', created_at: new Date(),
      },
    });
    return { success: succeed, message: 'stub' };
  };

  return {
    calls,
    service: {
      sendBirthdayWishes: (_n: string, email: string) => record('birthday', email),
      sendAnniversaryWishes: (_n: string, email: string) => record('anniversary', email),
      sendWelcomeEmail: (lead: { email: string }) => record('welcome', lead.email),
      welcomeBlockedReason: async () => null,
    } as unknown as CrmAdvancedEmailService,
  };
}

const greetings = (tx: PrismaService, email: CrmAdvancedEmailService) =>
  new LeadGreetingsService(tx, email, null as never, null as never);

const welcome = (tx: PrismaService, email: CrmAdvancedEmailService) =>
  new LeadWelcomeService(tx, email, null as never, null as never);

async function makeAgent(tx: PrismaService): Promise<number> {
  const now = new Date();
  const u = await tx.users.create({
    data: { name: `Starve agent ${tag()}`, email: `starve-agent-${tag()}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.id;
}

/** `n` leads, each with a distinct address, built in one insert so a thousand is not a thousand round trips. */
async function makeLeads(tx: PrismaService, n: number, agentId: number, over: (i: number) => Record<string, unknown>) {
  const now = new Date();
  const batch = Array.from({ length: n }, (_, i) => ({
    name: `Starve lead ${i}`,
    email: `starve-${tag()}-${i}@example.test`,
    owner_user_id: agentId,
    created_at: now,
    updated_at: now,
    ...over(i),
  }));
  await tx.leads.createMany({ data: batch as never });
  return batch.map((b) => b.email as string);
}

/** Today's month and day, in a year long past — what a real date of birth looks like. */
const dateOf = (today: Date, yearsAgo: number): Date =>
  new Date(Date.UTC(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate()));

/**
 * Run a sweep until it stops finding work, and report what each pass did.
 *
 * Capped, because the failure this guards against is a sweep that never drains: an uncapped loop
 * against the broken code would spin for ever rather than failing.
 */
async function drain(
  run: () => Promise<{ sent: number; skipped: number; failed: number }>,
  progress: () => Promise<number>,
  maxPasses = 40,
) {
  const passes: { sent: number; skipped: number; failed: number }[] = [];
  let before = await progress();
  for (let i = 0; i < maxPasses; i += 1) {
    const r = await run();
    passes.push(r);
    /*
     * STOPS ON PROGRESS, NOT ON `sent`. A mailer that fails every send reports `sent: 0` while still
     * attempting — and logging — every lead, so stopping on `sent === 0` would end after one pass
     * and the failure-policy test below would measure one batch instead of the drain.
     */
    const after = await progress();
    if (after === before) break;
    before = after;
  }
  return { passes, totalSent: passes.reduce((a, p) => a + p.sent, 0) };
}

/** Every address that received `kind`, and how many times each did. */
async function sentCounts(tx: PrismaService, kind: string): Promise<Map<string, number>> {
  const rows = await tx.crm_email_log.findMany({ where: { kind }, select: { recipient: true } });
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.recipient.toLowerCase(), (m.get(r.recipient.toLowerCase()) ?? 0) + 1);
  return m;
}

describe('birthday greetings drain past the batch limit', () => {
  jest.setTimeout(600_000);

  it.each([201, 500, 1000])('every one of %i eligible leads is greeted, across repeated passes', async (n) => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const emails = await makeLeads(tx, n, agent, () => ({ date_of_birth: dateOf(today, 30) }));

      const stub = stubEmail(tx);
      const { passes, totalSent } = await drain(() => greetings(tx, stub.service).sweep(today), () => tx.crm_email_log.count());

      // THE ASSERTION THE OLD CODE FAILS: everyone is greeted, not just the first batch.
      expect(totalSent).toBe(n);
      // And it took as many passes as the batch size implies — proof it drained rather than
      // fetching everything at once, which would be the other way to break this.
      expect(passes[0].sent).toBe(GREETING_BATCH);
      expect(passes.length).toBeGreaterThanOrEqual(Math.ceil(n / GREETING_BATCH));

      const counts = await sentCounts(tx, 'birthday');
      for (const e of emails) expect(counts.get(e.toLowerCase()) ?? 0).toBe(1);
      // Nobody was greeted twice — the fix must not solve starvation by creating duplicates.
      expect([...counts.values()].filter((c) => c > 1)).toEqual([]);
    });
  });

  it('a second run after draining sends nothing at all', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      await makeLeads(tx, 250, agent, () => ({ date_of_birth: dateOf(today, 40) }));

      const stub = stubEmail(tx);
      const svc = greetings(tx, stub.service);
      await drain(() => svc.sweep(today), () => tx.crm_email_log.count());
      const before = stub.calls.length;

      const again = await svc.sweep(today);
      expect(again.sent).toBe(0);
      expect(stub.calls.length).toBe(before);
    });
  });
});

describe('anniversary greetings drain past the batch limit', () => {
  jest.setTimeout(600_000);

  it.each([201, 500, 1000])('every one of %i eligible leads is greeted, across repeated passes', async (n) => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const emails = await makeLeads(tx, n, agent, () => ({ marriage_day: dateOf(today, 5) }));

      const stub = stubEmail(tx);
      const { totalSent } = await drain(() => greetings(tx, stub.service).sweep(today), () => tx.crm_email_log.count());

      expect(totalSent).toBe(n);
      const counts = await sentCounts(tx, 'anniversary');
      for (const e of emails) expect(counts.get(e.toLowerCase()) ?? 0).toBe(1);
      expect([...counts.values()].filter((c) => c > 1)).toEqual([]);
    });
  });

  /**
   * The two greetings share one sweep and one batch limit, so a lead eligible for BOTH must not
   * have one of them starve the other.
   */
  it('a lead eligible for both gets both, once each', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const agent = await makeAgent(tx);
      const emails = await makeLeads(tx, 250, agent, () => ({
        date_of_birth: dateOf(today, 30), marriage_day: dateOf(today, 5),
      }));

      const stub = stubEmail(tx);
      await drain(() => greetings(tx, stub.service).sweep(today), () => tx.crm_email_log.count());

      const b = await sentCounts(tx, 'birthday');
      const a = await sentCounts(tx, 'anniversary');
      for (const e of emails) {
        expect(b.get(e.toLowerCase()) ?? 0).toBe(1);
        expect(a.get(e.toLowerCase()) ?? 0).toBe(1);
      }
    });
  });
});

describe('welcome emails drain past the batch limit', () => {
  jest.setTimeout(600_000);

  it.each([101, 250, 500, 1000])('every one of %i new leads is welcomed, across repeated passes', async (n) => {
    await inRollback(async (tx) => {
      const now = new Date();
      const agent = await makeAgent(tx);
      const emails = await makeLeads(tx, n, agent, () => ({ created_at: now, updated_at: now }));

      const stub = stubEmail(tx);
      const { passes, totalSent } = await drain(() => welcome(tx, stub.service).sweep(now), () => tx.crm_email_log.count());

      // The defect that made this the worst of the three: these leads would have aged out unsent.
      expect(totalSent).toBe(n);
      expect(passes[0].sent).toBe(WELCOME_BATCH);
      expect(passes.length).toBeGreaterThanOrEqual(Math.ceil(n / WELCOME_BATCH));

      const counts = await sentCounts(tx, 'welcome');
      for (const e of emails) expect(counts.get(e.toLowerCase()) ?? 0).toBe(1);
      expect([...counts.values()].filter((c) => c > 1)).toEqual([]);
    });
  });

  /** The reconciliation the audit asks for: eligible = sent + legitimately excluded + 0 starved. */
  it('reconciles: every eligible lead is either welcomed or excluded for a stated reason', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const old = new Date(now.getTime() - 48 * 3600_000);
      const agent = await makeAgent(tx);

      const good = await makeLeads(tx, 150, agent, () => ({ created_at: now, updated_at: now }));
      /*
       * Legitimate exclusions, one rule each.
       *
       * THE EMPTY-ADDRESS ROWS EACH NEED THEIR OWN OWNER. `leads` carries
       * UNIQUE (COALESCE(owner_user_id, 0), lower(email)), so five rows with one owner and an empty
       * address collide with each other — the constraint treats '' as an address like any other.
       * That is the real schema, so the fixture bends rather than the assertion.
       */
      for (let i = 0; i < 5; i += 1) {
        await makeLeads(tx, 1, await makeAgent(tx), () => ({ created_at: now, updated_at: now, email: '' }));
      }
      await makeLeads(tx, 5, agent, () => ({ created_at: now, updated_at: now, unsubscribed: true }));   // opted out
      await makeLeads(tx, 5, agent, () => ({ created_at: old, updated_at: old }));                        // aged out
      await makeLeads(tx, 5, agent, () => ({ created_at: now, updated_at: now, deleted_at: now }));       // deleted

      const stub = stubEmail(tx);
      const { totalSent } = await drain(() => welcome(tx, stub.service).sweep(now), () => tx.crm_email_log.count());

      expect(totalSent).toBe(good.length);
      const counts = await sentCounts(tx, 'welcome');
      expect(counts.size).toBe(good.length);
      for (const e of good) expect(counts.get(e.toLowerCase())).toBe(1);
      // Nothing starved: the only leads without a welcome are the twenty excluded on purpose.
      const eligibleLeft = await tx.leads.count({
        where: { deleted_at: null, unsubscribed: false, created_at: { gte: new Date(now.getTime() - 24 * 3600_000) }, email: { not: '' } },
      });
      expect(eligibleLeft).toBe(good.length);   // still eligible by shape, but all now logged
    });
  });

  /** One address on two lead rows is one human being — the import case, at batch scale. */
  it('welcomes a duplicated address once even when the copies span batches', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const agent = await makeAgent(tx);
      const shared = `starve-shared-${tag()}@example.test`;
      /*
       * ONE ADDRESS, TWO LEAD ROWS, TWO DIFFERENT OWNERS — which is the only way the case can exist.
       * `leads` is UNIQUE on (COALESCE(owner_user_id, 0), lower(email)), so one agent cannot hold the
       * same address twice; two agents can, and that is exactly the real situation the welcome
       * dedupe is for: a referral, or a couple working with two agents. The second copy is placed
       * past the first batch, so catching it proves the guard survives the drain rather than only
       * working within one pass.
       */
      const other = await makeAgent(tx);
      await makeLeads(tx, 119, agent, (i) => ({
        created_at: now, updated_at: now,
        ...(i === 0 ? { email: shared } : {}),
      }));
      await makeLeads(tx, 1, other, () => ({ created_at: now, updated_at: now, email: shared }));

      const stub = stubEmail(tx);
      await drain(() => welcome(tx, stub.service).sweep(now), () => tx.crm_email_log.count());

      const counts = await sentCounts(tx, 'welcome');
      expect(counts.get(shared.toLowerCase())).toBe(1);
    });
  });

  /**
   * A FAILED SEND STILL LOGS, so it is not retried for ever — which is the existing policy and the
   * reason the exclusion is on "was it attempted", not "did it succeed". Pinned because the fix
   * moved that question into SQL, where getting it wrong would either resend failures indefinitely
   * or (worse) mark them delivered.
   */
  it('a failed send is logged and not retried, and does not block the rest', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const agent = await makeAgent(tx);
      await makeLeads(tx, 120, agent, () => ({ created_at: now, updated_at: now }));

      const failing = stubEmail(tx, { succeed: false });
      const { totalSent } = await drain(() => welcome(tx, failing.service).sweep(now), () => tx.crm_email_log.count());

      // `sent` counts successes, so a failing mailer reports none…
      expect(totalSent).toBe(0);
      // …but every lead was ATTEMPTED and logged, so the sweep drained rather than looping.
      const counts = await sentCounts(tx, 'welcome');
      expect(counts.size).toBe(120);
      expect([...counts.values()].filter((c) => c > 1)).toEqual([]);
    });
  });
});

/*
 * ==================================================================================================
 * THE SAME DEFECT IN THE FOLLOW-UP REMINDER SWEEP, WHICH IS THE WORST-AFFECTED OF THE FOUR.
 *
 * `lead-task-reminder` took the 500 longest-overdue pending tasks and let the dedupe key drop the
 * handled ones downstream. Two consequences, and the second was not in the original report:
 *
 *   IT NEVER RECOVERS. A birthday sweep starves for one day and the calendar moves on. A task stays
 *   `pending` until a PERSON completes it, and the order is oldest-due-first, so a backlog of 500
 *   stale overdue tasks starves every newer task permanently.
 *
 *   IT RE-SENT EMAIL AND PUSH EVERY THIRTY MINUTES. The dedupe key is enforced by a unique index on
 *   the in-app row and only the in-app channel consults it; `lead_task_due` also supports email and
 *   push, both live by default. Re-selecting the same task each pass meant re-sending on those two
 *   for as long as it stayed overdue — forty-eight emails a day, per task.
 *
 * Both are the same root cause and both are covered below.
 * ==================================================================================================
 */

/** The batch limit the reminder service compiles in. Named so a change to it fails here loudly. */
const TASK_BATCH = 500;

/**
 * A notifier stub that leaves behind what the real dispatcher leaves behind.
 *
 * IT MUST WRITE THE DELIVERY LEDGER, because that is what the sweep's exclusion reads. Writing only
 * the `notifications` row — which is what this stub used to do, back when the in-app row was the
 * dedupe record — would leave the ledger empty, the exclusion would never exclude, and every test
 * below would pass against a starving sweep as readily as against a working one.
 *
 * All three channels are claimed, as `dispatch` does: one call handles the occurrence for the
 * recipient, whatever each individual channel then does with it. `skipDuplicates` mirrors the
 * ON CONFLICT DO NOTHING claim, so a second call for the same occurrence is a no-op and not an error.
 */
function stubNotifier(tx: PrismaService) {
  const calls: { taskId: number; userId: number; occurrence: string }[] = [];
  return {
    calls,
    service: {
      leadTaskDue: async (
        task: { id: number },
        _lead: unknown,
        recipientUserId: number | null | undefined,
        occurrence: string,
      ) => {
        if (!recipientUserId) return;
        calls.push({ taskId: task.id, userId: recipientUserId, occurrence });
        const key = `lead-task-due:${task.id}:${occurrence}`;
        const now = new Date();

        await tx.notification_deliveries.createMany({
          data: ['in_app', 'email', 'push'].map((channel) => ({
            user_id: recipientUserId,
            category: 'lead_task_due',
            dedupe_key: key,
            channel,
            status: 'sent',
            created_at: now,
            updated_at: now,
          })),
          skipDuplicates: true,
        });

        await tx.notifications.createMany({
          data: [{
            user_id: recipientUserId,
            category: 'lead_task_due',
            title: 'Follow-up due',
            dedupe_key: key,
            created_at: now,
          }],
          skipDuplicates: true,
        });
      },
    } as unknown as CrmEventNotifier,
  };
}

const reminders = (tx: PrismaService, notifier: CrmEventNotifier) =>
  new LeadTaskReminderService(tx, notifier, null as never, null as never);

/** `n` pending tasks on one lead, all assigned to `agentId`. */
async function makeTasks(
  tx: PrismaService, n: number, leadId: number, agentId: number, dueDate: Date,
): Promise<void> {
  const now = new Date();
  await tx.lead_tasks.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      lead_id: leadId, title: `Follow up ${i}`, due_date: dueDate,
      status: 'pending', assigned_to: agentId, created_at: now, updated_at: now,
    })) as never,
  });
}

/** `drain`, for a sweep whose result shape is `{ notified }`. Progress is the notification count. */
async function drainTasks(
  run: () => Promise<{ notified: number }>,
  progress: () => Promise<number>,
  maxPasses = 40,
) {
  const passes: number[] = [];
  let before = await progress();
  for (let i = 0; i < maxPasses; i += 1) {
    passes.push((await run()).notified);
    const after = await progress();
    if (after === before) break;
    before = after;
  }
  return { passes, totalNotified: passes.reduce((a, b) => a + b, 0) };
}

describe('follow-up reminders drain past the batch limit', () => {
  /** One lead to hang the tasks on. Its own fields do not matter here. */
  async function makeLead(tx: PrismaService, agentId: number): Promise<number> {
    const now = new Date();
    const lead = await tx.leads.create({
      data: {
        name: `Task lead ${tag()}`, email: `task-lead-${tag()}@example.test`,
        owner_user_id: agentId, created_at: now, updated_at: now,
      } as never,
    });
    return lead.id;
  }

  /*
   * SCOPED TO THE AGENT THIS TEST CREATED. These run inside a rolled-back transaction, which isolates
   * what the test WRITES but not what it READS — the surrounding database already holds
   * lead_task_due notifications from ordinary use, and an unscoped count picked those up and made
   * every total wrong by however many happened to exist.
   */
  const notifCount = (tx: PrismaService, agentId: number) =>
    tx.notifications.count({ where: { category: 'lead_task_due', user_id: agentId } });

  it(`notifies all ${TASK_BATCH + 1} due tasks, not just the first ${TASK_BATCH}`, async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, agent);
      const today = new Date();
      await makeTasks(tx, TASK_BATCH + 1, lead, agent, today);

      const stub = stubNotifier(tx);
      const { passes, totalNotified } = await drainTasks(
        () => reminders(tx, stub.service).sweep(today), () => notifCount(tx, agent),
      );

      // The 501st is the one the old code could never reach.
      expect(totalNotified).toBe(TASK_BATCH + 1);
      expect(await notifCount(tx, agent)).toBe(TASK_BATCH + 1);
      // Two passes of work, then one that finds nothing — proof it drained rather than stalled.
      expect(passes).toEqual([TASK_BATCH, 1, 0]);
    });
  });

  it('notifies all 1,000 due tasks across a backlog several batches deep', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, agent);
      const today = new Date();
      await makeTasks(tx, 1000, lead, agent, today);

      const stub = stubNotifier(tx);
      const { totalNotified } = await drainTasks(
        () => reminders(tx, stub.service).sweep(today), () => notifCount(tx, agent),
      );

      expect(totalNotified).toBe(1000);
      // Exactly once each: 1,000 distinct tasks, 1,000 distinct dedupe keys, no repeats.
      expect(new Set(stub.calls.map((c) => c.taskId)).size).toBe(1000);
      expect(stub.calls).toHaveLength(1000);
    });
  });

  /**
   * THE REPEAT-SEND HALF. This is what produced forty-eight emails a day: the task is still overdue
   * and still `pending` on the next pass, which is normal and expected — nobody has completed it —
   * and it must not be picked up again.
   */
  it('does not re-notify a task that is still overdue and still pending', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, agent);
      const today = new Date();
      // Due a week ago, untouched since: the exact row that was being re-sent every thirty minutes.
      await makeTasks(tx, 3, lead, agent, new Date(today.getTime() - 7 * 86400_000));

      const stub = stubNotifier(tx);
      const svc = reminders(tx, stub.service);

      expect((await svc.sweep(today)).notified).toBe(3);
      // Four more passes, standing in for two hours of a live scheduler.
      for (let i = 0; i < 4; i += 1) expect((await svc.sweep(today)).notified).toBe(0);

      expect(stub.calls).toHaveLength(3);
      expect(await notifCount(tx, agent)).toBe(3);
    });
  });

  /**
   * The behaviour that must SURVIVE the fix. The exclusion is keyed on the task AND its due date, so
   * a task genuinely due again on a later date is a different occurrence and notifies again.
   */
  it('notifies again when the same task falls due on a later date', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, agent);
      const day1 = new Date(Date.UTC(2026, 4, 10));
      await makeTasks(tx, 1, lead, agent, day1);

      const stub = stubNotifier(tx);
      const svc = reminders(tx, stub.service);

      expect((await svc.sweep(day1)).notified).toBe(1);
      expect((await svc.sweep(day1)).notified).toBe(0);

      // Somebody moves the follow-up out a week; that is a new occurrence.
      const day2 = new Date(Date.UTC(2026, 4, 17));
      await tx.lead_tasks.updateMany({ where: { lead_id: lead }, data: { due_date: day2 } });

      expect((await svc.sweep(day2)).notified).toBe(1);
      expect(stub.calls.map((c) => c.occurrence)).toEqual(['2026-05-10', '2026-05-17']);
    });
  });

  /**
   * The three exclusions that were in the old `where` clause and had to be carried into the raw
   * query by hand — the kind of thing a rewrite silently drops.
   */
  it('still skips completed and cancelled tasks, and tasks on a deleted lead', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const live = await makeLead(tx, agent);
      const binned = await makeLead(tx, agent);
      await tx.leads.update({ where: { id: binned }, data: { deleted_at: new Date() } });

      const today = new Date();
      const now = new Date();
      await tx.lead_tasks.createMany({
        data: [
          { lead_id: live, title: 'pending', due_date: today, status: 'pending', assigned_to: agent, created_at: now, updated_at: now },
          { lead_id: live, title: 'completed', due_date: today, status: 'completed', assigned_to: agent, created_at: now, updated_at: now },
          { lead_id: live, title: 'cancelled', due_date: today, status: 'cancelled', assigned_to: agent, created_at: now, updated_at: now },
          { lead_id: live, title: 'unassigned', due_date: today, status: 'pending', assigned_to: null, created_at: now, updated_at: now },
          { lead_id: binned, title: 'on a deleted lead', due_date: today, status: 'pending', assigned_to: agent, created_at: now, updated_at: now },
        ] as never,
      });

      const stub = stubNotifier(tx);
      expect((await reminders(tx, stub.service).sweep(today)).notified).toBe(1);
      expect(stub.calls).toHaveLength(1);
    });
  });

  /**
   * THE MUTED-IN-APP CASE, AT THE SWEEP RATHER THAN AT THE DISPATCHER.
   *
   * This is the configuration the old rule got wrong: in-app off, email on. Nothing was written to
   * `notifications`, so the exclusion — which read that table — never fired, the task was re-selected
   * on every pass, and the recipient was re-emailed every thirty minutes for having switched off the
   * channel that happened to be keeping the books.
   *
   * The stub writes what the dispatcher now writes for that person: a `muted` ledger row for in-app
   * and a `sent` one for email, and NO `notifications` row at all. The sweep must still treat the
   * occurrence as handled — which is the whole point of the exclusion reading what was HANDLED
   * rather than what was DELIVERED.
   */
  it('does not re-notify a recipient who muted in-app and kept email', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const lead = await makeLead(tx, agent);
      const today = new Date();
      await makeTasks(tx, 2, lead, agent, today);

      const sends: string[] = [];
      const mutedInApp = {
        leadTaskDue: async (task: { id: number }, _l: unknown, userId: number, occurrence: string) => {
          const now = new Date();
          sends.push(`${task.id}:${occurrence}`);
          await tx.notification_deliveries.createMany({
            data: [
              { user_id: userId, category: 'lead_task_due', dedupe_key: `lead-task-due:${task.id}:${occurrence}`, channel: 'in_app', status: 'muted', created_at: now, updated_at: now },
              { user_id: userId, category: 'lead_task_due', dedupe_key: `lead-task-due:${task.id}:${occurrence}`, channel: 'email', status: 'sent', created_at: now, updated_at: now },
            ],
            skipDuplicates: true,
          });
          // Deliberately no `notifications` row — in-app is muted, so the old record never existed.
        },
      } as unknown as CrmEventNotifier;

      const svc = reminders(tx, mutedInApp);
      expect((await svc.sweep(today)).notified).toBe(2);
      // Four more passes, standing in for two hours of the live scheduler.
      for (let i = 0; i < 4; i += 1) expect((await svc.sweep(today)).notified).toBe(0);

      expect(sends).toHaveLength(2);
      expect(await tx.notifications.count({ where: { user_id: agent } })).toBe(0);
    });
  });

  /**
   * Two people, one backlog. The exclusion correlates on `user_id` as well as the key, so one
   * agent's notification must not suppress another agent's — the shape that a `dedupe_key`-only
   * lookup would get wrong.
   */
  it('keeps one recipient reminders separate from another', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx);
      const b = await makeAgent(tx);
      const lead = await makeLead(tx, a);
      const today = new Date();
      const now = new Date();
      await tx.lead_tasks.createMany({
        data: [
          { lead_id: lead, title: 'for a', due_date: today, status: 'pending', assigned_to: a, created_at: now, updated_at: now },
          { lead_id: lead, title: 'for b', due_date: today, status: 'pending', assigned_to: b, created_at: now, updated_at: now },
        ] as never,
      });

      const stub = stubNotifier(tx);
      expect((await reminders(tx, stub.service).sweep(today)).notified).toBe(2);
      expect(new Set(stub.calls.map((c) => c.userId))).toEqual(new Set([a, b]));
      expect((await reminders(tx, stub.service).sweep(today)).notified).toBe(0);
    });
  });
});
