import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { lead_task_notifications } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { externalMailProblem } from '../config/environment';
import { ResourceAccessService } from '../core/resource-access.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  TASK_EMAIL_MAX_ATTEMPTS, classifyTaskSendFailure, nextRetryDelayMs, planNewTaskEmails,
  planReassignmentEmail, renderTaskEmail, validEmail, type PlannedTaskEmail, type TaskEmailKind,
} from './lead-task-email';

/** The table, from the service itself or from the transaction the task is being saved in. */
type Db = Pick<PrismaService, 'lead_task_notifications'>;

/** One queued email, as the task's save response reports it. */
export interface TaskEmailOutcome {
  kind: TaskEmailKind;
  recipient_user_id: number;
  recipient_name: string | null;
  /** `queued` = will be sent in the background; `skipped` = will not be sent, `message` says why. */
  status: 'queued' | 'skipped';
  message: string;
}

export interface TaskEmailReport {
  email_notifications: TaskEmailOutcome[];
  /** Plain sentences for the screen. Empty when every email is on its way. */
  email_warnings: string[];
}

/** Every minute: the shortest retry wait is one minute. */
const SWEEP_INTERVAL_MS = 60 * 1000;
const FIRST_SWEEP_MS = 40 * 1000;
/** A row still `sending` after this was interrupted mid-send — a crash or a restart. */
const STALE_SENDING_MS = 15 * 60 * 1000;
const ERROR_MAX = 500;

const UNKNOWN_OUTCOME = 'Outcome unknown: the mail server did not confirm, and may have received it. Not sent again automatically.';

const short = (err: unknown): string => String((err as Error)?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 300);

/** A sending problem that is about setup, not about the message — nothing reached a mail server. */
class EmailSetupError extends Error {}

/**
 * EMAIL ABOUT LEAD TASKS — the creator's confirmation, the assigned agent's notice, or one combined
 * message when they are the same person (brokerage request, 21 Oct 2026).
 *
 * AN OUTBOX. `queue*` runs INSIDE the transaction that saves the task, so a row exists only if the
 * task committed: a save that rolls back can never be announced. Delivery happens after the commit,
 * in the background — the person saving the task never waits on a mail server, and a mail failure
 * can never undo the task. Every outcome is written back to `lead_task_notifications`, which is
 * where a failed delivery is found and retried from.
 *
 * DUPLICATES are stopped in three places: the unique `dedupe_key` (a repeated request cannot queue
 * twice), the claim (`pending` → `sending` in one conditional UPDATE, so the API process and the
 * worker cannot both send one row), and the classification of failures (a send whose outcome is
 * unknown is never retried automatically, because it may already have arrived).
 *
 * RETRIES are bounded: `TASK_EMAIL_MAX_ATTEMPTS` in total, backing off 1, 5, 15 and 60 minutes,
 * and only for failures that prove nothing was delivered. The worker's sweep picks them up.
 *
 * WHY NOT `NotificationDispatcher` for the email. It deliberately keeps a failed delivery's claim
 * and never retries (see its "SETTLED POLICY" notes), and it has no way to report back to the screen
 * that an agent has no address. In-app and push still go through it — `CrmEventNotifier.taskAssigned`
 * is told to leave email to this service.
 */
