import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { superAdminRoles } from '../core/authz';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { registerWorker, trackedTick } from '../observability/worker-health';
import { BuildersService } from './builders.service';

/**
 * BUILDER AGREEMENT EXPIRY REMINDERS (India builder database, stage 3, 17 Oct 2026).
 *
 * Sai: "from last 15 days, a mail every 2 days", to the Super Admins (new roles will join later).
 * So an agreement whose expiry is 15 days away or closer - up to and including the expiry day - is
 * reminded about, and then again no sooner than two days later, until it expires or its expiry date
 * is moved (moving the date starts the reminders afresh; see BuildersService.update).
 *
 * The same rule chases a project's RERA registration (stage 3b, Sai: "ok" to a reminder like the
 * agreement's) - its valid-until date, from 15 days before, every 2 days.
 *
 * One email per agreement or RERA, to every active Super Admin with an email address. Checked every six hours,
 * so a restart or a quiet morning never loses a day. Runs only where schedulers run (RUN_SCHEDULERS).
 */
const WINDOW_DAYS = 15;
const EVERY_DAYS = 2;
const TICK_MS = 6 * 60 * 60 * 1000;

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

  /** Which agreements are due a reminder today. Exported logic, so it can be tested on any day. */
  static due(a: { expiry_date: Date | null; last_reminder_at: Date | null }, today: Date): boolean {
    const left = BuildersService.daysLeft(a.expiry_date, today);
    if (left === null || left < 0 || left > WINDOW_DAYS) return false;
    if (!a.last_reminder_at) return true;
    const last = Date.UTC(a.last_reminder_at.getUTCFullYear(), a.last_reminder_at.getUTCMonth(), a.last_reminder_at.getUTCDate());
    const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return (now - last) / 86_400_000 >= EVERY_DAYS;
  }

  async run(today: Date = new Date()): Promise<{ sent: number; checked: number }> {
    if (this.running) return { sent: 0, checked: 0 };
    this.running = true;
    try {
      const horizon = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + WINDOW_DAYS));
      const candidates = await this.prisma.builder_agreements.findMany({
        where: { expiry_date: { not: null, lte: horizon }, builder: { deleted_at: null, market: 'IN' } },
        include: { builder: { select: { id: true, name: true } } },
      });
      const due = candidates.filter((a) => BuilderAgreementReminderService.due(a, today));
      const reraCandidates = await this.prisma.builder_projects.findMany({
        where: { rera_valid_until: { not: null, lte: horizon }, deleted_at: null, market: 'IN', builder: { deleted_at: null } },
        select: { id: true, name: true, rera_number: true, rera_valid_until: true, rera_last_reminder_at: true, builder: { select: { name: true } } },
      });
      const reraDue = reraCandidates.filter((p) => BuilderAgreementReminderService.due({ expiry_date: p.rera_valid_until, last_reminder_at: p.rera_last_reminder_at }, today));
      if (!due.length && !reraDue.length) return { sent: 0, checked: candidates.length + reraCandidates.length };
      const admins = await this.prisma.users.findMany({
        // Every account has a status (default Active); Inactive accounts get nothing.
        where: { role: { in: superAdminRoles() }, status: { not: 'Inactive' }, email: { not: '' } },
        select: { email: true },
      });
      const to = [...new Set(admins.map((u) => (u.email ?? '').trim()).filter(Boolean))];
      let sent = 0;
      for (const a of due) {
        const left = BuildersService.daysLeft(a.expiry_date, today) as number;
        const when = a.expiry_date!.toISOString().slice(0, 10);
        const subject = left === 0
          ? `Builder agreement expires TODAY - ${a.builder.name}`
          : `Builder agreement expires in ${left} day${left === 1 ? '' : 's'} - ${a.builder.name}`;
        const html = `<p>The agreement with <strong>${esc(a.builder.name)}</strong> expires on <strong>${when}</strong>`
          + ` (${left === 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} from now`}).</p>`
          + `<p>Please renew it, or update its expiry date in the Builders screen (India) once renewed.</p>`
          + `<p style="color:#6b7280;font-size:12px">This reminder repeats every ${EVERY_DAYS} days from ${WINDOW_DAYS} days before expiry.</p>`;
        let ok = 0;
        for (const addr of to) {
          try { await this.mailer.sendDirect(addr, subject, html); ok += 1; } catch (err) {
            this.log.warn(`Builder agreement reminder to ${addr} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (ok > 0) {
          await this.prisma.builder_agreements.update({ where: { id: a.id }, data: { last_reminder_at: new Date() } });
          sent += 1;
        }
      }
      for (const p of reraDue) {
        const left = BuildersService.daysLeft(p.rera_valid_until, today) as number;
        const when = p.rera_valid_until!.toISOString().slice(0, 10);
        const subject = left === 0
          ? `RERA registration expires TODAY - ${p.name}`
          : `RERA registration expires in ${left} day${left === 1 ? '' : 's'} - ${p.name}`;
        const html = `<p>The RERA registration${p.rera_number ? ` <strong>${esc(p.rera_number)}</strong>` : ''} of the project`
          + ` <strong>${esc(p.name)}</strong> (${esc(p.builder.name)}) is valid until <strong>${when}</strong>`
          + ` (${left === 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} from now`}).</p>`
          + `<p>Please get the renewed certificate and update the project in the Builders screen (India).</p>`
          + `<p style="color:#6b7280;font-size:12px">This reminder repeats every ${EVERY_DAYS} days from ${WINDOW_DAYS} days before expiry.</p>`;
        let ok = 0;
        for (const addr of to) {
          try { await this.mailer.sendDirect(addr, subject, html); ok += 1; } catch (err) {
            this.log.warn(`RERA reminder to ${addr} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (ok > 0) {
          await this.prisma.builder_projects.update({ where: { id: p.id }, data: { rera_last_reminder_at: new Date() } });
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
