import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { runAsSystem } from '../core/tenant-context';
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
 *            preferences for (user, category)
 *              ↓
 *            in-app · email · push — whichever are supported AND enabled
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

  /**
   * Deliver one notification to one person.
   *
   * Runs as the system: a dispatch is often triggered by a background sweep with no request and so
   * no tenant in context, and the recipient's own `company_id` is what the rows are stamped with.
   */
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
      if (!choices[channel]) {
        // `channelsFor` returns false both for "muted" and for "this category has no such channel";
        // the second is reported distinctly so a caller can tell a choice from a limitation.
        result.skipped.push({ channel, reason: this.unsupported(request.category, channel) ? 'unsupported' : 'muted' });
        continue;
      }

      try {
        const outcome = await this.send(channel, request, user);
        if (outcome === true) result.delivered.push(channel);
        else result.skipped.push({ channel, reason: outcome });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result.failed.push({ channel, error: message });
        this.log.warn(`Could not deliver "${request.category}" to user #${user.id} by ${channel}: ${message}`);
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
    user: { id: number; email: string | null; company_id: number },
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
   * The unique `(user_id, dedupe_key)` index is what makes this idempotent. A duplicate is reported
   * as skipped rather than raised — a job retried after a partial failure re-sending everything is
   * normal, and it must not leave somebody two copies or a stack trace.
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
    user: { id: number; company_id: number },
  ): Promise<true | SkipReason> {
    const written = await runAsSystem(() => this.prisma.notifications.createMany({
      data: [{
        user_id: user.id,
        category: request.category,
        title: request.title.slice(0, 255),
        body: request.body ?? null,
        link: request.link?.slice(0, 255) ?? null,
        dedupe_key: request.dedupeKey?.slice(0, 190) ?? null,
        created_at: new Date(),
        company_id: user.company_id,
      }],
      skipDuplicates: true,
    }));

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
  private async recipient(userId: number): Promise<{ id: number; email: string | null; company_id: number } | null> {
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const user = await runAsSystem(() => this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, company_id: true },
    }));
    if (!user) return null;
    if ((user.status ?? 'Active') === 'Inactive') return null;
    return { id: user.id, email: user.email, company_id: user.company_id };
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