@Injectable()
export class LeadTaskNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeadTaskNotificationService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly access: ResourceAccessService,
    // Optional so a test can construct the service without Redis or the dispatcher.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  // ================================================================================ the worker sweep

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.LEAD_TASK_EMAILS_SWEEP_DISABLED === '1') {
      this.log.log(`Lead task email retries not scheduled (${process.env.LEAD_TASK_EMAILS_SWEEP_DISABLED === '1'
        ? 'LEAD_TASK_EMAILS_SWEEP_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    registerWorker('lead-task-emails', SWEEP_INTERVAL_MS);
    // Once across the cluster when Redis is available — the claim makes a second runner harmless,
    // but there is no reason to do the work twice.
    const tick = this.redis && this.cache
      ? clusterTick({ redis: this.redis, cache: this.cache }, 'lead-task-emails', () => this.sweep())
      : () => void this.sweep();
    setTimeout(tick, FIRST_SWEEP_MS).unref?.();
    this.timer = setInterval(tick, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass: close rows interrupted mid-send, then deliver whatever is due.
   *
   * A row left `sending` is NOT resent. The process that held it may have handed the message to the
   * mail server before it died, so the honest record is "outcome unknown" and a person decides.
   */
  async sweep(now: Date = new Date()): Promise<{ delivered: number; interrupted: number }> {
    const stale = await this.prisma.lead_task_notifications.updateMany({
      where: { status: 'sending', last_attempt_at: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
      data: { status: 'failed', error_message: `${UNKNOWN_OUTCOME} (interrupted while sending)`, updated_at: now },
    });
    const due = await this.prisma.lead_task_notifications.findMany({
      where: { status: 'pending', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      orderBy: { id: 'asc' },
      take: 50,
      select: { id: true },
    });
    let delivered = 0;
    for (const { id } of due) {
      if (await this.deliver(id, now)) delivered += 1;
    }
    return { delivered, interrupted: stale.count };
  }

  // ======================================================================== queueing (in the save)

  /** Queue the emails a new task produces. Call with the transaction that created the task. */
  async queueNewTask(db: Db, task: { id: number; lead_id: number; assigned_to: number | null }, actorUserId: number | null): Promise<number[]> {
    return this.insert(db, task, planNewTaskEmails(task.id, actorUserId, task.assigned_to), actorUserId);
  }

  /**
   * Queue the new agent's email after the assignee changed. Call with the transaction that changed it,
   * AFTER the conditional update that proved the change — that update holds the task's row lock, so
   * counting earlier assignments here cannot race another reassignment of the same task.
   */
  async queueReassignment(
    db: Db, task: { id: number; lead_id: number }, before: number | null, after: number | null, actorUserId: number | null,
  ): Promise<number[]> {
    const earlier = await db.lead_task_notifications.count({
      where: { task_id: task.id, kind: { in: ['assigned', 'created_assigned'] } },
    });
    const plan = planReassignmentEmail(task.id, before, after, earlier + 1);
    return this.insert(db, task, plan ? [plan] : [], actorUserId);
  }

  /** Which assignment this is, for the in-app notice's own dedupe key. 1 for the first. */
  async assignmentNumber(taskId: number): Promise<number> {
    return this.prisma.lead_task_notifications.count({
      where: { task_id: taskId, kind: { in: ['assigned', 'created_assigned'] } },
    });
  }

  private async insert(db: Db, task: { id: number; lead_id: number }, plan: PlannedTaskEmail[], actorUserId: number | null): Promise<number[]> {
    if (!plan.length) return [];
    // Whole seconds, as the TIMESTAMP(0) column stores it, so the read-back below can match on it
    // and so report only rows THIS call inserted — never an older one a duplicate key collided with.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    // skipDuplicates (ON CONFLICT DO NOTHING): a repeat never raises, so it cannot abort the
    // transaction the task is being saved in.
    await db.lead_task_notifications.createMany({
      data: plan.map((p) => ({
        task_id: task.id, lead_id: task.lead_id, kind: p.kind, recipient_user_id: p.recipientUserId,
        actor_user_id: actorUserId, dedupe_key: p.dedupeKey, status: 'pending', created_at: now, updated_at: now,
      })),
      skipDuplicates: true,
    });
    const rows = await db.lead_task_notifications.findMany({
      where: { dedupe_key: { in: plan.map((p) => p.dedupeKey) }, created_at: now },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ========================================================================== after the commit

  /**
   * What the screen should say about the emails just queued, and the start of their delivery.
   *
   * Anything that can be known NOW is settled now — an agent with no valid address, an inactive
   * account, a server that is not allowed to send — so the person saving the task is told while
   * they are still looking at it. Delivery itself is started and NOT awaited.
   */
  async afterCommit(rowIds: number[]): Promise<TaskEmailReport> {
    const report: TaskEmailReport = { email_notifications: [], email_warnings: [] };
    if (!rowIds.length) return report;

    const rows = await this.prisma.lead_task_notifications.findMany({ where: { id: { in: rowIds } }, orderBy: { id: 'asc' } });
    const people = await this.users(rows.map((r) => r.recipient_user_id));
    const setup = await this.setupProblems();
    const toSend: number[] = [];
    let blockedBySetup = false;

    for (const row of rows) {
      const who = people.get(row.recipient_user_id);
      const name = who?.name ?? null;
      const role = row.kind === 'created' ? 'confirmation' : 'assignment';
      // `skip` is the sentence for the screen; `reason` is what the row records, read beside the
      // recipient's name on the lead page, so it does not repeat it.
      let skip: string | null = null;
      let reason = '';
      let bySetup = false;
      if (!who || (who.status ?? 'Active') === 'Inactive') {
        skip = `${name ?? 'The recipient'}'s account is inactive, so the ${role} email was not sent.`;
        reason = 'The recipient\'s account is inactive.';
      } else if (!validEmail(who.email)) {
        skip = `${name ?? 'The recipient'} has no valid email address on file, so the ${role} email could not be sent. `
          + 'The task was saved. Add their email under Users and use Retry.';
        reason = 'No valid email address on file. Add one under Users, then Retry.';
      } else if (setup.blocked) {
        skip = `The ${role} email to ${name ?? 'the recipient'} was not sent: ${setup.blocked}`;
        reason = `Not sent: ${setup.blocked}`;
        bySetup = true;
        blockedBySetup = true;
      }

      if (skip) {
        await this.settle(row.id, 'skipped', reason);
        report.email_notifications.push({ kind: row.kind as TaskEmailKind, recipient_user_id: row.recipient_user_id, recipient_name: name, status: 'skipped', message: skip });
        // A server-wide reason is said once, below, rather than once per recipient.
        if (!bySetup) report.email_warnings.push(skip);
        continue;
      }
      toSend.push(row.id);
      report.email_notifications.push({
        kind: row.kind as TaskEmailKind, recipient_user_id: row.recipient_user_id, recipient_name: name, status: 'queued',
        message: `${row.kind === 'created' ? 'Confirmation' : row.kind === 'assigned' ? 'Assignment' : 'Confirmation and assignment'} email to ${name ?? 'the recipient'} is queued.`,
      });
    }

    if (blockedBySetup) report.email_warnings.push(`Task emails were not sent: ${setup.blocked}`);
    if (toSend.length) report.email_warnings.push(...setup.warnings);
    // Background: the response does not wait, and nothing thrown here can reach the caller.
    const run = (async () => {
      for (const id of toSend) await this.deliver(id);
    })().catch((err) => this.log.warn(`Background task email delivery stopped: ${short(err)}`));
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
    return report;
  }

  /** Background deliveries started by `afterCommit` that have not finished yet. */
  private readonly inFlight = new Set<Promise<void>>();

  /** Resolves once every background delivery started so far has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  /**
   * What stands between this server and a delivered email, in words a person can act on.
   *
   * `blocked` means nothing CAN be delivered from here, so a row is recorded as not sent rather than
   * left to look as if it went. `warnings` are problems that do not stop the send.
   */
  async setupProblems(): Promise<{ blocked: string | null; warnings: string[] }> {
    const warnings: string[] = [];
    const redirect = MailerService.redirectTarget();
    if (redirect === MailerService.DEV_SINK) {
      return {
        blocked: `outgoing email is switched off on this server (${externalMailProblem() ?? 'MAIL_REAL_SEND_HOST does not match this machine'}). `
          + 'Real delivery needs APP_ENV=production, NODE_ENV=production, the approved production DATABASE_URL and MAIL_ALLOW_REAL_SEND=1 (and MAIL_REAL_SEND_HOST, if set, must name this machine).',
        warnings,
      };
    }
    if (redirect) warnings.push(`Email on this server is redirected to ${redirect} (MAIL_REDIRECT_TO), not to the recipient.`);

    const accounts = await this.prisma.mail_accounts.count({ where: { is_active: true } });
    if (!accounts) {
      warnings.push('Email is not set up: no active mail account is connected. Connect one under Settings → Email accounts; '
        + `the email is waiting and will be retried up to ${TASK_EMAIL_MAX_ATTEMPTS} times.`);
    }
    if (!(process.env.FRONTEND_URL ?? '').trim()) {
      warnings.push('FRONTEND_URL is not set on the server, so the email cannot include a View Task button.');
    }
    return { blocked: null, warnings };
  }

  // ================================================================================== delivery

  /**
   * Send one row, if it is still waiting and nobody else has it. True when it was delivered.
   *
   * Never throws: everything that happens is written to the row. `now` is the sweep's clock, so a
   * test can stand at a retry's due time instead of waiting for it.
   */
  async deliver(id: number, now: Date = new Date()): Promise<boolean> {
    const claimed = await this.prisma.lead_task_notifications.updateMany({
      where: { id, status: 'pending', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      data: { status: 'sending', attempts: { increment: 1 }, last_attempt_at: now, updated_at: now },
    });
    if (claimed.count !== 1) return false;
    const row = await this.prisma.lead_task_notifications.findUnique({ where: { id } });
    if (!row) return false;

    try {
      const message = await this.compose(row);
      if ('skip' in message) {
        await this.settle(id, 'skipped', message.skip);
        return false;
      }
      const setup = await this.setupProblems();
      if (setup.blocked) {
        await this.settle(id, 'skipped', `Not sent: ${setup.blocked}`);
        return false;
      }

      let account;
      try {
        account = await this.mailer.resolveSender(null, row.recipient_user_id);
      } catch (err) {
        throw new EmailSetupError(`Email is not set up: ${short(err)}`);
      }
      // ONE transport attempt. Retrying is decided here from what the failure proves — inside the
      // mailer a connection lost after the server took the message looks transient, and its own
      // retry would deliver a second copy.
      await this.mailer.sendFromAccount(account, {
        to: [message.to], subject: message.subject, html: message.html, text: message.text, maxAttempts: 1,
      });

      const redirect = MailerService.redirectTarget();
      await this.prisma.lead_task_notifications.update({
        where: { id },
        data: {
          status: 'sent', sent_at: new Date(), error_message: null, next_attempt_at: null, subject: message.subject.slice(0, 255),
          to_email: (redirect ? `${message.to} (redirected to ${redirect})` : message.to).slice(0, 255), updated_at: new Date(),
        },
      });
      this.log.log(`Task email #${id} (${row.kind}, task ${row.task_id}) sent to user #${row.recipient_user_id}.`);
      return true;
    } catch (err) {
      await this.failed(row, err);
      return false;
    }
  }

  /** Record a failed attempt: back to `pending` with a retry time, or `failed` for good. */
  private async failed(row: lead_task_notifications, err: unknown): Promise<void> {
    const kind = err instanceof EmailSetupError ? 'retry' : classifyTaskSendFailure(err);
    const attempts = row.attempts;   // already incremented by the claim
    const delay = kind === 'retry' ? nextRetryDelayMs(attempts) : null;
    const now = row.last_attempt_at ?? new Date();
    if (delay !== null) {
      const next = new Date(now.getTime() + delay);
      await this.prisma.lead_task_notifications.update({
        where: { id: row.id },
        data: {
          status: 'pending', next_attempt_at: next, updated_at: now,
          error_message: `Attempt ${attempts} of ${TASK_EMAIL_MAX_ATTEMPTS} failed: ${short(err)}. Retrying automatically.`.slice(0, ERROR_MAX),
        },
      });
      this.log.warn(`Task email #${row.id} attempt ${attempts} failed (${short(err)}); next try ${next.toISOString()}.`);
      return;
    }
    const why = kind === 'unknown' ? `${UNKNOWN_OUTCOME} (${short(err)})`
      : kind === 'retry' ? `Gave up after ${attempts} attempts: ${short(err)}` : short(err);
    await this.settle(row.id, 'failed', why);
    this.log.warn(`Task email #${row.id} (${row.kind}, task ${row.task_id}) failed: ${why}`);
  }

  private async settle(id: number, status: 'skipped' | 'failed', why: string): Promise<void> {
    await this.prisma.lead_task_notifications.update({
      where: { id },
      data: { status, error_message: why.slice(0, ERROR_MAX), next_attempt_at: null, updated_at: new Date() },
    });
  }

  /**
   * The message for one row, built from the task AS IT IS NOW — or why it should not be sent.
   *
   * Read at send time rather than at save time, so a retry an hour later describes the task as it
   * stands, and an assignment notice for an agent who has since been replaced is not sent at all.
   */
  private async compose(row: lead_task_notifications): Promise<{ to: string; subject: string; html: string; text: string } | { skip: string }> {
    const task = await this.prisma.lead_tasks.findUnique({ where: { id: row.task_id } });
    if (!task) return { skip: 'The task was deleted before the email was sent.' };
    if (row.kind !== 'created' && task.assigned_to !== row.recipient_user_id) {
      return { skip: 'The task was reassigned before this email was sent; the new agent is notified instead.' };
    }
    const lead = await this.prisma.leads.findFirst({
      where: { id: task.lead_id, deleted_at: null },
      select: { id: true, name: true, email: true, phone: true, property: true, property_address: true, location: true },
    });
    if (!lead) return { skip: 'The lead was deleted before the email was sent.' };

    const people = await this.users([row.recipient_user_id, row.actor_user_id, task.assigned_to]);
    const recipient = people.get(row.recipient_user_id);
    if (!recipient || (recipient.status ?? 'Active') === 'Inactive') return { skip: 'The recipient\'s account is inactive.' };
    const to = validEmail(recipient.email);
    if (!to) return { skip: `${recipient.name ?? 'The recipient'} has no valid email address on file.` };

    // The agent's notice honours their own choice, exactly as the dispatcher would.
    if (row.kind === 'assigned' && this.dispatcher && !(await this.dispatcher.shouldSend(row.recipient_user_id, 'task_assigned', 'email'))) {
      return { skip: 'Turned off by the recipient under Notification Preferences (Tasks assigned to you → Email).' };
    }
    if (row.kind === 'assigned') {
      const tpl = await this.prisma.email_templates.findUnique({ where: { event_key: 'crm.task_assigned' }, select: { is_active: true } });
      if (tpl && !tpl.is_active) return { skip: 'The "Task Assigned" email is switched off under Settings → Templates.' };
    }

    // Client details only for someone the lead page itself would let in.
    let canSeeLead = true;
    try {
      await this.access.assertLead({ id: recipient.id, role: recipient.role, name: recipient.name }, lead.id);
    } catch {
      canSeeLead = false;
    }

    const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    const rendered = renderTaskEmail({
      kind: row.kind as TaskEmailKind,
      recipientName: recipient.name ?? '',
      task: { id: task.id, title: task.title, description: task.description, priority: task.priority, status: task.status, due_date: task.due_date },
      creatorName: (row.actor_user_id ? people.get(row.actor_user_id)?.name : null) ?? task.created_by,
      agentName: task.assigned_to ? people.get(task.assigned_to)?.name ?? null : null,
      client: canSeeLead
        ? {
          name: lead.name,
          phone: lead.phone,
          email: lead.email && !/\.invalid$/i.test(lead.email) ? lead.email : null,
          property: lead.property_address || lead.property,
          location: lead.location,
        }
        : null,
      // `/crm/lead/:id` is the lead page; `task` tells it which task to bring into view. The route
      // is behind sign-in and the lead's own access check, so the link grants nothing by itself.
      viewUrl: base ? `${base}/crm/lead/${lead.id}?task=${task.id}` : null,
    });
    return { to, ...rendered };
  }

  private async users(ids: Array<number | null | undefined>) {
    const wanted = [...new Set(ids.filter((v): v is number => Number.isInteger(v) && (v as number) > 0))];
    const rows = wanted.length
      ? await this.prisma.users.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, email: true, status: true, role: true } })
      : [];
    return new Map(rows.map((u) => [u.id, u]));
  }

  // =================================================================================== reading

  /** Every task email on this lead, newest first, for the lead page. */
  async forLead(user: AuthUserRecord, leadId: number): Promise<{ data: Record<string, unknown>[] }> {
    await this.access.assertLead(user, leadId);
    const rows = await this.prisma.lead_task_notifications.findMany({
      where: { lead_id: leadId }, orderBy: { id: 'desc' }, take: 200,
    });
    const people = await this.users(rows.map((r) => r.recipient_user_id));
    return { data: rows.map((r) => this.present(r, people.get(r.recipient_user_id)?.name ?? null)) };
  }

  /**
   * Send a failed or skipped email again, at a person's request.
   *
   * The informed choice the automatic retry will not make: for an "outcome unknown" failure the
   * message may already be in the inbox, and the screen says so before offering this.
   */
  async retry(user: AuthUserRecord, leadId: number, id: number): Promise<Record<string, unknown>> {
    await this.access.assertLead(user, leadId);
    const row = await this.prisma.lead_task_notifications.findFirst({ where: { id, lead_id: leadId } });
    if (!row) throw new NotFoundException({ message: 'Email record not found.' });
    if (row.status !== 'failed' && row.status !== 'skipped') {
      throw new BadRequestException({ message: row.status === 'sent' ? 'This email was already sent.' : 'This email is already on its way.' });
    }
    const reset = await this.prisma.lead_task_notifications.updateMany({
      where: { id, status: row.status },
      data: { status: 'pending', attempts: 0, next_attempt_at: null, error_message: null, updated_at: new Date() },
    });
    if (reset.count !== 1) throw new BadRequestException({ message: 'This email is already on its way.' });
    await this.deliver(id);
    const after = await this.prisma.lead_task_notifications.findUniqueOrThrow({ where: { id } });
    const name = (await this.users([after.recipient_user_id])).get(after.recipient_user_id)?.name ?? null;
    return this.present(after, name);
  }

  private present(r: lead_task_notifications, recipientName: string | null): Record<string, unknown> {
    return {
      id: r.id, task_id: r.task_id, kind: r.kind, recipient_user_id: r.recipient_user_id, recipient_name: recipientName,
      status: r.status, attempts: r.attempts, error_message: r.error_message,
      next_attempt_at: r.next_attempt_at?.toISOString() ?? null, sent_at: r.sent_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(), retryable: r.status === 'failed' || r.status === 'skipped',
    };
  }
}
