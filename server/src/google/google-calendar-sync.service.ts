import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleService, type GoogleEvent } from './google.service';
import { GoogleConnectionService } from './google-connection.service';
import type { IntegrationScope } from '../email/mail-account.service';
import { MAX_EVENTS_PER_SYNC, SYNC_WINDOW_FUTURE_DAYS, SYNC_WINDOW_PAST_DAYS } from './google.constants';

export interface SyncResult { pulled: number; error: string | null }

/**
 * Two-way sync between a user's Google Calendar and their CRM calendar.
 *
 *   Pull: Google events land in `calendar_events` tagged with their `google_calendar_id`, so they
 *   appear on the user's calendar and a re-pull updates rather than duplicates them.
 *   Push: a CRM event the user creates is mirrored to Google, and its `google_calendar_id` is
 *   stored so it is never pulled back in as a second copy.
 *
 * Everything is per-user and scoped to the connection owner.
 */
@Injectable()
export class GoogleCalendarSyncService {
  private readonly log = new Logger(GoogleCalendarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleService,
    private readonly connections: GoogleConnectionService,
  ) {}

  /** Pull the user's Google events into their CRM calendar. */
  async pull(userId: number, scope: IntegrationScope = 'crm'): Promise<SyncResult> {
    const token = await this.connections.accessToken(userId, scope);
    if (!token) return { pulled: 0, error: 'Not connected to Google, or the connection needs renewing.' };
    const conn = await this.connections.find(userId, scope);
    if (!conn) return { pulled: 0, error: 'Not connected.' };

    try {
      const now = Date.now();
      let res = await this.google.listEvents(token, conn.calendar_id, {
        syncToken: conn.sync_token ?? undefined,
        timeMin: new Date(now - SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
        timeMax: new Date(now + SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
        maxResults: MAX_EVENTS_PER_SYNC,
      });
      // A stale incremental token forces a clean full window pull.
      if (res.expiredSyncToken) {
        await this.connections.touchSync(userId, null, scope);
        res = await this.google.listEvents(token, conn.calendar_id, {
          timeMin: new Date(now - SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
          timeMax: new Date(now + SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
          maxResults: MAX_EVENTS_PER_SYNC,
        });
      }

      let pulled = 0;
      for (const ev of res.events) {
        if (await this.applyGoogleEvent(userId, ev)) pulled++;
      }
      await this.connections.touchSync(userId, res.nextSyncToken, scope);
      return { pulled, error: null };
    } catch (ex) {
      const error = (ex as Error).message.slice(0, 500);
      await this.connections.recordError(userId, error, scope);
      return { pulled: 0, error };
    }
  }

  /** Upsert one Google event into calendar_events. Returns true when a row was written. */
  private async applyGoogleEvent(userId: number, ev: GoogleEvent): Promise<boolean> {
    const existing = await this.prisma.calendar_events.findFirst({ where: { google_calendar_id: ev.id, user_id: userId }, select: { id: true } });

    // A cancelled Google event removes its CRM copy rather than leaving a ghost.
    if (ev.status === 'cancelled') {
      if (existing) await this.prisma.calendar_events.update({ where: { id: existing.id }, data: { deleted_at: new Date(), updated_at: new Date() } });
      return false;
    }

    const startIso = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
    if (!startIso) return false;
    const start = new Date(startIso);
    const date = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

    const data = {
      title: (ev.summary ?? '(no title)').slice(0, 255),
      date, time,
      type: 'meeting', status: 'scheduled',
      location: ev.location ? ev.location.slice(0, 255) : null,
      description: ev.description ?? null,
      google_calendar_id: ev.id,
      last_synced_to_google: new Date(),
      user_id: userId,
      updated_at: new Date(),
    };
    if (existing) await this.prisma.calendar_events.update({ where: { id: existing.id }, data });
    else await this.prisma.calendar_events.create({ data: { ...data, created_by: 'Google Calendar', created_at: new Date() } });
    return true;
  }

  /**
   * Mirror a CRM event to Google, best-effort. Called after an event is created. Silent when the
   * user has no Google connection, and never throws into the caller — a calendar save must not
   * fail because Google was briefly unreachable.
   */
  async pushEvent(userId: number | null, eventId: number): Promise<void> {
    if (!userId) return;
    const token = await this.connections.accessToken(userId).catch(() => null);
    if (!token) return;
    const conn = await this.connections.find(userId);
    if (!conn) return;

    const ev = await this.prisma.calendar_events.findFirst({ where: { id: eventId, user_id: userId } });
    // Don't echo an event that came FROM Google back to Google.
    if (!ev || ev.google_calendar_id) return;

    try {
      const start = new Date(`${ev.date.toISOString().slice(0, 10)}T${(ev.time || '09:00').slice(0, 5)}:00`);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const tz = process.env.TZ || 'America/Toronto';
      const googleId = await this.google.insertEvent(token, conn.calendar_id, {
        summary: ev.title,
        description: ev.description ?? undefined,
        location: ev.location ?? undefined,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
      });
      if (googleId) {
        await this.prisma.calendar_events.update({ where: { id: ev.id }, data: { google_calendar_id: googleId, last_synced_to_google: new Date() } });
      }
    } catch (ex) {
      this.log.warn(`Push to Google Calendar failed for event #${eventId}: ${(ex as Error).message}`);
    }
  }
}
