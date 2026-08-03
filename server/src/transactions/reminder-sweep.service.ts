import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonResolver } from '../core/person-resolver.service';
import { MailerService, isTransient } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { AuditService } from '../audit/audit.service';
import { areaPath } from '../common/domain';
import { toDateString } from '../common/serialize';
import { missingLawyerParties, tracksBothLawyers } from './lawyer-details';
import {
  EXPIRY_WINDOW_DAYS, LAWYER_TEMPLATE, LAWYER_WINDOW_DAYS,
  closingPhrase, daysBetween, expiryPhrase, expiryReminderFor, hasExpired,
  lawyerReminderFor, lawyerVariant, startOfDay, calendarDay, dbDay,
} from './reminder-schedule';

/**
 * The nightly reminder sweeps: listing expiry, automatic expiry, and lawyer details.
 *
 * WHAT MAKES THIS SAFE TO RUN TWICE. Every reminder is written to `transaction_reminders` with the
 * DAY it was due, under a unique index on (transaction, kind, day, channel). The insert is therefore
 * the lock: a second run on the same day, a retry after a crash, or two processes racing all end in
 * the same place, because the second insert fails and nothing is sent. Nothing here relies on the
 * scheduler having run exactly once.
 *
 * WHAT IT REFUSES TO DO. It never invents a status. The auto-expiry pass changes a listing from
 * Active to Expired and touches nothing else — a deal that is Sold, Leased, Closed, Suspended,
 * Terminated or anything else is left exactly as it is, because a date passing is not evidence that
 * somebody else's decision was wrong.
 */

/**
 * The scheduler has no user. `null` is what the audit writer already turns into who='System'
 * with no user_id, which is exactly right: nobody pressed anything.
 */
const SYSTEM_ACTOR = null;
const AUDIT_SECTION = 'Reminders';

/**
 * How hard a failed delivery is chased, and how long the gaps are.
 *
 * Four attempts over about seven hours, doubling each time: enough to ride out a mail server that
 * is down for an evening, few enough that a permanent problem is visible in the history rather than
 * buried under a hundred identical retries. The per-sweep cap keeps one bad night from turning the
 * next pass into a long send.
 */
const MAX_DELIVERY_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60 * 60 * 1000, 2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000];
const MAX_RETRIES_PER_SWEEP = 100;

/** Diverts every message when set, so a test environment cannot mail a real agent. */
const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};

export interface SweepResult {
  expiryReminders: number;
  expired: number;
  lawyerReminders: number;
  skipped: number;
  failed: number;
  /** Failed deliveries attempted again this pass. */
  retried: number;
  /** Of those, the ones that got through. */
  recovered: number;
}

@Injectable()
export class ReminderSweepService {
  private readonly log = new Logger(ReminderSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PersonResolver,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly audit: AuditService,
  ) {}

  /** One night's work. `today` is injectable so the schedule can be tested across a whole run-up. */
  async sweep(today: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { expiryReminders: 0, expired: 0, lawyerReminders: 0, skipped: 0, failed: 0, retried: 0, recovered: 0 };
    // Retries first: a reminder that failed last night is more urgent than tonight's new ones, and
    // clearing the backlog before adding to it keeps a bad evening from compounding.
    await this.retryFailed(today, result);
    await this.listingExpiry(today, result);
    await this.autoExpire(today, result);
    await this.lawyerDetails(today, result);

    if (result.expiryReminders || result.expired || result.lawyerReminders || result.failed) {
      this.log.log(
        `Reminders: ${result.expiryReminders} expiry, ${result.lawyerReminders} lawyer, `
        + `${result.expired} auto-expired, ${result.skipped} skipped, ${result.failed} failed, `
        + `${result.retried} retried (${result.recovered} recovered).`,
      );
    }
    return result;
  }

  // ---------------------------------------------------------------- listing expiry

  /**
   * Chase every Active listing whose expiry is one to ten days away.
   *
   * Driven by the DATA — a listing expiry date and an Active status — rather than by a list of
   * transaction types. A listing type added next year gets these reminders without anybody
   * remembering to register it, which is exactly what "no separate configuration" has to mean.
   */
  private async listingExpiry(today: Date, result: SweepResult): Promise<void> {
    const from = startOfDay(today);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + EXPIRY_WINDOW_DAYS);

