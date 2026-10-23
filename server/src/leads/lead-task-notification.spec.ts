import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { LeadActivityService } from './lead-activity.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadTaskNotificationService } from './lead-task-notification.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { MailerService } from '../email/mailer.service';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import type { CrmEventNotifier } from '../notifications/crm-events.service';

/**
 * TASK EMAILS, END TO END THROUGH THE REAL TASK SAVE — against the test database, with the MAIL
 * SERVER MOCKED. Nothing here opens an SMTP connection: `sendFromAccount` is a jest function, and the
 * jest mail guard would divert anything else. Delivery to a real mailbox is a separate, manual check.
 *
 * Covers the brief's verification list: creation, assignment at creation, assignment afterwards,
 * reassignment, unchanged assignments, creator = agent, a missing address, a failing mail server,
 * a server that may not send, and that a rolled-back save queues nothing.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

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

interface Sent { to: string; subject: string; html: string; text: string }

function wire(tx: PrismaService, opts: { muted?: number[] } = {}) {
  const sent: Sent[] = [];
  const failures: unknown[] = [];
  const mailer = {
    resolveSender: jest.fn(async () => ({ id: 1, from_email: 'crm@example.test' })),
    sendFromAccount: jest.fn(async (_a: unknown, m: { to: string[]; subject: string; html: string; text: string }) => {
      const f = failures.shift();
      if (f) throw f;
      sent.push({ to: m.to[0], subject: m.subject, html: m.html, text: m.text });
      return { messageId: 'test' };
    }),
  } as unknown as MailerService;
  const dispatcher = {
    shouldSend: jest.fn(async (userId: number) => !(opts.muted ?? []).includes(userId)),
  } as unknown as NotificationDispatcher;
  const crmEvents = { taskAssigned: jest.fn(async () => undefined) };
  const access = new ResourceAccessService(tx);
  const emails = new LeadTaskNotificationService(tx, mailer, access, undefined, undefined, dispatcher);
  const activity = new LeadActivityService(
    access, tx, new LeadAuditService(tx),
    null as never, null as never, null as never, null as never,
    crmEvents as unknown as CrmEventNotifier, emails,
  );
  return { activity, emails, sent, failures, mailer, crmEvents };
}

async function makeUser(tx: PrismaService, opts: { email?: string | null; role?: string } = {}): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: {
      name: `Task person ${t}`, email: opts.email === undefined ? `task-${t}@example.test` : opts.email,
      role: opts.role ?? 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    } as never,
  });
  return { ...u, user_permissions: [] } as unknown as AuthUserRecord;
}

async function makeLead(tx: PrismaService, owner: number, extra: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `Client ${tag()}`, email: `client-${tag()}@example.test`, phone: '4165550199',
      property: '12 King St W', location: 'Toronto',
      owner_user_id: owner, created_at: now, updated_at: now, ...extra,
    } as never,
  });
}

const rows = (tx: PrismaService, taskId: number) =>
  tx.lead_task_notifications.findMany({ where: { task_id: taskId }, orderBy: { id: 'asc' } });

let redirectSpy: jest.SpyInstance;
beforeEach(() => {
  // The jest mail guard makes this machine a sink. These tests are about what the SERVICE does when
  // it may send, with the mailer mocked, so they stand in a "may send" world; one test below puts
  // the sink back to prove nothing is recorded as sent there.
  redirectSpy = jest.spyOn(MailerService, 'redirectTarget').mockReturnValue(null);
  process.env.FRONTEND_URL = 'https://crm.example.test';
});
afterEach(() => redirectSpy.mockRestore());
afterAll(() => prisma.$disconnect());

describe('creating a task', () => {
  it('emails the creator and, separately, the agent', async () => {
    await inRollback(async (tx) => {
      const creator = await makeUser(tx);
      const agent = await makeUser(tx);
      const lead = await makeLead(tx, creator.id!, { assigned_to: agent.id });
      const { activity, emails, sent, crmEvents } = wire(tx);

      const saved = await activity.addTask(lead.id, { title: 'CALL BACK', due_date: '2026-10-21', assigned_to: agent.id, description: 'Ask about units' }, creator) as Record<string, unknown>;
      await emails.idle();

      expect(saved.email_warnings).toEqual(expect.not.arrayContaining([expect.stringMatching(/no valid email/)]));
      expect((saved.email_notifications as { status: string }[]).map((n) => n.status)).toEqual(['queued', 'queued']);
      expect(sent.map((m) => [m.to, m.subject])).toEqual([
        [creator.email, 'Task Created: CALL BACK'],
        [agent.email, 'New Task Assigned to You: CALL BACK'],
      ]);
      const toAgent = sent[1];
      for (const s of [`#${saved.id}`, 'Ask about units', 'Medium', 'Pending', creator.name!, agent.name!, '4165550199', '12 King St W']) {
        expect(toAgent.html).toContain(s);
      }
      expect(toAgent.html).toContain(`https://crm.example.test/crm/lead/${lead.id}?task=${saved.id}`);
      expect((await rows(tx, saved.id as number)).map((r) => r.status)).toEqual(['sent', 'sent']);
      // In-app and push still go out, but are told the email is handled here — no third email.
      expect(crmEvents.taskAssigned).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), agent.id, creator.id, creator.name, { emailHandledElsewhere: true },
      );
    });
  });

  it('sends ONE combined email when the creator assigns it to themselves', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent } = wire(tx);

      // No assignee in the body = "Assign to me", which is what the form sends by default.
      const saved = await activity.addTask(lead.id, { title: 'Send listings', due_date: '2026-10-22' }, me) as { id: number };
      await emails.idle();

      expect(sent.map((m) => [m.to, m.subject])).toEqual([[me.email, 'Task Created and Assigned to You: Send listings']]);
      expect((await rows(tx, saved.id)).map((r) => r.kind)).toEqual(['created_assigned']);
    });
  });

  it('emails only the creator when nobody is assigned', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent } = wire(tx);
      await activity.addTask(lead.id, { title: 'Unowned', due_date: '2026-10-22', assigned_to: 'unassigned' }, me);
      await emails.idle();
      expect(sent.map((m) => m.subject)).toEqual(['Task Created: Unowned']);
    });
  });
});

describe('changing the agent afterwards', () => {
  it('emails each newly assigned agent, and nothing for saves that do not change the agent', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const b = await makeUser(tx);
      const c = await makeUser(tx);
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [b.id, c.id] });
      const { activity, emails, sent } = wire(tx);

      const task = await activity.addTask(lead.id, { title: 'Follow up', due_date: '2026-10-22', assigned_to: 'unassigned' }, me) as { id: number };
      await emails.idle();
      sent.length = 0;

      // Assignment after creation.
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id }, me);
      await emails.idle();
      expect(sent.map((m) => [m.to, m.subject])).toEqual([[b.email, 'New Task Assigned to You: Follow up']]);

      // Saves that leave the agent alone: same agent, status, title, priority.
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id }, me);
      await activity.updateTask(lead.id, task.id, { title: 'Follow up again', priority: 'high' }, me);
      await activity.updateTask(lead.id, task.id, { status: 'completed' }, me);
      await activity.updateTask(lead.id, task.id, { status: 'pending' }, me);
      await emails.idle();
      expect(sent).toHaveLength(1);

      // Reassignment, then handing it back: both are new hand-overs.
      await activity.updateTask(lead.id, task.id, { assigned_to: c.id }, me);
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id }, me);
      await emails.idle();
      expect(sent.map((m) => m.to)).toEqual([b.email, c.email, b.email]);
      expect((await rows(tx, task.id)).map((r) => r.dedupe_key)).toEqual([
        `task-created:${task.id}:${me.id}`,
        `task-assigned:${task.id}:1:${b.id}`,
        `task-assigned:${task.id}:2:${c.id}`,
        `task-assigned:${task.id}:3:${b.id}`,
      ]);
    });
  });

  it('a repeated reassignment request queues the email once', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const b = await makeUser(tx);
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [b.id] });
      const { activity, emails, sent } = wire(tx);
      const task = await activity.addTask(lead.id, { title: 'Twice', due_date: '2026-10-22', assigned_to: 'unassigned' }, me) as { id: number };
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id }, me);
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id }, me);
      await emails.idle();
      expect(sent.filter((m) => m.to === b.email)).toHaveLength(1);
    });
  });
});

describe('when an email cannot go', () => {
  it('saves the task and warns when the agent has no valid address', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const noMail = await makeUser(tx, { email: '' });
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [noMail.id] });
      const { activity, emails, sent } = wire(tx);

      const saved = await activity.addTask(lead.id, { title: 'Call', due_date: '2026-10-22', assigned_to: noMail.id }, me) as Record<string, unknown>;
      await emails.idle();

      expect(await tx.lead_tasks.findUnique({ where: { id: saved.id as number } })).toMatchObject({ assigned_to: noMail.id });
      expect(saved.email_warnings).toEqual(expect.arrayContaining([expect.stringContaining(`${noMail.name} has no valid email address on file`)]));
      expect(sent.map((m) => m.to)).toEqual([me.email]);   // the creator's confirmation still goes
      const r = await rows(tx, saved.id as number);
      expect(r.map((x) => [x.kind, x.status])).toEqual([['created', 'sent'], ['assigned', 'skipped']]);
    });
  });

  it('retries a temporary failure on a schedule, then delivers once', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent, failures } = wire(tx);
      failures.push(Object.assign(new Error('451 try again later'), { responseCode: 451 }));

      const saved = await activity.addTask(lead.id, { title: 'Retry me', due_date: '2026-10-22' }, me) as { id: number };
      await emails.idle();
      let [row] = await rows(tx, saved.id);
      expect(row).toMatchObject({ status: 'pending', attempts: 1 });
      expect(row.error_message).toMatch(/Attempt 1 of 5 failed: 451 try again later/);
      expect(sent).toHaveLength(0);

      // Not due yet: nothing happens.
      await emails.sweep(new Date());
      expect(sent).toHaveLength(0);

      // Due: delivered, once.
      await emails.sweep(new Date(Date.now() + 2 * 60_000));
      await emails.sweep(new Date(Date.now() + 10 * 60_000));
      expect(sent).toHaveLength(1);
      [row] = await rows(tx, saved.id);
      expect(row).toMatchObject({ status: 'sent', attempts: 2, error_message: null });
    });
  });

  it('marks a refused message failed, and does not resend one whose outcome is unknown until asked', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent, failures } = wire(tx);

      failures.push(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
      const refused = await activity.addTask(lead.id, { title: 'Refused', due_date: '2026-10-22' }, me) as { id: number };
      await emails.idle();
      expect((await rows(tx, refused.id))[0]).toMatchObject({ status: 'failed', error_message: '550 mailbox unavailable' });

      failures.push(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNRESET' }));
      const unknown = await activity.addTask(lead.id, { title: 'Unknown', due_date: '2026-10-22' }, me) as { id: number };
      await emails.idle();
      const [row] = await rows(tx, unknown.id);
      expect(row.status).toBe('failed');
      expect(row.error_message).toMatch(/^Outcome unknown/);

      await emails.sweep(new Date(Date.now() + 3 * 60 * 60_000));
      expect(sent).toHaveLength(0);

      // A person chooses to send it again.
      const after = await emails.retry(me, lead.id, row.id);
      expect(after).toMatchObject({ status: 'sent' });
      expect(sent.map((m) => m.subject)).toEqual(['Task Created and Assigned to You: Unknown']);
    });
  });

  it('records "not sent", never "sent", on a server that is not allowed to deliver', async () => {
    await inRollback(async (tx) => {
      redirectSpy.mockReturnValue(MailerService.DEV_SINK);
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, mailer } = wire(tx);

      const saved = await activity.addTask(lead.id, { title: 'Quiet', due_date: '2026-10-22' }, me) as Record<string, unknown>;
      await emails.idle();

      expect(saved.email_warnings).toEqual([expect.stringMatching(/outgoing email is switched off on this server.*MAIL_ALLOW_REAL_SEND=1/)]);
      expect((saved.email_notifications as { status: string }[])[0].status).toBe('skipped');
      expect((mailer.sendFromAccount as jest.Mock)).not.toHaveBeenCalled();
      expect((await rows(tx, saved.id as number))[0].status).toBe('skipped');
    });
  });

  it('honours an agent who turned task emails off, and still confirms to the creator', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const b = await makeUser(tx);
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [b.id] });
      const { activity, emails, sent } = wire(tx, { muted: [b.id!] });
      const saved = await activity.addTask(lead.id, { title: 'Muted', due_date: '2026-10-22', assigned_to: b.id }, me) as { id: number };
      await emails.idle();
      expect(sent.map((m) => m.to)).toEqual([me.email]);
      expect((await rows(tx, saved.id))[1]).toMatchObject({ status: 'skipped', error_message: expect.stringMatching(/Notification Preferences/) });
    });
  });
});

describe('what the agent is shown', () => {
  it('shows client details only to an agent who may open the lead', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const outsider = await makeUser(tx);
      const onLead = await makeUser(tx);
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [onLead.id, outsider.id] });
      const { activity, emails, sent } = wire(tx);

      // The outsider was on the lead when the task was given, and has lost access since — the
      // notice is delivered after that, so it must not carry the client's details.
      const forOutsider = await activity.addTask(lead.id, { title: 'For outsider', due_date: '2026-10-22', assigned_to: 'unassigned' }, me) as { id: number };
      await emails.idle();
      await activity.updateTask(lead.id, forOutsider.id, { assigned_to: outsider.id }, me);
      await tx.leads.update({ where: { id: lead.id }, data: { collaborator_user_ids: [onLead.id] } });
      await emails.idle();
      sent.length = 0;
      const notice = (await rows(tx, forOutsider.id)).find((r) => r.recipient_user_id === outsider.id)!;
      await tx.lead_task_notifications.update({ where: { id: notice.id }, data: { status: 'pending' } });
      await emails.deliver(notice.id);
      await activity.addTask(lead.id, { title: 'For collaborator', due_date: '2026-10-22', assigned_to: onLead.id }, me);
      await emails.idle();

      const toOutsider = sent.find((m) => m.to === outsider.email)!;
      const toOnLead = sent.find((m) => m.to === onLead.email)!;
      expect(toOutsider.html).not.toContain('4165550199');
      expect(toOutsider.html).not.toContain(lead.email as string);
      expect(toOnLead.html).toContain('4165550199');
    });
  });

  it('does not send an assignment notice to an agent the task has since moved away from', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const b = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent } = wire(tx);
      const task = await activity.addTask(lead.id, { title: 'Moved', due_date: '2026-10-22', assigned_to: 'unassigned' }, me) as { id: number };
      await emails.idle();
      const now = new Date();
      const stale = await tx.lead_task_notifications.create({
        data: { task_id: task.id, lead_id: lead.id, kind: 'assigned', recipient_user_id: b.id!, dedupe_key: `test-stale-${tag()}`, status: 'pending', created_at: now, updated_at: now },
      });
      await emails.deliver(stale.id);
      expect(sent.filter((m) => m.to === b.email)).toHaveLength(0);
      expect(await tx.lead_task_notifications.findUnique({ where: { id: stale.id } })).toMatchObject({ status: 'skipped' });
    });
  });
});

describe('who a task can go to', () => {
  const refusal = (name: string | null) =>
    expect.objectContaining({ response: expect.objectContaining({ message: expect.stringMatching(new RegExp(`^${name} can't open this lead.*collaborator`)) }) });

  it('refuses someone who cannot open the lead, on create and on reassignment, and queues no email', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const accountant = await makeUser(tx, { role: 'accounting' });   // brokerage scope, not an agent's private book
      const lead = await makeLead(tx, me.id!);
      const { activity, emails, sent } = wire(tx);

      await expect(activity.addTask(lead.id, { title: 'Process deposit', due_date: '2026-10-22', assigned_to: accountant.id }, me))
        .rejects.toEqual(refusal(accountant.name));
      expect(await tx.lead_tasks.count({ where: { lead_id: lead.id } })).toBe(0);

      const task = await activity.addTask(lead.id, { title: 'Mine first', due_date: '2026-10-22' }, me) as { id: number };
      await emails.idle();
      sent.length = 0;
      await expect(activity.updateTask(lead.id, task.id, { assigned_to: accountant.id, title: 'Renamed' }, me))
        .rejects.toEqual(refusal(accountant.name));
      expect(await tx.lead_tasks.findUnique({ where: { id: task.id } })).toMatchObject({ assigned_to: me.id, title: 'Mine first' });
      await emails.idle();
      expect(sent).toHaveLength(0);
    });
  });

  it('accepts them once they are a collaborator, and the brokerage\'s own leads for brokerage-scope roles', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const accountant = await makeUser(tx, { role: 'accounting' });
      const shared = await makeLead(tx, me.id!, { collaborator_user_ids: [accountant.id] });
      const brokerage = await makeLead(tx, me.id!, { owner_user_id: null, assigned_to: me.id });
      const { activity, emails } = wire(tx);

      await expect(activity.addTask(shared.id, { title: 'Shared', due_date: '2026-10-22', assigned_to: accountant.id }, me)).resolves.toBeDefined();
      await expect(activity.addTask(brokerage.id, { title: 'Brokerage', due_date: '2026-10-22', assigned_to: accountant.id }, me)).resolves.toBeDefined();
      await emails.idle();
    });
  });

  it('still lets a task be worked when its agent has since lost access', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const b = await makeUser(tx);
      const lead = await makeLead(tx, me.id!, { collaborator_user_ids: [b.id] });
      const { activity, emails } = wire(tx);
      const task = await activity.addTask(lead.id, { title: 'Older', due_date: '2026-10-22', assigned_to: b.id }, me) as { id: number };
      await tx.leads.update({ where: { id: lead.id }, data: { collaborator_user_ids: [] } });

      // Re-saving the same agent alongside other fields is not a new assignment.
      await activity.updateTask(lead.id, task.id, { assigned_to: b.id, status: 'completed' }, me);
      await activity.updateTask(lead.id, task.id, { assigned_to: me.id }, me);
      expect(await tx.lead_tasks.findUnique({ where: { id: task.id } })).toMatchObject({ assigned_to: me.id, status: 'completed' });
      await emails.idle();
    });
  });
});

describe('only after the save commits', () => {
  it('a save that rolls back leaves no email behind', async () => {
    let taskId = 0;
    const mailer = { resolveSender: jest.fn(), sendFromAccount: jest.fn() } as unknown as MailerService;
    await expect(prisma.$transaction(async (raw) => {
      const tx = raw as unknown as PrismaService;
      const me = await makeUser(tx);
      const lead = await makeLead(tx, me.id!);
      const emails = new LeadTaskNotificationService(tx, mailer, new ResourceAccessService(tx));
      const now = new Date();
      const task = await tx.lead_tasks.create({ data: { lead_id: lead.id, title: 'Doomed', due_date: now, created_at: now, updated_at: now } });
      taskId = task.id;
      expect(await emails.queueNewTask(tx, task, me.id!)).toHaveLength(1);
      throw new Error('the save failed after queueing');
    })).rejects.toThrow('the save failed after queueing');

    expect(taskId).toBeGreaterThan(0);
    expect(await prisma.lead_task_notifications.count({ where: { task_id: taskId } })).toBe(0);
    expect(mailer.sendFromAccount).not.toHaveBeenCalled();
  });
});
