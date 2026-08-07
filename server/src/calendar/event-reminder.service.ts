import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService, isTransient } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { EVENT_TYPE_LABELS } from './calendar.constants';
import { WebPushService } from './web-push.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';

/**
 * Appointment reminders — the thing the "Remind me" checkbox promised and never did.
 *
 * The box wrote `enable_reminder` and the API handed it back, but nothing on the server read it:
 * across the whole database not one event had ever had `reminder_sent` set. An agent could tick it
 * for a 9am viewing, trust it, and hear nothing. This is the missing half.
 *
 * WHAT MAKES IT SAFE TO RUN TWICE. Each reminder is a row in `calendar_event_reminders` keyed
 * uniquely on (event, lead time). The insert IS the lock: a second sweep in the same window, a
 * retry after a crash, or two app instances racing all reach the same place, because the second
 * insert conflicts and nothing is sent. `calendar_events.reminder_sent` could not do this — one
 * boolean cannot say which of two lead times it referred to, so a day-before and an hour-before
 * notice would overwrite each other on it.
 *
 * WHAT IT REFUSES TO SEND. A cancelled appointment, a deleted one, one whose owner has no email,
 * and anything already in the past. Each of those is recorded as Skipped with the reason rather
 * than silently passed over, so "why did I not get a reminder" has an answer in the data.
 */

/**
 * How far ahead each reminder goes out.
 *
 * A day before, so the evening is planned, and an hour before, so it is not forgotten between
 * appointments. Both are sent for the same event; they are separate rows and cannot collide.
 */
export const REMINDER_LEAD_MINUTES = [24 * 60, 60] as const;

/** Matches the transaction sweep: four attempts over about seven hours, doubling each time. */
const MAX_DELIVERY_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60 * 60 * 1000, 2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000];
const MAX_PER_SWEEP = 200;

const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};

export interface EventSweepResult {
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  /** Browsers a push reached. Counted separately: email is the record, push is the extra. */
  pushed: number;
}