    const rows = await this.prisma.transactions.findMany({
      // Indexed on listing_expiry_date: the sweep reads the handful of listings inside the window,
      // never the table.
      where: { deleted_at: null, listing_expiry_date: { gte: dbDay(from), lte: dbDay(to) } },
      select: {
        id: true, trade_no: true, property: true, agent: true, type: true,
        listing_expiry_date: true, transaction_statuses: { select: { status: true } },
      },
    });

    for (const t of rows) {
      if (!t.listing_expiry_date) continue;
      if (!this.isActive(t.transaction_statuses)) { result.skipped++; continue; }

      const { due, daysRemaining } = expiryReminderFor(today, calendarDay(t.listing_expiry_date));
      if (!due) continue;

      await this.deliver({
        txnId: t.id,
        kind: 'listing_expiry',
        variant: null,
        day: dbDay(startOfDay(today)),
        daysRemaining,
        agentName: t.agent,
        event: 'transaction.listing_expiry_reminder',
        vars: {
          deal_number: t.trade_no ?? String(t.id),
          property_address: t.property ?? '—',
          listing_type: t.type ?? '—',
          expiry_date: toDateString(t.listing_expiry_date) ?? '',
          days_remaining: String(daysRemaining),
          expiry_phrase: expiryPhrase(daysRemaining),
          agent_name: t.agent ?? 'there',
        },
        summary: `Listing ${expiryPhrase(daysRemaining)} — ${t.property ?? t.trade_no ?? ''}`.trim(),
        result,
        onSent: () => { result.expiryReminders++; },
      });
    }
  }

  /**
   * Expire what has run out — and only that.
   *
   * The guard is the whole feature: a listing is moved from Active to Expired, and any other status
   * is left alone. Sold, Leased, Closed, Suspended, Terminated, Mutual Release, DFT and Void all
   * describe something a person decided, and a date passing is not evidence that they were wrong.
   */
  private async autoExpire(today: Date, result: SweepResult): Promise<void> {
    const yesterday = new Date(startOfDay(today).getFullYear(), startOfDay(today).getMonth(), startOfDay(today).getDate() - 1);

    const rows = await this.prisma.transactions.findMany({
      where: { deleted_at: null, listing_expiry_date: { lte: dbDay(yesterday) } },
      select: {
        id: true, trade_no: true, property: true, listing_expiry_date: true,
        transaction_statuses: { select: { id: true, status: true } },
      },
    });

    for (const t of rows) {
      if (!t.listing_expiry_date || !hasExpired(today, calendarDay(t.listing_expiry_date))) continue;
      const active = t.transaction_statuses.find((s) => s.status === 'Active');
      if (!active) continue; // anything but Active is somebody's decision — leave it

      const now = new Date();
      await this.prisma.transaction_statuses.update({
        where: { id: active.id },
        data: { status: 'Expired', updated_at: now },
      });
      await this.prisma.transactions.update({ where: { id: t.id }, data: { updated_at: now } });

      await this.audit.record(t.id, SYSTEM_ACTOR, {
        section: 'Status',
        field: 'Status',
        action: 'Listing automatically expired',
        source: 'Scheduler',
        old: 'Active',
        new: 'Expired',
        details: `Transaction status automatically changed from Active to Expired because the listing expiry date (${toDateString(t.listing_expiry_date)}) was reached.`,
      });
      result.expired++;
    }
  }

  // ---------------------------------------------------------------- lawyer details

  /**
   * Chase the lawyer details a closing deal is still missing, on the phase schedule.
   *
   * The content is worked out fresh every time from what is missing NOW, which is what makes a
   * partial update work: an agent who fills in the buyer's lawyer on Tuesday is asked only for the
   * seller's on Thursday, and is not chased at all once both are there.
   */
  private async lawyerDetails(today: Date, result: SweepResult): Promise<void> {
    // Zero switches the recurring reminder off, as it always has on the Triggers screen.
    if ((await this.reminderDaysSetting()) <= 0) return;

    const from = startOfDay(today);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + LAWYER_WINDOW_DAYS);

    const rows = await this.prisma.transactions.findMany({
      // closing_date is already indexed; this reads the deals closing inside the window only.
      where: { deleted_at: null, closing_date: { gte: dbDay(from), lte: dbDay(to) } },
      select: {
        id: true, trade_no: true, property: true, agent: true, type: true, closing_date: true,
        buyer_lawyer_name: true, seller_lawyer_name: true,
        transaction_statuses: { select: { status: true } },
      },
    });

    for (const t of rows) {
      if (!t.closing_date) continue;
      // Only deals that carry both sides' details. A bare listing has no lawyers to chase.
      if (!tracksBothLawyers(t.type)) continue;
      // A deal that is finished, void or released is not waiting for anything.
      if (this.isSettled(t.transaction_statuses)) { result.skipped++; continue; }

      const missing = missingLawyerParties(t);
      const variant = lawyerVariant(missing);
      if (!variant) continue; // both present — the stop condition, checked before anything is sent

      const { due, daysRemaining } = lawyerReminderFor(today, calendarDay(t.closing_date));
      if (!due) continue;

      await this.deliver({
        txnId: t.id,
        kind: 'lawyer',
        variant,
        day: dbDay(startOfDay(today)),
        daysRemaining,
        agentName: t.agent,
        event: LAWYER_TEMPLATE[variant],
        vars: {
          deal_number: t.trade_no ?? String(t.id),
          property_address: t.property ?? '—',
          closing_date: toDateString(t.closing_date) ?? '',
          days_remaining: String(daysRemaining),
          closing_phrase: closingPhrase(daysRemaining),
          missing_details: variant === 'both' ? 'Buyer and Seller Lawyer Details' : variant === 'buyer' ? 'Buyer Lawyer Details' : 'Seller Lawyer Details',
          agent_name: t.agent ?? 'there',
        },
        summary: `${variant === 'both' ? 'Buyer & seller' : variant === 'buyer' ? 'Buyer' : 'Seller'} lawyer details needed — ${closingPhrase(daysRemaining)}`,
        result,
        onSent: () => { result.lawyerReminders++; },
      });
    }
  }

  // ---------------------------------------------------------------- retries

  /**
   * Send again what failed for a reason worth trying again.
   *
   * Only rows the mailer classified as transient carry a `next_retry_at`, so a rejected address or a
   * refused password is never asked twice — retrying a permanent rejection every hour is how a
   * sender gets blocklisted, and it would bury the real failures in the history.
   *
   * The message is REBUILT from the transaction rather than replayed from what was stored. Two days
   * on, "expires in 4 days" is wrong and the missing lawyer may already have been filled in; a queue
   * that replays yesterday's text would chase people for work they have done. If the reason to send
   * has gone away entirely the row is closed as Skipped, which is the honest record.
   */
  private async retryFailed(today: Date, result: SweepResult): Promise<void> {
    const due = await this.prisma.transaction_reminders.findMany({
      where: {
        delivery_method: 'email',
        delivery_status: 'Failed',
        next_retry_at: { not: null, lte: new Date() },
        attempts: { lt: MAX_DELIVERY_ATTEMPTS },
      },
      orderBy: { next_retry_at: 'asc' },
      take: MAX_RETRIES_PER_SWEEP,
      include: {
        transactions: {
          select: {
            id: true, trade_no: true, property: true, agent: true, type: true, deleted_at: true,
            closing_date: true, listing_expiry_date: true,
            buyer_lawyer_name: true, seller_lawyer_name: true,
            transaction_statuses: { select: { status: true } },
          },
        },
      },
    });

    for (const row of due) {
      const t = row.transactions;
      result.retried++;

      const rebuilt = t && !t.deleted_at ? this.rebuild(row.kind, t, today) : null;
      if (!rebuilt) {
        // The deal is gone, closed, or no longer missing anything: there is nothing left to send.
        await this.closeRetry(row.id, 'Skipped', 'No longer applicable — the reminder condition has cleared.');
        result.skipped++;
        continue;
      }

      const address = await this.addressFor(t!.agent);
      if (!address) {
        await this.closeRetry(row.id, 'Skipped', 'No email address on file for the assigned agent.');
        result.skipped++;
        continue;
      }

      const company = (await this.settings.current()).name;
      const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
      const link = base ? `${base}${areaPath('desk', `transactions/${t!.id}`)}` : '';

      try {
        await this.mailer.send(rebuilt.event, {
          ...rebuilt.vars,
          company_name: company,
          transaction_button: link
            ? `<p style="margin:18px 0"><a href="${link}" style="background:#1f3b73;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;display:inline-block">Open the transaction</a></p>`
            : '',
        }, redirectTo() ?? address);

        await this.prisma.transaction_reminders.update({
          where: { id: row.id },
          data: {
            delivery_status: 'Sent',
            recipient: address,
            subject: rebuilt.summary.slice(0, 255),
            detail: `Delivered on attempt ${row.attempts + 1}.`,
            attempts: row.attempts + 1,
            last_attempt_at: new Date(),
            next_retry_at: null,
          },
        });
        result.recovered++;
        await this.auditReminder(t!.id, row.kind, 'Reminder sent', rebuilt.summary, `Delivered on attempt ${row.attempts + 1} to ${address}.`);
      } catch (err) {
        await this.recordFailure(row.id, row.attempts + 1, err, t!.id, row.kind, rebuilt.summary);
        result.failed++;
      }
    }
  }

  /**
   * Today's version of a reminder that failed earlier, or null if there is no longer one to send.
   *
   * This is the same decision the nightly passes make, asked again now — which is what keeps a
   * retry truthful rather than a replay.
   */
  private rebuild(
    kind: string,
    t: {
      id: number; trade_no: string | null; property: string | null; agent: string | null; type: string | null;
      closing_date: Date | null; listing_expiry_date: Date | null;
      buyer_lawyer_name: string | null; seller_lawyer_name: string | null;
      transaction_statuses: { status: string }[];
    },
    today: Date,
  ): { event: string; vars: Record<string, string>; summary: string } | null {
    if (kind === 'listing_expiry') {
      if (!t.listing_expiry_date || !this.isActive(t.transaction_statuses)) return null;
      const { due, daysRemaining } = expiryReminderFor(today, calendarDay(t.listing_expiry_date));
      if (!due) return null;
      return {
        event: 'transaction.listing_expiry_reminder',
        vars: {
          deal_number: t.trade_no ?? String(t.id),
          property_address: t.property ?? '—',
          listing_type: t.type ?? '—',
          expiry_date: toDateString(t.listing_expiry_date) ?? '',
          days_remaining: String(daysRemaining),
          expiry_phrase: expiryPhrase(daysRemaining),
          agent_name: t.agent ?? 'there',
        },
        summary: `Listing ${expiryPhrase(daysRemaining)} — ${t.property ?? t.trade_no ?? ''}`.trim(),
      };
    }

    if (!t.closing_date || !tracksBothLawyers(t.type) || this.isSettled(t.transaction_statuses)) return null;
    const variant = lawyerVariant(missingLawyerParties(t));
    if (!variant) return null; // filled in since — nothing to chase
    const { daysRemaining } = lawyerReminderFor(today, calendarDay(t.closing_date));
    if (daysRemaining < 0) return null; // the closing has been and gone
    return {
      event: LAWYER_TEMPLATE[variant],
      vars: {
        deal_number: t.trade_no ?? String(t.id),
        property_address: t.property ?? '—',
        closing_date: toDateString(t.closing_date) ?? '',
        days_remaining: String(daysRemaining),
        closing_phrase: closingPhrase(daysRemaining),
        missing_details: variant === 'both' ? 'Buyer and Seller Lawyer Details' : variant === 'buyer' ? 'Buyer Lawyer Details' : 'Seller Lawyer Details',
        agent_name: t.agent ?? 'there',
      },
      summary: `${variant === 'both' ? 'Buyer & seller' : variant === 'buyer' ? 'Buyer' : 'Seller'} lawyer details needed — ${closingPhrase(daysRemaining)}`,
    };
  }

  /** Close a retry without sending — the condition it existed for has gone. */
  private async closeRetry(id: number, status: string, detail: string): Promise<void> {
    await this.prisma.transaction_reminders.update({
      where: { id },
      data: { delivery_status: status, detail, next_retry_at: null, last_attempt_at: new Date() },
    });
  }

  /**
   * Record a failed attempt, and schedule the next one if the reason is worth retrying.
   *
   * Backoff doubles — an hour, two, four — so a mail server that is down for the evening is asked
   * a handful of times rather than every hour all night. After the last attempt the row simply
   * stays Failed with the reason on it, which is what the history is for.
   */
  private async recordFailure(id: number, attempt: number, err: unknown, txnId: number, kind: string, summary: string): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    const retryable = isTransient(err) && attempt < MAX_DELIVERY_ATTEMPTS;
    const next = retryable ? new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]) : null;

    await this.prisma.transaction_reminders.update({
      where: { id },
      data: {
        delivery_status: 'Failed',
        detail: retryable ? `${reason} — attempt ${attempt}, trying again later.` : `${reason} — attempt ${attempt}, not retried.`,
        attempts: attempt,
        last_attempt_at: new Date(),
        next_retry_at: next,
      },
    });
    await this.auditReminder(txnId, kind, 'Reminder failed', summary, `Attempt ${attempt}: ${reason}${retryable ? ' (will retry)' : ''}`);
    this.log.error(`Reminder ${id} attempt ${attempt} failed: ${reason}${retryable ? ' — will retry' : ''}`);
  }

  // ---------------------------------------------------------------- delivery

  /**
   * Send one reminder, on both channels, exactly once.
   *
   * The in-app row is claimed FIRST and its unique index is what makes the whole thing idempotent:
   * if the insert fails, this occurrence has already been handled and nothing else happens. Only
   * then is the email attempted, so a mail server that is down cannot cause the same agent to be
   * chased again tomorrow for today's occurrence — the history keeps the failure instead.
   */
  private async deliver(job: {
    txnId: number;
    kind: 'listing_expiry' | 'lawyer';
    variant: string | null;
    day: Date;
    daysRemaining: number;
    agentName: string | null;
    event: string;
    vars: Record<string, string>;
    summary: string;
    result: SweepResult;
    onSent: () => void;
  }): Promise<void> {
    const claimed = await this.claim(job.txnId, job.kind, job.day, 'in-app', {
      variant: job.variant,
      daysRemaining: job.daysRemaining,
      recipient: job.agentName,
      status: 'Sent',
      subject: job.summary,
    });
    if (!claimed) return; // already handled today

    job.onSent();
    const company = (await this.settings.current()).name;
    const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    const link = base ? `${base}${areaPath('desk', `transactions/${job.txnId}`)}` : '';

    const address = await this.addressFor(job.agentName);
    if (!address) {
      await this.claim(job.txnId, job.kind, job.day, 'email', {
        variant: job.variant, daysRemaining: job.daysRemaining, recipient: job.agentName,
        status: 'Skipped', subject: job.summary, detail: 'No email address on file for the assigned agent.',
      });
      job.result.skipped++;
      await this.auditReminder(job.txnId, job.kind, 'Reminder skipped', job.summary, 'No email address on file for the assigned agent.');
      return;
    }

    try {
      await this.mailer.send(job.event, {
        ...job.vars,
        company_name: company,
        transaction_button: link
          ? `<p style="margin:18px 0"><a href="${link}" style="background:#1f3b73;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;display:inline-block">Open the transaction</a></p>`
          : '',
      }, redirectTo() ?? address);

      await this.claim(job.txnId, job.kind, job.day, 'email', {
        variant: job.variant, daysRemaining: job.daysRemaining, recipient: address,
        status: 'Sent', subject: job.summary,
      });
      await this.auditReminder(job.txnId, job.kind, 'Reminder sent', job.summary, `Emailed ${address}.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Claim the row first so the occurrence is still recorded, then let recordFailure decide
      // whether the reason is worth another attempt and when.
      await this.claim(job.txnId, job.kind, job.day, 'email', {
        variant: job.variant, daysRemaining: job.daysRemaining, recipient: address,
        status: 'Failed', subject: job.summary, detail: reason,
      });
      const row = await this.prisma.transaction_reminders.findFirst({
        where: { transaction_id: job.txnId, kind: job.kind, scheduled_for: job.day, delivery_method: 'email' },
        select: { id: true },
      });
      if (row) await this.recordFailure(row.id, 1, err, job.txnId, job.kind, job.summary);
      job.result.failed++;
    }
  }

  /**
   * Write the row that claims this occurrence, or report that somebody already has.
   *
   * `createMany({ skipDuplicates })` rather than a `create` in a try/catch, because the two are not
   * equivalent: it compiles to INSERT … ON CONFLICT DO NOTHING, which the database answers with a
   * count of zero. Letting the insert RAISE would abort the surrounding transaction in Postgres, so
   * a caller that wrapped the sweep — a test, or a future job that batches work — would have every
   * later statement fail with "current transaction is aborted" long after the swallowed error.
   *
   * "Already claimed" is a normal outcome for an idempotent job, so it is answered, not thrown.
   */
  private async claim(
    txnId: number,
    kind: string,
    day: Date,
    method: 'in-app' | 'email',
    info: { variant: string | null; daysRemaining: number; recipient: string | null; status: string; subject: string; detail?: string },
  ): Promise<boolean> {
    const written = await this.prisma.transaction_reminders.createMany({
      data: [{
        transaction_id: txnId,
        kind,
        variant: info.variant,
        scheduled_for: day,
        days_remaining: info.daysRemaining,
        recipient: info.recipient,
        delivery_method: method,
        delivery_status: info.status,
        detail: info.detail ?? null,
        subject: info.subject.slice(0, 255),
        created_at: new Date(),
      }],
      skipDuplicates: true,
    });
    return written.count > 0;
  }

  private async auditReminder(txnId: number, kind: string, action: string, subject: string, detail: string): Promise<void> {
    await this.audit.record(txnId, SYSTEM_ACTOR, {
      section: AUDIT_SECTION,
      field: kind === 'lawyer' ? 'Lawyer details reminder' : 'Listing expiry reminder',
      action,
      source: 'Scheduler',
      new: subject,
      details: detail,
    });
  }

  private async addressFor(agentName: string | null): Promise<string | null> {
    const name = (agentName ?? '').trim();
    if (!name) return null;
    // Through PersonResolver so two people sharing a name resolve the same way everywhere, and
    // deterministically: Active wins, ties break on the lowest id. This was a findFirst with no
    // orderBy, so the planner decided which colleague got the mail.
    const user = await this.people.resolve(null, name, { activeOnly: true });
    return (user?.email ?? '').trim() || null;
  }

  /** Active is the only status a listing is chased or expired in. */
  private isActive(statuses: { status: string }[]): boolean {
    return statuses.some((s) => s.status === 'Active');
  }

  /** A deal nobody is waiting on any more. */
  private isSettled(statuses: { status: string }[]): boolean {
    const done = ['Closed', 'Sold', 'Leased', 'Void', 'Terminated', 'Mutual Release', 'Expired', 'Cancelled', 'Archived', 'Completed', 'Suspended'];
    return statuses.some((s) => done.includes(s.status));
  }

  /** The Triggers screen's cadence field, still the on/off switch for lawyer reminders. */
  private async reminderDaysSetting(): Promise<number> {
    const s = await this.prisma.company_settings.findUnique({ where: { id: 1 }, select: { feature_flags: true } });
    try {
      const flags = JSON.parse(String(s?.feature_flags ?? '{}')) as Record<string, unknown>;
      const raw = Number(flags.lawyer_reminder_days);
      return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3;
    } catch {
      return 3;
    }
  }

  // ---------------------------------------------------------------- reading

  /** The agent's unseen reminders, for the notification bell. */
  async notifications(agentName: string | null): Promise<{ count: number; items: Record<string, unknown>[] }> {
    const name = (agentName ?? '').trim();
    if (!name) return { count: 0, items: [] };

    const rows = await this.prisma.transaction_reminders.findMany({
      where: { recipient: name, delivery_method: 'in-app', seen_at: null },
      orderBy: [{ scheduled_for: 'desc' }, { id: 'desc' }],
      take: 40,
      include: { transactions: { select: { id: true, trade_no: true, property: true, deleted_at: true } } },
    });

    const items = rows
      .filter((r) => r.transactions && !r.transactions.deleted_at)
      .map((r) => ({
        id: r.transactions.id,
        trade_no: r.transactions.trade_no,
        property: r.transactions.property,
        summary: r.subject ?? '',
        unread: true,
        at: toDateString(r.scheduled_for),
      }));
    return { count: items.length, items };
  }

  /** Opening the deal marks that day's reminder read, as the spec asks. */
  async markSeen(agentName: string | null, txnId: number): Promise<{ ok: boolean }> {
    const name = (agentName ?? '').trim();
    if (!name) return { ok: true };
    await this.prisma.transaction_reminders.updateMany({
      where: { transaction_id: txnId, recipient: name, delivery_method: 'in-app', seen_at: null },
      data: { seen_at: new Date() },
    });
    return { ok: true };
  }

  /** Reminder history for administrators, newest first. */
  async history(txnId: number | null, page = 1, perPage = 50): Promise<Record<string, unknown>> {
    const take = Math.min(Math.max(perPage, 1), 200);
    const where = txnId ? { transaction_id: txnId } : {};
    const [total, rows] = await Promise.all([
      this.prisma.transaction_reminders.count({ where }),
      this.prisma.transaction_reminders.findMany({
        where,
        orderBy: [{ scheduled_for: 'desc' }, { id: 'desc' }],
        skip: (Math.max(page, 1) - 1) * take,
        take,
        include: { transactions: { select: { id: true, trade_no: true, property: true } } },
      }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        transaction_id: r.transaction_id,
        trade_no: r.transactions?.trade_no ?? null,
        property: r.transactions?.property ?? null,
        kind: r.kind,
        variant: r.variant,
        scheduled_for: toDateString(r.scheduled_for),
        days_remaining: r.days_remaining,
        recipient: r.recipient,
        delivery_method: r.delivery_method,
        delivery_status: r.delivery_status,
        detail: r.detail,
        subject: r.subject,
        seen_at: r.seen_at ? r.seen_at.toISOString() : null,
      })),
      meta: { total, page: Math.max(page, 1), per_page: take, last_page: Math.max(1, Math.ceil(total / take)) },
    };
  }

  /**
   * A date moved, so anything already scheduled against the old one is no longer meaningful.
   *
   * Only FUTURE occurrences are affected, and there is nothing to delete — the schedule is derived
   * from the date every night rather than written ahead, so moving the date recalculates it by
   * construction. What this does is record that it happened, so the trail explains why the cadence
   * changed, and clear today's claim so a new date can be chased today rather than tomorrow.
   */
  async dateChanged(txnId: number, field: 'closing_date' | 'listing_expiry_date', from: Date | null, to: Date | null): Promise<void> {
    const kind = field === 'closing_date' ? 'lawyer' : 'listing_expiry';
    await this.prisma.transaction_reminders.deleteMany({
      where: { transaction_id: txnId, kind, scheduled_for: { gte: dbDay(startOfDay(new Date())) } },
    });
    await this.audit.record(txnId, SYSTEM_ACTOR, {
      section: AUDIT_SECTION,
      field: field === 'closing_date' ? 'Closing date' : 'Listing expiry date',
      action: 'Reminder schedule recalculated',
      source: 'Scheduler',
      old: from ? toDateString(from) : '',
      new: to ? toDateString(to) : '',
      details: to
        ? `Reminders now follow ${toDateString(to)}${to ? ` (${daysBetween(new Date(), to)} days away)` : ''}.`
        : 'The date was cleared, so no further reminders are scheduled.',
    });
  }
}
