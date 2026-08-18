import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MailerService } from '../email/mailer.service';
import { WebPushService } from '../calendar/web-push.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceService, type NotificationChannel } from './notification-preference.service';
import { CrmEventNotifier } from './crm-events.service';
import { CrmAdvancedEmailService } from '../crm-settings/crm-advanced-email.service';
import { CrmTriggersService } from '../crm-settings/crm-triggers.service';
import { LeadWelcomeService } from '../crm-settings/lead-welcome.service';
import { LeadGreetingsService } from '../crm-settings/lead-greetings.service';
import { LeadTaskReminderService } from '../leads/lead-task-reminder.service';

/**
 * THE WHOLE CHAIN, FOR EVERY CRM EVENT THAT SENDS SOMETHING.
 *
 *     business event -> trigger -> eligibility/settings -> template -> recipient
 *                    -> send -> delivery result -> log -> duplicate prevention
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TESTS BESIDE IT. Every link in that chain already
 * has tests. What none of them proves is that the links are CONNECTED — that switching off a
 * brokerage master switch actually stops a scheduler three services away, that a refusal reaches the
 * log with a reason rather than vanishing, that a second scheduler pass sends nothing. Those are
 * properties of the chain, not of any one part, and they are exactly what breaks when a call site is
 * moved.
 *
 * THERE ARE TWO CHAINS, NOT ONE, and conflating them is the mistake this file is arranged to avoid:
 *
 *   THE CRM EMAIL CHAIN — welcome, birthday, anniversary. Runs through
 *   `CrmAdvancedEmailService.dispatch`, gated by a per-user trigger AND a brokerage master switch,
 *   and recorded in `crm_email_log`. Email only; these categories are `unsupported` for in-app and
 *   push by design.
 *
 *   THE DISPATCHER CHAIN — lead assigned, Meta lead, task due, campaign finished, campaign failed.
 *   Runs through `NotificationDispatcher`, gated per channel by `notification_preferences`, and
 *   recorded in `notification_deliveries` (all channels) plus `notifications` (in-app only).
 *
 * A brokerage master switch that silenced the second chain, or a muted push preference that
 * silenced a birthday email, would both be bugs. Both are asserted below.
 * ================================================================================================
 *
 * NOTHING IS MOCKED EXCEPT THE TRANSPORT. The mailer and the push service record what they were
 * asked to send; every gate, every settings lookup, every log write and every dedupe claim is the
 * real code against a real database.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

/*
 * ==================================================================================================
 * NOTHING GLOBAL IS MUTATED HERE, AND THAT IS DELIBERATE.
 *
 * The sweeps under test are global — they ask "who is owed something today?" across every row there
 * is — so the obvious way to get exact numbers is to empty the tables first. This file did exactly
 * that, and it was wrong for the second time in this codebase: a table-wide DELETE or UPDATE inside
 * a transaction locks every row in it, the other notification suites write to those same tables
 * under jest's parallel workers, and the two block each other until the 5s test timeout fires. It
 * passed alone and failed in the full run.
 *
 * The fix is to stop needing isolation. Every fixture address carries a recognisable prefix, and
 * every assertion filters to it — so other suites' rows and the developer database's own history are
 * simply not counted, no lock is taken on anything this file did not create, and the numbers are
 * exact regardless of what else is running.
 * ==================================================================================================
 */
async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 180_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/**
 * Every address this file creates starts with one of these, and only these are ever counted.
 *
 * `chain-agent` belongs here as much as the lead prefixes do: the CRM email chain writes to the
 * LEAD, but the dispatcher chain writes to the AGENT — a task falling due is news for the person who
 * owns it, not for the client. Leaving it out made the follow-up reminder look like it had sent
 * nothing.
 */
const MINE = /^(chain-lead|chain-agent|vol)-/;

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

// ---------------------------------------------------------------- transport stubs

/** Records what each channel was asked to deliver. The only thing that is not real. */
function transport(opts: { mailFails?: boolean } = {}) {
  const emails: { to: string; subject: string }[] = [];
  const pushes: number[] = [];
  const mailer = {
    sendDirect: async (to: string, subject: string) => {
      if (opts.mailFails) throw new Error('smtp: connection refused');
      emails.push({ to, subject });
      return true;
    },
  };
  const push = {
    configured: () => true,
    sendToUser: async (userId: number) => { pushes.push(userId); return { sent: 1 }; },
  };
  const moduleRef = {
    get: (type: unknown) => {
      if (type === MailerService) return mailer;
      if (type === WebPushService) return push;
      throw new Error('not provided');
    },
  };
  return { emails, pushes, mailer, push, moduleRef };
}

