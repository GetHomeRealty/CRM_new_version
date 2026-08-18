import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { WebPushService } from '../calendar/web-push.service';
import {
  NOTIFICATION_CHANNELS,
  NotificationPreferenceService,
  type NotificationChannel,
} from './notification-preference.service';

/** What a module hands the dispatcher when something happens. */
export interface NotificationRequest {
  /** A key from NOTIFICATION_CATEGORIES. Decides which preference row governs delivery. */
  category: string;
  /** Who should be told. One person; a module with several recipients calls once per recipient. */
  userId: number;
  title: string;
  body?: string;
  /** Where "open the related record" goes, e.g. `/desk/transactions/41`. */
  link?: string;
  /**
   * Idempotency handle. Two deliveries with the same key for the same person are the same
   * notification, and the second is dropped — which is what makes a retried job safe.
   *
   * IT IDENTIFIES AN OCCURRENCE, so it must carry the entity AND when: `lead-task-due:4182:
   * 2026-08-15` says which follow-up and which day it fell due. A key of just the entity would
   * notify once and never again; a key that changes every pass would not dedupe at all.
   *
   * Enforced in `notification_deliveries`, per channel, independently of any preference — see
   * `claim` below.
   *
   * ================================================================================================
   * SETTLED POLICY: NO KEY MEANS NO DEDUPLICATION, AND NO KEY IS EVER INVENTED FOR YOU. A request
   * without one is delivered every time it is made, writes nothing to the ledger, and behaves
   * exactly as it did before the ledger existed.
   *
   * That is correct for an event raised BY something happening — a campaign finishing, a person
   * approving a change, somebody being mentioned. Each call is a distinct event, and a synthesised
   * key (a hash of the payload, say) would silently merge two real occurrences that happened to look
   * alike, which is a worse failure than a duplicate because nothing records it.
   *
   * SO ANY CALLER A SWEEP CAN INVOKE MORE THAN ONCE FOR THE SAME THING MUST PASS A STABLE KEY, and
   * it is the caller's job to build one, because only the caller knows what "the same thing" means.
   * Every scheduler-driven site currently does: `lead-task-due:{task}:{due date}`,
   * `{kind}-{txn}-{day}`, `calendar-reminder-{reminder}`, `inbox-{account}-{uid}`.
   * ================================================================================================
   */
  dedupeKey?: string;
  /** Overrides for the email body, when the plain title/body would read poorly as a message. */
  email?: { subject?: string; html?: string };
  /** Overrides for the push payload. */
  push?: { title?: string; body?: string; url?: string };
  /**
   * Restrict delivery to these channels.
   *
   * WHY THIS IS NEEDED, rather than always attempting all three. Several event sites already send
   * their own email and push, with their own delivery records, retry handling and failure rows —
   * the calendar reminder sweep is one. Those sites want the dispatcher for the channel they do NOT
   * already cover, and routing the others through it as well would send each notification twice.
   *
   * Omitted means "every channel this category supports", which is what a new sender wants.
   *
   * A preference still wins: naming a channel here asks for it, it does not force it. Muting is the
   * person's decision and no call site may override it.
   */
  channels?: NotificationChannel[];
}

export type SkipReason = 'muted' | 'unsupported' | 'no_address' | 'not_configured' | 'duplicate';

export interface DispatchResult {
  category: string;
  userId: number;
  delivered: NotificationChannel[];
  skipped: Array<{ channel: NotificationChannel; reason: SkipReason }>;
  failed: Array<{ channel: NotificationChannel; error: string }>;
}

