import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJsonObject } from '../common/serialize';
import { TransactionLawyerReminderService } from './transaction-lawyer-reminder.service';
import { tracksBothLawyers } from './lawyer-details';

const DEFAULT_INTERVAL_DAYS = 3;

/**
 * Recurring lawyer-detail reminders. Every hour it re-checks every Buying/Lease deal that still has
 * a lawyer detail missing and re-emails the agent(s) once the configured number of days has passed
 * since the last reminder — so a nudge repeats every N days until the details are entered.
 *
 * The cadence is `company_settings.feature_flags.lawyer_reminder_days` (admin-editable). Set it to 0
 * to switch the recurring reminder off (the one-off on-save nudge still fires). In-process timer,
 * mirroring the IMAP poller; disable on all but one instance with LAWYER_REMINDER_DISABLED=1.
 */
@Injectable()
export class LawyerReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LawyerReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: TransactionLawyerReminderService,
  ) {}

  onModuleInit(): void {
    /*
     * Superseded by ReminderSchedulerService, which chases lawyer details on the phase schedule the
     * brokerage asked for: weekly from 30 days out, twice a week from 15, three times a week from 7.
     * Running both would chase the same agent twice on the same day through two different cadences.
     *
     * The class is kept, not deleted: `sweep()` is still the recurring pass and is still correct, so
     * it remains callable by hand or by a test. What has gone is the timer that ran it.
     */
    this.log.log('Recurring lawyer-detail reminders now run in the reminder sweep; this scheduler is idle.');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** How many days between recurring reminders (0 = recurring reminders off). */
  private async intervalDays(): Promise<number> {
    const s = await this.prisma.company_settings.findUnique({ where: { id: 1 }, select: { feature_flags: true } });
    const flags = parseJsonObject(s?.feature_flags ?? null);
    const raw = Number(flags.lawyer_reminder_days);
    if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_DAYS;
    return Math.max(0, Math.floor(raw));
  }

  /** One pass: re-evaluate every deal that still has a lawyer detail outstanding. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const days = await this.intervalDays();
      if (days <= 0) return; // recurring reminders disabled

      // Narrow to deals with at least one lawyer field blank — the only candidates for a reminder.
      const candidates = await this.prisma.transactions.findMany({
        where: {
          deleted_at: null,
          OR: [
            { buyer_lawyer_name: null }, { buyer_lawyer_name: '' },
            { seller_lawyer_name: null }, { seller_lawyer_name: '' },
          ],
        },
        select: { id: true, type: true },
      });

      let checked = 0;
      for (const c of candidates) {
        if (!tracksBothLawyers(c.type)) continue; // Buying/Lease only
        checked++;
        try { await this.reminders.evaluate(c.id, days); }
        catch (e) { this.log.warn(`Lawyer reminder sweep failed for transaction #${c.id}: ${(e as Error).message}`); }
      }
      if (checked > 0) this.log.log(`Lawyer-reminder sweep evaluated ${checked} deal(s) (every ${days} day(s)).`);
    } catch (e) {
      this.log.warn(`Lawyer-reminder sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