/**
 * A connected CRM mailbox.
 *
 * NOT AN INCIDENTAL STUB — `dispatch` refuses outright when `senderFor(user, 'crm')` is null, on the
 * reasoning that an email leaving under an address the recipient does not recognise is worse than
 * one that never left. Returning null here made every CRM email test fail with "no CRM email account
 * is connected", which was the chain working correctly and the fixture being wrong. The `'crm'`
 * scope is the point: it is what stops a CRM email leaving from a Transaction Desk mailbox.
 */
const accountsStub = {
  defaultFor: async () => ({ id: 1, email: 'crm-desk@example.test', scope: 'crm' }),
  senderFor: async () => ({ id: 1, email: 'crm-desk@example.test', scope: 'crm' }),
} as never;

function crmEmail(tx: PrismaService, t: ReturnType<typeof transport>) {
  return new CrmAdvancedEmailService(
    tx, t.mailer as never, accountsStub,
    new CrmTriggersService(tx, new NotificationPreferenceService(tx)),
  );
}

function dispatcher(tx: PrismaService, t: ReturnType<typeof transport>) {
  return new NotificationDispatcher(tx, new NotificationPreferenceService(tx), t.moduleRef as never);
}

const notifier = (tx: PrismaService, t: ReturnType<typeof transport>) =>
  new CrmEventNotifier(dispatcher(tx, t), tx);

// ---------------------------------------------------------------- fixtures

async function makeAgent(tx: PrismaService): Promise<AuthUserRecord> {
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `Chain agent ${tag()}`, email: `chain-agent-${tag()}@example.test`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return { ...u, user_permissions: [] } as unknown as AuthUserRecord;
}

async function makeLead(tx: PrismaService, ownerId: number, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `Chain lead ${tag()}`, email: `chain-lead-${tag()}@example.test`,
      owner_user_id: ownerId, created_at: now, updated_at: now, ...over,
    } as never,
  });
}

/** The brokerage master switch for CRM per-lead emails. */
async function setMasterSwitch(tx: PrismaService, on: boolean) {
  const row = await tx.crm_email_settings.findFirst({ orderBy: { id: 'asc' } });
  const now = new Date();
  if (row) await tx.crm_email_settings.update({ where: { id: row.id }, data: { auto_send_enabled: on, updated_at: now } });
  else await tx.crm_email_settings.create({ data: { auto_send_enabled: on, created_at: now, updated_at: now } as never });
}

/**
 * One person's CRM trigger, on or off.
 *
 * THE THREE AUTOMATIC ONES DEFAULT TO OFF — welcome, birthday and anniversary — because each is
 * timer-driven rather than button-driven: nobody chose the moment, so the brokerage has to opt in.
 * Every test below that expects a send therefore turns its trigger ON explicitly, and that is not
 * boilerplate: a test that passed without it would be proving the default rather than the chain.
 *
 * THEY ARE ALSO STORED IN TWO DIFFERENT PLACES, which is why this helper branches. The greetings
 * moved to `notification_preferences` (one row per user/category/channel); `welcome` and the
 * button-driven keys are still a JSON blob of toggles on `crm_trigger_settings`, one row per user.
 * `isEnabledFor` hides that split from callers — this reproduces it so the tests drive the real
 * stores rather than a convenient fiction.
 */
const GREETING_CATEGORY: Record<string, string> = {
  birthday: 'crm_birthday', anniversary: 'crm_anniversary', seasonal: 'crm_seasonal',
};

async function setTrigger(tx: PrismaService, userId: number, key: string, on: boolean) {
  const now = new Date();
  const category = GREETING_CATEGORY[key];

  if (category) {
    await tx.notification_preferences.upsert({
      where: { user_id_category_channel: { user_id: userId, category, channel: 'email' } },
      create: { user_id: userId, category, channel: 'email', enabled: on, created_at: now, updated_at: now },
      update: { enabled: on, updated_at: now },
    });
    return;
  }

  const row = await tx.crm_trigger_settings.findUnique({ where: { user_id: userId } });
  const toggles = { ...(row?.template_toggles ? JSON.parse(row.template_toggles) : {}), [key]: on };
  await tx.crm_trigger_settings.upsert({
    where: { user_id: userId },
    create: { user_id: userId, template_toggles: JSON.stringify(toggles), created_at: now, updated_at: now },
    update: { template_toggles: JSON.stringify(toggles), updated_at: now },
  });
}

