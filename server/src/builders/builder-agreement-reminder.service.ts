import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { superAdminRoles } from '../core/authz';
import { allowedMarkets } from '../common/market';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { registerWorker, trackedTick } from '../observability/worker-health';
import {
  SEND_HOUR, WINDOW_DAYS, daysUntil, expiryReminderDue, expiryState, localDay, REMINDER_FOOTNOTE, type ExpiryReminderState,
} from '../common/expiry-reminder';

/**
 * BUILDER AGREEMENT EXPIRY REMINDERS (India builder database, stage 3, 17 Oct 2026).
 *
 * Sai first asked for "from last 15 days, a mail every 2 days" (17 Oct). On 19 Oct he moved them to
 * the company-document rules (common/expiry-reminder.ts): from 15 days before every 2 days, always the
 * day before and the day itself, after the expiry every 2 days until renewed - a new expiry date
 * (BuildersService.update clears the reminder dates) or a new agreement file uploaded after the first
 * reminder - at 9:00 India time, counted by India's date.
 *
 * The same rule chases a project's RERA registration (stage 3b): its valid-until date; a new RERA
 * certificate file uploaded after the first reminder counts as the renewal.
 *
 * One email per agreement or RERA, to every active Super Admin who works in India. Checked every 15
 * minutes; nothing goes out before 9:00 India time. Runs only where schedulers run (RUN_SCHEDULERS).
 */
const TICK_MS = 15 * 60 * 1000;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

@Injectable()
export class BuilderAgreementReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BuilderAgreementReminderService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  onModuleInit(): void {
    if (!schedulersEnabled()) {
      this.log.log(`Builder agreement reminders not scheduled (${schedulerSkipReason()}).`);
      return;
    }
    registerWorker('builder-agreement-reminders', TICK_MS);
    this.timer = setInterval(trackedTick('builder-agreement-reminders', () => this.run()), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    setTimeout(() => void this.run(), 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Is a reminder due on this India date? Pure, so it can be tested on any day. */
  static due(a: ExpiryReminderState, today: Date): boolean {
    return expiryReminderDue(a, today, 'IN');
  }

  async run(now: Date = new Date()): Promise<{ sent: number; checked: number }> {
    if (this.running) return { sent: 0, checked: 0 };
    this.running = true;
    try {
      const { day: today, hour } = localDay(now, 'IN');
      if (hour < SEND_HOUR) return { sent: 0, checked: 0 };
      const horizon = new Date(today.getTime() + WINDOW_DAYS * 86_400_000);
      const candidates = await this.prisma.builder_agreements.findMany({
        where: { expiry_date: { not: null, lte: horizon }, builder: { deleted_at: null, market: 'IN' } },
        include: { builder: { select: { id: true, name: true } } },
      });
      const due = candidates.filter((a) => BuilderAgreementReminderService.due({ ...a, latest_file_at: a.file_uploaded_at }, today));
      const reraCandidates = await this.prisma.builder_projects.findMany({
        where: { rera_valid_until: { not: null, lte: horizon }, deleted_at: null, market: 'IN', builder: { deleted_at: null } },
        select: {
          id: true, name: true, rera_number: true, rera_valid_until: true, rera_last_reminder_at: true, rera_reminder_started_at: true,
          builder: { select: { name: true } },
          files: { where: { kind: 'rera_certificate', deleted_at: null }, orderBy: { uploaded_at: 'desc' }, take: 1, select: { uploaded_at: true } },
        },
      });
      const reraDue = reraCandidates.filter((p) => BuilderAgreementReminderService.due({
        expiry_date: p.rera_valid_until, last_reminder_at: p.rera_last_reminder_at, reminder_started_at: p.rera_reminder_started_at,
        latest_file_at: p.files[0]?.uploaded_at ?? null,
      }, today));
      if (!due.length && !reraDue.length) return { sent: 0, checked: candidates.length + reraCandidates.length };
      const admins = await this.prisma.users.findMany({
        // Every account has a status (default Active); Inactive accounts get nothing.
        where: { role: { in: superAdminRoles() }, status: { not: 'Inactive' }, email: { not: '' } },
        select: { email: true, markets: true },
      });
      // Builders are India's: only the Super Admins who work in India.
      const to = [...new Set(admins.filter((u) => allowedMarkets(u.markets).includes('IN')).map((u) => (u.email ?? '').trim()).filter(Boolean))];
      let sent = 0;
      for (const a of due) {
        const left = daysUntil(a.expiry_date, today) as number;
        const when = a.expiry_date!.toISOString().slice(0, 10);
        const state = expiryState(left);
        const subject = `Builder agreement ${state} - ${a.builder.name}`;
        const html = `<p>The agreement with <strong>${esc(a.builder.name)}</strong> ${left < 0 ? 'expired' : 'expires'} on <strong>${when}</strong>`
          + ` (${esc(state.toLowerCase())}).</p>`
          + '<p>Please renew it, then upload the new agreement or update its expiry date in the Builders screen (India).</p>'
          + `<p style="color:#6b7280;font-size:12px">${REMINDER_FOOTNOTE}</p>`;
        let ok = 0;
        for (const addr of to) {
          try { await this.mailer.sendDirect(addr, subject, html); ok += 1; } catch (err) {
            this.log.warn(`Builder agreement reminder to ${addr} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (ok > 0) {
          await this.prisma.builder_agreements.update({
            where: { id: a.id },
            data: { last_reminder_at: now, ...(a.reminder_started_at ? {} : { reminder_started_at: now }) },
          });
          sent += 1;
        }
      }
      for (const p of reraDue) {
        const left = daysUntil(p.rera_valid_until, today) as number;
        const when = p.rera_valid_until!.toISOString().slice(0, 10);
        const state = expiryState(left);
        const subject = `RERA registration ${state} - ${p.name}`;
        const html = `<p>The RERA registration${p.rera_number ? ` <strong>${esc(p.rera_number)}</strong>` : ''} of the project`
          + ` <strong>${esc(p.name)}</strong> (${esc(p.builder.name)}) ${left < 0 ? 'was' : 'is'} valid until <strong>${when}</strong>`
          + ` (${esc(state.toLowerCase())}).</p>`
          + '<p>Please get the renewed certificate, then upload it or update the project in the Builders screen (India).</p>'
          + `<p style="color:#6b7280;font-size:12px">${REMINDER_FOOTNOTE}</p>`;
        let ok = 0;
        for (const addr of to) {
          try { await this.mailer.sendDirect(addr, subject, html); ok += 1; } catch (err) {
            this.log.warn(`RERA reminder to ${addr} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (ok > 0) {
          await this.prisma.builder_projects.update({
            where: { id: p.id },
            data: { rera_last_reminder_at: now, ...(p.rera_reminder_started_at ? {} : { rera_reminder_started_at: now }) },
          });
          sent += 1;
        }
      }
      return { sent, checked: candidates.length + reraCandidates.length };
    } catch (err) {
      this.log.error(`Builder agreement reminders failed: ${err instanceof Error ? err.message : String(err)}`);
      return { sent: 0, checked: 0 };
    } finally {
      this.running = false;
    }
  }
}