@Injectable()
export class EventReminderService {
  private readonly log = new Logger(EventReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly push: WebPushService,
    /*
     * Optional so every existing construction of this service — including four spec files — keeps
     * working untouched. In the running application it is always injected; where it is absent the
     * in-app notification is simply not written, exactly as the push guard below behaves.
     */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  /**
   * One pass. `now` is injectable so a test can place itself relative to an appointment rather
   * than having to create one at a real wall-clock offset.
   */
  async sweep(now: Date = new Date()): Promise<EventSweepResult> {
    const result: EventSweepResult = { sent: 0, skipped: 0, failed: 0, retried: 0, pushed: 0 };

    // Longest lead first, so the bands below read in the order they fire.
    const leads = [...REMINDER_LEAD_MINUTES].sort((a, b) => b - a);

    for (let i = 0; i < leads.length; i += 1) {
      const lead = leads[i];
      // Each lead time owns a BAND, not everything up to its horizon.
      //
      // "Anything starting within 24 hours" would mean an appointment booked for 45 minutes' time
      // received the day-before notice and the hour-before notice at once, and the day-before one
      // would say "tomorrow" about something happening this afternoon. So the lower edge of each
      // band is the next shorter lead time, and the shortest band runs down to now.
      //
      // The band is a range rather than a moment on purpose: a tick that is late, or a server that
      // was restarted, still finds the appointment on the next pass instead of stepping over it.
      const floor = i + 1 < leads.length ? leads[i + 1] : 0;
      const horizon = new Date(now.getTime() + lead * 60 * 1000);
      const earliest = new Date(now.getTime() + floor * 60 * 1000);
      const due = await this.dueEvents(earliest, horizon, now, lead);

      for (const ev of due) {
        // The insert is the lock. `createMany` with skipDuplicates issues ON CONFLICT DO NOTHING,
        // which — unlike catching a unique violation — does not abort the surrounding transaction.
        const claimed = await this.prisma.calendar_event_reminders.createMany({
          data: [{
            calendar_event_id: ev.id, lead_minutes: lead, delivery_status: 'Pending',
            company_id: ev.company_id, created_at: new Date(), updated_at: new Date(),
          }],
          skipDuplicates: true,
        });
        if (claimed.count === 0) continue;   // another pass already owns this one

        const row = await this.prisma.calendar_event_reminders.findFirst({
          where: { calendar_event_id: ev.id, lead_minutes: lead },
        });
        if (!row) continue;
        await this.deliver(row.id, ev, lead, result, now);
      }
    }

    await this.retryFailed(now, result);
    if (result.sent || result.failed || result.retried || result.pushed) {
      this.log.log(`Appointment reminders: ${result.sent} sent, ${result.pushed} pushed, ${result.skipped} skipped, ${result.failed} failed, ${result.retried} retried.`);
    }
    return result;
  }

  /**
   * Appointments starting inside one lead time's band, whose owner asked to be reminded.
   *
   * `earliest` is the band's lower edge and `horizon` its upper; `now` is passed separately because
   * an appointment that has already begun is never due, whatever band it falls in.
   */
  private async dueEvents(earliest: Date, horizon: Date, now: Date, lead: number) {
    // `date` is a calendar day and `time` is a separate HH:MM string, so the day range is narrowed
    // in SQL and the exact start time is compared in JS — a two-day span at most.
    const from = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate()));
    const to = new Date(Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth(), horizon.getUTCDate()));

    const rows = await this.prisma.calendar_events.findMany({
      where: {
        deleted_at: null,
        enable_reminder: true,
        status: { notIn: ['cancelled', 'completed'] },
        date: { gte: from, lte: to },
        /*
         * ALREADY-REMINDED EVENTS ARE EXCLUDED, and this line is the fix rather than the cap.
         *
         * `MAX_PER_SWEEP` bounds the read, which is right. What was wrong is that the bound was
         * applied to a set that INCLUDED every event already reminded for this lead time: the query
         * had no relation to `calendar_event_reminders`, so an appointment handled two days ago was
         * still returned, still ordered ahead of newer ones by `date asc`, and still consumed one of
         * the two hundred slots. The claim below then skipped it as already owned.
         *
         * The consequence was silent starvation. Once two hundred already-processed events sat in
         * the window, event two hundred and one was never reached — not this sweep, not the next
         * one, because the ordering is deterministic and the set does not change. At 500 agents a
         * two-day band holds far more than two hundred appointments, so most reminders would simply
         * never be sent, with nothing reporting it.
         *
         * Excluding them makes the cap what it was always meant to be: a limit on how much NEW work
         * one pass takes on, not a window that fills up with old work and stops.
         */
        reminders: { none: { lead_minutes: lead } },
      },
      include: {
        transactions: { select: { trade_no: true, property: true } },
      },
      take: MAX_PER_SWEEP,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    });

    /*
     * Say so when the cap bites. Reaching it is legitimate — the next sweep picks up where this one
     * stopped, because what this one handles leaves the set — but a backlog that never clears is
     * worth seeing rather than inferring from missing reminders.
     */
    if (rows.length === MAX_PER_SWEEP) {
      this.log.warn(
        `Appointment reminders: hit the ${MAX_PER_SWEEP}-event cap for the ${lead}-minute lead time. `
        + 'The remainder is picked up next sweep; if this repeats, the sweep is not keeping up.',
      );
    }

    return rows.filter((r) => {
      const startsAt = this.startOf(r.date, r.time);
      // Strictly after the band's lower edge, so an appointment cannot satisfy two bands at once.
      return startsAt > now && startsAt > earliest && startsAt <= horizon;
    });
  }

  /** Send one reminder and record what happened. */
  private async deliver(reminderId: number, ev: EventRow, lead: number, result: EventSweepResult, now: Date): Promise<void> {
    const owner = ev.user_id ? await this.prisma.users.findUnique({ where: { id: ev.user_id }, select: { name: true, email: true } }) : null;
    const to = redirectTo() ?? owner?.email ?? null;

    if (!to) {
      await this.finish(reminderId, 'Skipped', `No email on file for the calendar's owner — nothing sent.`, null);
      result.skipped += 1;
      return;
    }

    const company = await this.settings.current().catch(() => null);
    const vars = this.variables(ev, lead, owner?.name ?? 'there', (company as { name?: string } | null)?.name ?? 'Get Home Realty');

    try {
      await this.mailer.send('calendar.event_reminder', vars, to);
      await this.finish(reminderId, 'Sent', `Reminder sent ${this.phrase(lead)} before the appointment.`, to);
      result.sent += 1;
    } catch (ex) {
      await this.recordFailure(reminderId, ex, result, now);
    }

    // Sent AFTER the email and outside its try, deliberately in both respects. A push that fails
    // must not mark the reminder failed — the email is the record and it has already gone — and a
    // push that succeeds must not make a failed email look delivered. `sendToUser` never throws.
    // `this.push` is always injected in the running app; the guard is here because everything after
    // this point runs AFTER the email has gone out, and nothing in it may throw.
    if (ev.user_id && this.push) {
      const where = ev.location ? ` — ${ev.location}` : '';
      const pushed = await this.push.sendToUser(ev.user_id, {
        title: `${this.phrase(lead)}: ${ev.title}`,
        body: `${ev.date.toISOString().slice(0, 10)} at ${ev.time}${ev.end_time ? `–${ev.end_time}` : ''}${where}`,
        // One tag per appointment, so the hour-before notice replaces the day-before one on the
        // lock screen instead of stacking two reminders for the same viewing.
        tag: `event-${ev.id}`,
        url: '/crm/calendar',
        // Muting "Calendar reminders" in Settings suppresses the push and nothing else — the
        // email above has already gone, and it is the record. Somebody who does not want their
        // phone buzzing at 7am still gets told about the appointment.
      }, ev.domain, 'calendar_reminders');
      if (pushed.sent > 0) {
        result.pushed += pushed.sent;
        await this.prisma.calendar_event_reminders.update({
          where: { id: reminderId },
          data: { pushed_at: new Date(), push_count: pushed.sent },
        }).catch(() => {});
      }
    }

    /*
     * The IN-APP copy, so the appointment also appears in the Notification Centre rather than only
     * in a mailbox and on a lock screen. Same placement and same reasoning as the push above: after
     * the email, outside its try, and unable to fail the reminder.
     *
     * Only the in-app channel is asked for here. Email and push have already been sent by the two
     * blocks above, with their own delivery records and retry handling, and routing them through the
     * dispatcher as well would send each twice.
     *
     * `dedupeKey` is the reminder row's own id, so a retried sweep cannot leave two copies of one
     * appointment in somebody's list.
     */
    if (ev.user_id && this.dispatcher) {
      const where2 = ev.location ? ` — ${ev.location}` : '';
      await this.dispatcher.dispatch({
        category: 'calendar_reminders',
        userId: ev.user_id,
        title: `${this.phrase(lead)}: ${ev.title}`,
        body: `${ev.date.toISOString().slice(0, 10)} at ${ev.time}${ev.end_time ? `–${ev.end_time}` : ''}${where2}`,
        link: '/crm/calendar',
        dedupeKey: `calendar-reminder-${reminderId}`,
        channels: ['in_app'],
      }).catch(() => {
        // Never allowed to affect the reminder: the email is the record and has already gone.
      });
    }
  }

  /** A failure that may pass gets another go; one that will not is left alone and visible. */
  private async recordFailure(reminderId: number, ex: unknown, result: EventSweepResult, now: Date): Promise<void> {
    const row = await this.prisma.calendar_event_reminders.findUnique({ where: { id: reminderId } });
    const attempts = (row?.attempts ?? 0) + 1;
    const message = (ex as Error)?.message ?? 'Unknown error';

    // A rejected address asked again every hour is how a sender gets blocklisted, and it buries the
    // real failures. Only transient problems come back.
    const worthRetrying = isTransient(ex) && attempts < MAX_DELIVERY_ATTEMPTS;
    const nextRetryAt = worthRetrying ? new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]) : null;

    await this.prisma.calendar_event_reminders.update({
      where: { id: reminderId },
      data: {
        delivery_status: 'Failed', attempts, next_retry_at: nextRetryAt, updated_at: new Date(),
        detail: worthRetrying ? `${message} — trying again later (attempt ${attempts}).` : `${message} — not retried.`,
      },
    });
    result.failed += 1;
  }

  /** Bring back the reminders whose retry has come due. */
  private async retryFailed(now: Date, result: EventSweepResult): Promise<void> {
    const due = await this.prisma.calendar_event_reminders.findMany({
      where: { delivery_status: 'Failed', next_retry_at: { not: null, lte: now } },
      take: MAX_PER_SWEEP,
    });

    for (const row of due) {
      const ev = await this.prisma.calendar_events.findFirst({
        where: { id: row.calendar_event_id },
        include: { transactions: { select: { trade_no: true, property: true } } },
      });

      // The reason may have gone away while the retry waited: the appointment was cancelled, moved
      // into the past, deleted, or the reminder was switched off. Chasing it then is worse than
      // dropping it.
      const stillApplies = ev && !ev.deleted_at && ev.enable_reminder
        && !['cancelled', 'completed'].includes(ev.status)
        && this.startOf(ev.date, ev.time) > now;

      if (!stillApplies) {
        await this.finish(row.id, 'Skipped', 'No longer applicable — the appointment changed before the retry ran.', null);
        result.skipped += 1;
        continue;
      }

      result.retried += 1;
      // Rebuilt rather than replayed: "in 1 hour" written yesterday is worse than no reminder.
      await this.deliver(row.id, ev as EventRow, row.lead_minutes, result, now);
    }
  }

  private async finish(id: number, status: string, detail: string, sentTo: string | null): Promise<void> {
    await this.prisma.calendar_event_reminders.update({
      where: { id },
      data: { delivery_status: status, detail, sent_to: sentTo, sent_at: status === 'Sent' ? new Date() : null, next_retry_at: null, updated_at: new Date() },
    });
    // Kept in step for anything still reading the old flag, and so the column stops being a lie.
    if (status === 'Sent') {
      const row = await this.prisma.calendar_event_reminders.findUnique({ where: { id }, select: { calendar_event_id: true } });
      if (row) await this.prisma.calendar_events.update({ where: { id: row.calendar_event_id }, data: { reminder_sent: true } }).catch(() => {});
    }
  }

  /** The template's variables, all of them, so no placeholder renders as itself. */
  private variables(ev: EventRow, lead: number, userName: string, companyName: string): Record<string, string> {
    const dash = (v: string | null | undefined) => (v && String(v).trim() !== '' ? String(v) : '—');
    return {
      user_name: userName,
      event_title: ev.title,
      event_type: EVENT_TYPE_LABELS[ev.type] ?? ev.type,
      event_date: ev.date.toISOString().slice(0, 10),
      event_time: ev.time,
      event_end_time: ev.end_time ? ` – ${ev.end_time}` : '',
      when_phrase: this.phrase(lead),
      location: dash(ev.location),
      attendees: dash(ev.attendees),
      contact_phone: dash(ev.contact_phone),
      contact_email: dash(ev.contact_email),
      notes: dash(ev.notes),
      deal_number: dash(ev.transactions?.trade_no),
      property_address: dash(ev.transactions?.property),
      company_name: companyName,
      current_date: new Date().toISOString().slice(0, 10),
    };
  }

  private phrase(lead: number): string {
    if (lead >= 24 * 60) {
      const days = Math.round(lead / (24 * 60));
      return days === 1 ? 'tomorrow' : `in ${days} days`;
    }
    if (lead >= 60) {
      const hours = Math.round(lead / 60);
      return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
    }
    return `in ${lead} minutes`;
  }

  /** A calendar day plus an HH:MM, as one instant. */
  private startOf(date: Date, time: string | null): Date {
    const day = date.toISOString().slice(0, 10);
    return new Date(`${day}T${(time || '00:00').slice(0, 5)}:00`);
  }
}

interface EventRow {
  id: number;
  domain: string | null;
  title: string;
  date: Date;
  time: string;
  end_time: string | null;
  type: string;
  status: string;
  location: string | null;
  attendees: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  user_id: number | null;
  company_id: number;
  deleted_at: Date | null;
  enable_reminder: boolean;
  transactions?: { trade_no: string | null; property: string | null } | null;
}