async function mute(tx: PrismaService, userId: number, category: string, channels: NotificationChannel[]) {
  const now = new Date();
  for (const channel of channels) {
    await tx.notification_preferences.create({
      data: { user_id: userId, category, channel, enabled: false, created_at: now, updated_at: now },
    });
  }
}

/** Log rows for this file's fixtures only — see the note on `inRollback`. */
const logRows = async (tx: PrismaService, kind: string) =>
  (await tx.crm_email_log.findMany({ where: { kind }, orderBy: { id: 'asc' } }))
    .filter((r) => MINE.test(String(r.recipient)));

/** Emails this file's fixtures received. */
const mine = (t: ReturnType<typeof transport>) => t.emails.filter((e) => MINE.test(e.to));

const ledgerFor = (tx: PrismaService, userId: number) =>
  tx.notification_deliveries.findMany({ where: { user_id: userId }, orderBy: { channel: 'asc' } });

// ================================================================ CRM EMAIL CHAIN

describe('CHAIN — Lead Welcome: new lead -> trigger -> master switch -> send -> log', () => {
  async function scene(tx: PrismaService) {
    const agent = await makeAgent(tx);
    await setMasterSwitch(tx, true);
    // Explicit: `welcome` is off until a brokerage opts in. See `setTrigger`.
    await setTrigger(tx, agent.id!, 'welcome', true);
    const lead = await makeLead(tx, agent.id!);
    return { agent, lead };
  }

  const welcome = (tx: PrismaService, t: ReturnType<typeof transport>) =>
    new LeadWelcomeService(tx, crmEmail(tx, t), null as never, null as never);

  it('delivers the whole chain and writes one log row recording success', async () => {
    await inRollback(async (tx) => {
      const { lead } = await scene(tx);
      const t = transport();

      await welcome(tx, t).sweep(new Date());

      expect(mine(t).map((e) => e.to)).toEqual([lead.email]);
      const log = await logRows(tx, 'welcome');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ recipient: lead.email, success: true, error: null });
    });
  });

  /**
   * MASTER SWITCH OFF — AND DELIBERATELY NO LOG ROW, which is the opposite of what I first asserted.
   *
   * The greeting sweeps record a refusal in `crm_email_log`; this one skips quietly. That asymmetry
   * is correct and load-bearing. The welcome sweep's already-sent exclusion READS `crm_email_log`,
   * so writing a refusal there would mark the lead as dealt with — and it would then never receive a
   * welcome, not even after somebody turned the switch back on. A birthday is date-bound and is
   * missed permanently either way, so recording it costs nothing; a welcome is recoverable, so the
   * lead has to stay eligible.
   *
   * The test therefore asserts the RECOVERY, not the absence of a row: that is what the design is
   * actually promising, and it is what would break if somebody "fixed" the missing log entry.
   */
  it('MASTER SWITCH OFF skips quietly and leaves the lead eligible for when it is turned back on', async () => {
    await inRollback(async (tx) => {
      const { lead } = await scene(tx);
      await setMasterSwitch(tx, false);
      const t = transport();

      await welcome(tx, t).sweep(new Date());
      expect(mine(t)).toHaveLength(0);
      // Nothing recorded — so nothing has been "spent" on this lead.
      expect(await logRows(tx, 'welcome')).toHaveLength(0);

      // Somebody turns it back on. The lead must still be waiting.
      await setMasterSwitch(tx, true);
      await welcome(tx, t).sweep(new Date());

      expect(mine(t).map((e) => e.to)).toEqual([lead.email]);
      expect(await logRows(tx, 'welcome')).toHaveLength(1);
    });
  });

  it('INDIVIDUAL TRIGGER OFF stops it too, and the log says trigger rather than master switch', async () => {
    await inRollback(async (tx) => {
      const { agent } = await scene(tx);
      await setTrigger(tx, agent.id!, 'welcome', false);
      const t = transport();

      await welcome(tx, t).sweep(new Date());

      expect(mine(t)).toHaveLength(0);
      const log = await logRows(tx, 'welcome');
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      // Two true reasons are possible when both are off; with only the trigger off it must be this
      // one, or an administrator is sent to the wrong screen.
      expect(log[0].error).not.toMatch(/Brokerage Controls/i);
    });
  });

  /**
   * THE TEMPLATE SWITCH IS A THIRD GATE, separate from the master switch and from the per-user
   * trigger. Settings → Templates can deactivate `crm.lead_welcome` on its own, and a brokerage that
   * has done so must not have welcomes going out under a template nobody has approved.
   */
  it('INDIVIDUAL TEMPLATE OFF stops the send, and names the template', async () => {
    await inRollback(async (tx) => {
      const { agent } = await scene(tx);
      const now = new Date();
      await tx.email_templates.upsert({
        where: { event_key: 'crm.lead_welcome' },
        create: {
          event_key: 'crm.lead_welcome', module: 'crm', name: 'New lead welcome', subject: 'Welcome',
          body_html: '<p>Welcome</p>', is_active: false, created_at: now, updated_at: now,
        } as never,
        update: { is_active: false, updated_at: now },
      });

      const reason = await crmEmail(tx, transport()).welcomeBlockedReason(agent.id!);
      expect(reason).toMatch(/template is switched off/i);
      expect(reason).toMatch(/Templates/i);
    });
  });

  it('DUPLICATE SCHEDULER RUNS send once — the second pass finds it already logged', async () => {
    await inRollback(async (tx) => {
      await scene(tx);
      const t = transport();
      const svc = welcome(tx, t);

      await svc.sweep(new Date());
      await svc.sweep(new Date());
      await svc.sweep(new Date());

      expect(mine(t)).toHaveLength(1);
      expect(await logRows(tx, 'welcome')).toHaveLength(1);
    });
  });

  it('SCHEDULER RESTART sends nothing again — idempotency is in the log, not in memory', async () => {
    await inRollback(async (tx) => {
      await scene(tx);
      const t = transport();

      await welcome(tx, t).sweep(new Date());
      // A brand-new service instance, as a restarted process would build.
      await welcome(tx, t).sweep(new Date());

      expect(mine(t)).toHaveLength(1);
    });
  });

  it('DELIVERY FAILURE is logged with its reason and is not retried on the next pass', async () => {
    await inRollback(async (tx) => {
      await scene(tx);
      const t = transport({ mailFails: true });
      const svc = welcome(tx, t);

      await svc.sweep(new Date());
      await svc.sweep(new Date());

      const log = await logRows(tx, 'welcome');
      expect(log).toHaveLength(1);              // attempted once, not once per pass
      expect(log[0].success).toBe(false);
      expect(log[0].error).toMatch(/smtp|refused|failed/i);
    });
  });

  it('LARGE VOLUME drains completely, once each', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await setMasterSwitch(tx, true);
      await setTrigger(tx, agent.id!, 'welcome', true);
      const now = new Date();
      await tx.leads.createMany({
        data: Array.from({ length: 250 }, (_, i) => ({
          name: `Vol ${i}`, email: `vol-${tag()}-${i}@example.test`,
          owner_user_id: agent.id!, created_at: now, updated_at: now,
        })) as never,
      });
      const t = transport();
      const svc = welcome(tx, t);

      for (let i = 0; i < 6; i += 1) await svc.sweep(new Date());

      expect(mine(t)).toHaveLength(250);
      expect(new Set(mine(t).map((e) => e.to)).size).toBe(250);
    });
  });
});