/**
 * The one place that decides what actually gets sent, and sends it.
 *
 * WHY THIS EXISTS. Without it, every module grows its own copy of the same four steps — find the
 * recipient, read their preference, decide the channels, call the senders — and they drift. The
 * drift is silent and it is always in the same direction: a new sender forgets the preference check,
 * so somebody's setting quietly stops being honoured and nothing anywhere reports it. Concentrating
 * it here means a module says WHAT happened and to WHOM, and never how to reach them.
 *
 *   module → dispatch({ category, userId, title, … })
 *              ↓
 *            claim (user, category, occurrence, channel) in the delivery ledger
 *              ↓
 *            preferences for (user, category)
 *              ↓
 *            in-app · email · push — whichever are supported AND enabled
 *
 * DEDUPLICATION IS THE LEDGER'S JOB, AND IT IS NOT ANY CHANNEL'S. It used to be a side effect of the
 * unique index on `notifications(user_id, dedupe_key)`, which made "have we sent this?" a question
 * only the in-app row could answer. Two failures followed from that, and both were live:
 *
 *   MUTING IN-APP DISABLED DEDUPE. No in-app row is written for a muted channel, so nothing recorded
 *   that the notification had happened — and a recipient who kept email on received it again on
 *   every pass, precisely because they had turned off the channel that was doing the bookkeeping.
 *
 *   EMAIL AND PUSH WERE NEVER DEDUPED. Only `sendInApp` consulted the key at all. Any sweep that
 *   re-selects a row — a follow-up still overdue because nobody has done it yet — re-sent on both.
 *
 * `notification_deliveries` now records one row per (recipient, category, occurrence, channel), for
 * every channel including muted ones, claimed BEFORE the send. So the rule is the same for all three
 * channels, it survives any preference change, and it holds for every category without a scheduler
 * having to implement anything of its own.
 *
 * NOTHING HERE THROWS AT THE CALLER. A notification is a side effect of somebody's real work: a
 * closing does not fail because a phone was unreachable. Every channel is attempted independently
 * and the result says what happened on each, so a caller that cares can log or retry, and one that
 * does not can ignore it safely.
 *
 * WHY THE SENDERS ARE RESOLVED LAZILY. `MailerService` and `WebPushService` live in modules that
 * already import the notification module's dependencies; injecting them directly closes a cycle that
 * `forwardRef` only moves — the same problem, with the same measurements, as `OtpDeliveryService`.
 * `ModuleRef` asks the running application for a provider it has already constructed.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly log = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prefs: NotificationPreferenceService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Deliver one notification to one person. */
  async dispatch(request: NotificationRequest): Promise<DispatchResult> {
    const result: DispatchResult = {
      category: request.category,
      userId: request.userId,
      delivered: [],
      skipped: [],
      failed: [],
    };

    const user = await this.recipient(request.userId);
    if (!user) {
      // Not an error worth throwing: a deleted or deactivated account is a normal outcome for a
      // sweep that resolved its recipients a moment earlier.
      this.log.debug(`No deliverable recipient for user #${request.userId} (${request.category}).`);
      return result;
    }

    const choices = await this.prefs.channelsFor(user.id, request.category);

    const requested = request.channels && request.channels.length
      ? NOTIFICATION_CHANNELS.filter((c) => request.channels!.includes(c))
      : NOTIFICATION_CHANNELS;

    for (const channel of requested) {
      /*
       * THE CLAIM COMES FIRST — BEFORE THE PREFERENCE, NOT AFTER IT.
       *
       * This ordering is the entire fix and it is easy to undo by accident. If the mute check ran
       * first, a muted channel would `continue` without writing anything, and the ledger would once
       * again be a record only of what was DELIVERED rather than of what was HANDLED. A recipient
       * with everything muted would leave no trace at all, so every later pass would treat the
       * occurrence as new — which is how a scheduler that reads the ledger starves.
       *
       * Claiming first means the row exists whatever happens next, and `status` carries the outcome.
       */
      const claim = await this.claim(user.id, request, channel);
      if (claim === 'duplicate') {
        result.skipped.push({ channel, reason: 'duplicate' });
        continue;
      }

      if (!choices[channel]) {
        // `channelsFor` returns false both for "muted" and for "this category has no such channel";
        // the second is reported distinctly so a caller can tell a choice from a limitation.
        const reason: SkipReason = this.unsupported(request.category, channel) ? 'unsupported' : 'muted';
        result.skipped.push({ channel, reason });
        await this.settle(claim, reason);
        continue;
      }

      try {
        const outcome = await this.send(channel, request, user);
        if (outcome === true) result.delivered.push(channel);
        else result.skipped.push({ channel, reason: outcome });
        await this.settle(claim, outcome === true ? 'sent' : outcome);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result.failed.push({ channel, error: message });
        this.log.warn(`Could not deliver "${request.category}" to user #${user.id} by ${channel}: ${message}`);
        /*
         * ============================================================================================
         * SETTLED POLICY: A FAILED DELIVERY KEEPS ITS CLAIM. Do not release or delete it here, and do
         * not let a scheduler retry it by re-selecting the row on the next pass.
         *
         * The reasoning is the same one the CRM greeting sweeps already follow: given a notification
         * that arrives twice and one that does not arrive, the duplicate is what people report as a
         * fault, and the miss is visible — right here, with `status = 'failed'` and the reason beside
         * it. Releasing the claim would turn one transient SMTP error into a repeat send on every
         * pass for as long as the underlying row stays selectable, which for an overdue follow-up is
         * indefinitely.
         *
         * IF RETRIES ARE WANTED LATER, they must be a controlled mechanism and not the absence of
         * this line: an attempt count, a next-retry time, a maximum, and a terminal failed state —
         * the shape `calendar_event_reminders` already uses. Deleting the claim is not that
         * mechanism; it is unbounded retry with no record.
         * ============================================================================================
         */
        await this.settle(claim, 'failed', message);
      }
    }

    if (result.delivered.length || result.failed.length) {
      this.log.log(
        `"${request.category}" for user #${user.id}: delivered [${result.delivered.join(', ') || 'none'}]`
        + `${result.failed.length ? `, failed [${result.failed.map((f) => f.channel).join(', ')}]` : ''}`,
      );
    }
    return result;
  }

  /**
   * May this person be reached on this channel for this category?
   *
   * FOR SENDERS THAT DELIVER THEIR OWN MESSAGE. Some events already produce something much better
   * than a generic notification — the document-review outcome is a templated email listing every
   * document, which passed and why the rest did not. Routing that through `dispatch` would replace a
   * good message with a plain one; ignoring the dispatcher would put the preference check back in
   * the module, which is the drift this service exists to stop.
   *
   * So the split is: the dispatcher owns the DECISION, always; delivery may be its own or the
   * caller's. A sender with a bespoke message asks this first and sends only if it answers true.
   */
  async shouldSend(userId: number, category: string, channel: NotificationChannel): Promise<boolean> {
    const user = await this.recipient(userId);
    if (!user) return false;
    return (await this.prefs.channelsFor(user.id, category))[channel] === true;
  }

  // ========================================================================== the delivery ledger

  /**
   * Take ownership of one (recipient, category, occurrence, channel) before sending on it.
   *
   * Returns the ledger row's id when this call won the claim, `'duplicate'` when somebody already
   * holds it, and `null` when the request carries no `dedupeKey` and is therefore not deduped at
   * all — in which case nothing is recorded and behaviour is exactly what it was before the ledger.
   *
   * ================================================================================================
   * WHY `createMany({ skipDuplicates })` RATHER THAN "look, then insert".
   *
   * Read-then-write has a window between the two, and two processes in that window both read
   * "nothing there" and both send. The window is small and a thirty-minute sweep across two
   * instances hits it eventually, which is the definition of a bug that only ever appears in
   * production. `skipDuplicates` compiles to ON CONFLICT DO NOTHING, so the database decides, once.
   *
   * It also must not RAISE on the collision. In PostgreSQL a unique violation aborts the enclosing
   * transaction, and every later statement then fails with 25P02 — so a caller that creates a record
   * and notifies inside one transaction would have its real work rolled back by a duplicate
   * notification. `count === 0` is how a loss is detected, and nothing is thrown.
   * ================================================================================================
   *
   * A FAILURE HERE DOES NOT STOP THE SEND. If the ledger write itself errors, the notification is
   * still delivered and simply not deduped — the same behaviour as before this table existed. A
   * bookkeeping table must not be able to silence the thing it books.
   */
  private async claim(
    userId: number,
    request: NotificationRequest,
    channel: NotificationChannel,
  ): Promise<number | 'duplicate' | null> {
    const key = request.dedupeKey?.slice(0, 190);
    if (!key) return null;

    const now = new Date();
    try {
      const written = await this.prisma.notification_deliveries.createMany({
        data: [{
          user_id: userId,
          category: request.category,
          dedupe_key: key,
          channel,
          status: 'pending',
          created_at: now,
          updated_at: now,
        }],
        skipDuplicates: true,
      });
      if (written.count === 0) return 'duplicate';

      const row = await this.prisma.notification_deliveries.findFirst({
        where: { user_id: userId, category: request.category, dedupe_key: key, channel },
        select: { id: true },
      });
      return row?.id ?? null;
    } catch (err) {
      this.log.warn(
        `Delivery ledger unavailable for "${request.category}" to user #${userId} by ${channel}; `
        + `sending without deduplication: ${(err as Error)?.message ?? String(err)}`,
      );
      return null;
    }
  }

  /** Record what became of a claimed channel. A no-op for an unclaimed (undeduped) request. */
  private async settle(claim: number | 'duplicate' | null, status: string, detail?: string): Promise<void> {
    if (typeof claim !== 'number') return;
    try {
      await this.prisma.notification_deliveries.update({
        where: { id: claim },
        data: { status, detail: detail?.slice(0, 2000) ?? null, updated_at: new Date() },
      });
    } catch {
      // The claim is what prevents a duplicate; the status is only for reading afterwards. Losing
      // the second must not undo the first, and must not fail the caller's real work.
    }
  }

  /** Several recipients, one event. Independent: one person's failure does not stop the others. */
  async dispatchMany(userIds: number[], request: Omit<NotificationRequest, 'userId'>): Promise<DispatchResult[]> {
    const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
    const results: DispatchResult[] = [];
    for (const userId of unique) {
      results.push(await this.dispatch({ ...request, userId }));
    }
    return results;
  }

  // ========================================================================== channels

  /** True on delivery, or a reason it was skipped. Throws only on a genuine failure. */
  private async send(
    channel: NotificationChannel,
    request: NotificationRequest,
    user: { id: number; email: string | null },
  ): Promise<true | SkipReason> {
    switch (channel) {
      case 'in_app':
        return this.sendInApp(request, user);
      case 'email':
        return this.sendEmail(request, user);
      case 'push':
        return this.sendPush(request, user);
      default:
        return 'unsupported';
    }
  }

  /**
   * In-app: a row in `notifications`, which the Notification Centre reads as a fifth source.
   *
   * ITS UNIQUE INDEX IS NO LONGER THE DEDUPE MECHANISM — `notification_deliveries` is, and it has
   * already run by the time this is called. The index stays because a second copy of an in-app
   * notification is wrong regardless of how it came about, and because rows written before the
   * ledger existed are still out there; it is now a backstop rather than the rule. A duplicate is
   * reported as skipped rather than raised, as before.
   *
   * WHY `createMany({ skipDuplicates })` RATHER THAN `create` IN A TRY/CATCH. Catching the P2002 is
   * not enough, and the difference is not cosmetic: in PostgreSQL a unique violation ABORTS THE
   * ENCLOSING TRANSACTION. Every later statement then fails with 25P02 — "current transaction is
   * aborted" — so a module that creates a record and notifies inside one transaction would have its
   * REAL WORK rolled back by a duplicate notification. That is the exact failure this service exists
   * to prevent, and it was measured here rather than reasoned about: the idempotency test failed on
   * the query after the collision, not on the collision itself.
   *
   * `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`, which never raises, so the transaction
   * stays healthy and `count === 0` is how a duplicate is detected.
   */
  private async sendInApp(
    request: NotificationRequest,
    user: { id: number },
  ): Promise<true | SkipReason> {
    const written = await this.prisma.notifications.createMany({
      data: [{
        user_id: user.id,
        category: request.category,
        title: request.title.slice(0, 255),
        body: request.body ?? null,
        link: request.link?.slice(0, 255) ?? null,
        dedupe_key: request.dedupeKey?.slice(0, 190) ?? null,
        created_at: new Date(),
      }],
      skipDuplicates: true,
    });

    return written.count > 0 ? true : 'duplicate';
  }

  private async sendEmail(
    request: NotificationRequest,
    user: { id: number; email: string | null },
  ): Promise<true | SkipReason> {
    if (!user.email) return 'no_address';

    const mailer = this.resolve(MailerService);
    if (!mailer) return 'not_configured';

    const subject = request.email?.subject ?? request.title;
    const html = request.email?.html ?? this.defaultEmailBody(request);
    await mailer.sendDirect(user.email, subject, html, null, [], user.id);
    return true;
  }

  private async sendPush(
    request: NotificationRequest,
    user: { id: number },
  ): Promise<true | SkipReason> {
    const push = this.resolve(WebPushService);
    if (!push || !push.configured()) return 'not_configured';

    /*
     * The category is deliberately NOT passed to `sendToUser`. That argument makes it re-check the
     * preference, and the preference has already been checked here — passing it would mean two
     * lookups per push, and a second place the answer could differ from the one that decided to
     * send. `sendToUser` never throws, so a `sent: 0` (no subscribed browser) is reported as a skip
     * rather than a failure.
     */
    const outcome = await push.sendToUser(user.id, {
      title: request.push?.title ?? request.title,
      body: request.push?.body ?? request.body ?? '',
      url: request.push?.url ?? request.link ?? undefined,
    } as never);

    return outcome.sent > 0 ? true : 'not_configured';
  }

  // ========================================================================== helpers

  /**
   * The recipient, if they can be notified at all.
   *
   * An inactive account is not notified: the same rule `AuthService.loadUser` applies, so somebody
   * who has been deactivated stops receiving mail about deals they can no longer open.
   */
  private async recipient(userId: number): Promise<{ id: number; email: string | null } | null> {
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true },
    });
    if (!user) return null;
    if ((user.status ?? 'Active') === 'Inactive') return null;
    return { id: user.id, email: user.email };
  }

  /** Whether the category simply has no such channel, as opposed to the person having muted it. */
  private unsupported(category: string, channel: NotificationChannel): boolean {
    // Imported lazily from the definition list to avoid a second copy of the map living here.
    const definition = NotificationPreferenceService.categoryFor(category);
    return definition?.channels[channel] === 'unsupported';
  }

  /** A plain, readable message for callers that do not supply their own HTML. */
  private defaultEmailBody(request: NotificationRequest): string {
    const link = request.link
      ? `<p><a href="${this.absolute(request.link)}">Open it in the app</a></p>`
      : '';
    return `
      <p>${this.escape(request.title)}</p>
      ${request.body ? `<p>${this.escape(request.body)}</p>` : ''}
      ${link}
      <p style="color:#666;font-size:12px">
        You can change which notifications reach you, and how, under Notification Preferences.
      </p>
    `;
  }

  private absolute(link: string): string {
    const base = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
    return link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
  }

  /** Titles and bodies come from records people typed into; they are not trusted as HTML. */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** A provider from the running application, or null if it is not there. */
  private resolve<T>(type: new (...args: never[]) => T): T | null {
    try {
      return this.moduleRef.get(type, { strict: false });
    } catch {
      this.log.error(`${type.name} could not be resolved — that channel cannot deliver.`);
      return null;
    }
  }
}
