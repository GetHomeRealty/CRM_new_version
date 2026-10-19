import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { superAdminRoles } from '../core/authz';
import { allowedMarkets, type Market } from '../common/market';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { registerWorker, trackedTick } from '../observability/worker-health';
import { CompanyDocumentsService } from './company-documents.service';
import { SEND_HOUR, WINDOW_DAYS, expiryReminderDue, expiryState, localDay, REMINDER_FOOTNOTE, type ExpiryReminderState } from '../common/expiry-reminder';

/**
 * COMPANY DOCUMENT EXPIRY REMINDERS (19 Oct 2026). Sai's rules:
 *   - from 15 days before the expiry date, an email every 2 days;
 *   - always on the day before, and always on the expiry day itself;
 *   - after the expiry, if it was not renewed, still every 2 days - for as long as it stays so;
 *   - it stops when a new expiry date is entered or a new file is uploaded (a file uploaded after
 *     this expiry's first reminder counts as the renewal);
 *   - to the Super Admins who work in that country, at 9:00 in the morning of that country's own time
 *     (Toronto for Canada, India time for India), the days counted by that country's own date.
 * The rules themselves live in common/expiry-reminder.ts, shared with the builder and RERA reminders.
 */
const TICK_MS = 15 * 60 * 1000;
export { localDay } from '../common/expiry-reminder';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

@Injectable()
export class CompanyDocumentReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CompanyDocumentReminderService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  onModuleInit(): void {
    if (!schedulersEnabled()) {
      this.log.log(`Company document reminders not scheduled (${schedulerSkipReason()}).`);
      return;
    }
    registerWorker('company-document-reminders', TICK_MS);
    this.timer = setInterval(trackedTick('company-document-reminders', () => this.run()), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    setTimeout(() => void this.run(), 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Is a reminder due on this country-date? Pure, so it can be tested on any day. */
  static due(d: ExpiryReminderState, today: Date, market: Market): boolean {
    return expiryReminderDue(d, today, market);
  }

  async run(now: Date = new Date()): Promise<{ sent: number; checked: number }> {
    if (this.running) return { sent: 0, checked: 0 };
    this.running = true;
    let sent = 0;
    let checked = 0;
    try {
      for (const market of ['CA', 'IN'] as Market[]) {
        const { day, hour } = localDay(now, market);
        if (hour < SEND_HOUR) continue;
        const horizon = new Date(day.getTime() + WINDOW_DAYS * 86_400_000);
        const docs = await this.prisma.company_documents.findMany({
          where: { market, deleted_at: null, expiry_date: { not: null, lte: horizon } },
          include: { files: { where: { deleted_at: null }, orderBy: { uploaded_at: 'desc' }, take: 1, select: { uploaded_at: true } } },
        });
        checked += docs.length;
        const due = docs.filter((d) => CompanyDocumentReminderService.due({ ...d, latest_file_at: d.files[0]?.uploaded_at ?? null }, day, market));
        if (!due.length) continue;
        const admins = await this.prisma.users.findMany({
          where: { role: { in: superAdminRoles() }, status: { not: 'Inactive' }, email: { not: '' } },
          select: { email: true, markets: true },
        });
        // Only the Super Admins who work in this country.
        const to = [...new Set(admins.filter((u) => allowedMarkets(u.markets).includes(market)).map((u) => (u.email ?? '').trim()).filter(Boolean))];
        const country = market === 'IN' ? 'India' : 'Canada';
        for (const d of due) {
          const left = CompanyDocumentsService.daysLeft(d.expiry_date, day) as number;
          const when = d.expiry_date!.toISOString().slice(0, 10);
          const state = expiryState(left);
          const subject = `Company document ${state} - ${d.title} (${country})`;
          const html = `<p><strong>${esc(d.title)}</strong>${d.number ? ` (no. ${esc(d.number)})` : ''} of the ${country} company`
            + ` ${left < 0 ? 'expired' : 'expires'} on <strong>${when}</strong> - ${esc(state.toLowerCase())}.</p>`
            + `<p>Please renew it, then upload the new file or enter the new expiry date in Settings &rarr; Company Documents (${country}).</p>`
            + `<p style="color:#6b7280;font-size:12px">${REMINDER_FOOTNOTE}</p>`;
          let ok = 0;
          for (const addr of to) {
            try { await this.mailer.sendDirect(addr, subject, html); ok += 1; } catch (err) {
              this.log.warn(`Company document reminder to ${addr} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (ok > 0) {
            const at = now;
            await this.prisma.company_documents.update({
              where: { id: d.id },
              data: { last_reminder_at: at, ...(d.reminder_started_at ? {} : { reminder_started_at: at }) },
            });
            sent += 1;
          }
        }
      }
      return { sent, checked };
    } catch (err) {
      this.log.error(`Company document reminders failed: ${err instanceof Error ? err.message : String(err)}`);
      return { sent, checked };
    } finally {
      this.running = false;
    }
  }
}