describe('CHAIN — Birthday and Anniversary greetings', () => {
  const greetings = (tx: PrismaService, t: ReturnType<typeof transport>) =>
    new LeadGreetingsService(tx, crmEmail(tx, t), null as never, null as never);

  /** A lead whose date falls today, in a year long past — what a real date of birth looks like. */
  const dateOf = (today: Date, yearsAgo: number) =>
    new Date(Date.UTC(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate()));

  async function scene(tx: PrismaService, field: 'date_of_birth' | 'marriage_day', key: string) {
    const agent = await makeAgent(tx);
    await setMasterSwitch(tx, true);
    await setTrigger(tx, agent.id!, key, true);
    const today = new Date();
    const lead = await makeLead(tx, agent.id!, { [field]: dateOf(today, 30) });
    return { agent, lead, today };
  }

  it.each([
    ['birthday', 'date_of_birth'],
    ['anniversary', 'marriage_day'],
  ] as const)('%s: event -> send -> log, exactly once', async (kind, field) => {
    await inRollback(async (tx) => {
      const { lead, today } = await scene(tx, field, kind);
      const t = transport();
      const svc = greetings(tx, t);

      await svc.sweep(today);
      await svc.sweep(today);   // a second pass the same day must add nothing

      expect(mine(t).map((e) => e.to)).toEqual([lead.email]);
      const log = await logRows(tx, kind);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ recipient: lead.email, success: true });
    });
  });

  it('birthday: MASTER SWITCH OFF blocks it and records the reason', async () => {
    await inRollback(async (tx) => {
      const { today } = await scene(tx, 'date_of_birth', 'birthday');
      await setMasterSwitch(tx, false);
      const t = transport();

      await greetings(tx, t).sweep(today);

      expect(mine(t)).toHaveLength(0);
      const log = await logRows(tx, 'birthday');
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      expect(log[0].error).toMatch(/switched off/i);
    });
  });

  it('birthday: the per-user trigger OFF blocks it independently of the master switch', async () => {
    await inRollback(async (tx) => {
      const { agent, today } = await scene(tx, 'date_of_birth', 'birthday');
      // `setTrigger` rather than `mute`: the scene has already written this row, and a second
      // create would collide on the (user, category, channel) unique index.
      await setTrigger(tx, agent.id!, 'birthday', false);
      const t = transport();

      await greetings(tx, t).sweep(today);

      expect(mine(t)).toHaveLength(0);
    });
  });

  it('a lead with BOTH dates today gets both, once each', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await setMasterSwitch(tx, true);
      await setTrigger(tx, agent.id!, 'birthday', true);
      await setTrigger(tx, agent.id!, 'anniversary', true);
      const today = new Date();
      const lead = await makeLead(tx, agent.id!, {
        date_of_birth: dateOf(today, 30), marriage_day: dateOf(today, 5),
      });
      const t = transport();
      const svc = greetings(tx, t);

      await svc.sweep(today);
      await svc.sweep(today);

      expect(mine(t).filter((e) => e.to === lead.email)).toHaveLength(2);
      expect(await logRows(tx, 'birthday')).toHaveLength(1);
      expect(await logRows(tx, 'anniversary')).toHaveLength(1);
    });
  });
});

// ================================================================ DISPATCHER CHAIN

describe('CHAIN — the dispatcher events', () => {
  async function recipient(tx: PrismaService) {
    const agent = await makeAgent(tx);
    const lead = await makeLead(tx, agent.id!);
    return { agent, lead };
  }

  it('LEAD ASSIGNED: event -> preferences -> all three channels -> ledger', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      const t = transport();

      await notifier(tx, t).leadAssigned(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
        agent.id!, null, 'Someone',
      );

      expect(t.emails).toHaveLength(1);
      expect(t.pushes).toEqual([agent.id]);
      expect(await tx.notifications.count({ where: { user_id: agent.id!, category: 'lead_assigned' } })).toBe(1);
      const ledger = await ledgerFor(tx, agent.id!);
      expect(ledger.map((r) => r.channel)).toEqual(['email', 'in_app', 'push']);
      expect(ledger.every((r) => r.status === 'sent')).toBe(true);
    });
  });

  it('META LEAD RECEIVED: event -> notification -> ledger, and twice sends once', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      const t = transport();
      const n = notifier(tx, t);

      const meta = { id: lead.id, first_name: lead.name, last_name: null, email: lead.email };
      await n.metaLeadArrived(meta, agent.id!, 'form-1');
      await n.metaLeadArrived(meta, agent.id!, 'form-1');

      expect(t.emails).toHaveLength(1);
      expect(await tx.notifications.count({ where: { user_id: agent.id!, category: 'lead_meta' } })).toBe(1);
    });
  });

  it('CAMPAIGN COMPLETED and CAMPAIGN FAILED each notify once, and are distinct occurrences', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const t = transport();
      const n = notifier(tx, t);

      await n.campaignCompleted({ id: 4242, name: 'Spring' }, agent.id!, { recipients: 10, sent: 9, failed: 1 });
      await n.campaignCompleted({ id: 4242, name: 'Spring' }, agent.id!, { recipients: 10, sent: 9, failed: 1 });
      await n.campaignFailed({ id: 4242, name: 'Spring' }, agent.id!, 'Failed');

      expect(t.emails).toHaveLength(2);   // one completed, one failed — not three
      const cats = await tx.notifications.findMany({
        where: { user_id: agent.id! }, select: { category: true },
      });
      expect(cats.map((c) => c.category).sort()).toEqual(['campaign_completed', 'campaign_failed']);
    });
  });

  it('FOLLOW-UP REMINDER: due task -> sweep -> notification -> ledger, once per occurrence', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      const now = new Date();
      const task = await tx.lead_tasks.create({
        data: {
          lead_id: lead.id, title: 'Call back', due_date: now, status: 'pending',
          assigned_to: agent.id!, created_at: now, updated_at: now,
        } as never,
      });
      const t = transport();
      const svc = new LeadTaskReminderService(tx, notifier(tx, t), null as never, null as never);

      await svc.sweep(now);
      await svc.sweep(now);   // still overdue, already told — must add nothing

      expect(mine(t)).toHaveLength(1);
      const ledger = await ledgerFor(tx, agent.id!);
      expect(ledger).toHaveLength(3);
      expect(ledger[0].dedupe_key).toContain(`lead-task-due:${task.id}:`);
    });
  });

  /**
   * CHANNEL INDEPENDENCE. Switching off email must silence email and nothing else — the failure this
   * guards against is a preference that quietly takes another channel with it.
   */
  it('EMAIL / IN-APP / PUSH are independent: muting one leaves the others delivering', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      await mute(tx, agent.id!, 'lead_assigned', ['email']);
      const t = transport();

      await notifier(tx, t).leadAssigned(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
        agent.id!, null, 'Someone',
      );

      expect(t.emails).toHaveLength(0);                    // muted
      expect(t.pushes).toEqual([agent.id]);                // untouched
      expect(await tx.notifications.count({ where: { user_id: agent.id! } })).toBe(1);   // untouched

      const ledger = await ledgerFor(tx, agent.id!);
      expect(ledger.find((r) => r.channel === 'email')!.status).toBe('muted');
      expect(ledger.find((r) => r.channel === 'push')!.status).toBe('sent');
      expect(ledger.find((r) => r.channel === 'in_app')!.status).toBe('sent');
    });
  });

  /**
   * THE BROKERAGE MASTER SWITCH IS THE CRM EMAIL CHAIN'S, NOT THE DISPATCHER'S. Turning it off must
   * not silence transaction and lead notifications — they are a different system with its own
   * per-channel preferences, and conflating the two would take out far more than anyone intended.
   */
  it('the CRM master switch does NOT silence dispatcher notifications', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      await setMasterSwitch(tx, false);
      const t = transport();

      await notifier(tx, t).leadAssigned(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
        agent.id!, null, 'Someone',
      );

      expect(t.emails).toHaveLength(1);
      expect(t.pushes).toHaveLength(1);
    });
  });

  it('a FAILED delivery is recorded with its reason and not retried', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      const t = transport({ mailFails: true });
      const n = notifier(tx, t);
      const payload = { id: lead.id, first_name: lead.name, last_name: null, email: lead.email };

      await n.leadAssigned(payload, agent.id!, null, 'Someone');
      await n.leadAssigned(payload, agent.id!, null, 'Someone');

      const email = (await ledgerFor(tx, agent.id!)).find((r) => r.channel === 'email')!;
      expect(email.status).toBe('failed');
      expect(email.detail).toMatch(/smtp|refused/i);
      // Push and in-app still went, on the same event — one channel failing must not take the rest.
      expect(t.pushes).toHaveLength(1);
    });
  });

  it('an INACTIVE recipient is not notified at all', async () => {
    await inRollback(async (tx) => {
      const { agent, lead } = await recipient(tx);
      await tx.users.update({ where: { id: agent.id! }, data: { status: 'Inactive' } });
      const t = transport();

      await notifier(tx, t).leadAssigned(
        { id: lead.id, first_name: lead.name, last_name: null, email: lead.email },
        agent.id!, null, 'Someone',
      );

      expect(t.emails).toHaveLength(0);
      expect(t.pushes).toHaveLength(0);
      expect(await ledgerFor(tx, agent.id!)).toHaveLength(0);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
