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
        // The connection's scope IS the event's area: something pulled from the calendar connected
        // under CRM Settings is a CRM event, and one pulled from the Transaction Desk's is a
        // Transaction Desk event.
        if (await this.applyGoogleEvent(userId, ev, scope)) pulled++;
      }
      await this.connections.touchSync(userId, res.nextSyncToken, scope);
      return { pulled, error: null };
    } catch (ex) {
      const error = (ex as Error).message.slice(0, 500);
      await this.connections.recordError(userId, error, scope);
      return { pulled: 0, error };
    }
  }

  /**
   * Upsert one Google event into calendar_events. Returns true when a row was written.
   *
   * `area` is the scope of the connection it came from, and it is part of the identity of the row:
   * the same meeting can genuinely exist in both connected Google accounts — 22 of the events in
   * this database do — so matching on the Google id alone would make a pull from one calendar
   * overwrite the other area's copy and silently move it across the boundary. The pair
   * (google id, area) is what identifies a row.
   */
  private async applyGoogleEvent(userId: number, ev: GoogleEvent, area: IntegrationScope): Promise<boolean> {
    const existing = await this.prisma.calendar_events.findFirst({
      // `domain: null` is included so an event that pre-dates the split is claimed and stamped by
      // the next pull rather than being duplicated alongside itself.
      where: { google_calendar_id: ev.id, user_id: userId, OR: [{ domain: area }, { domain: null }] },
      select: { id: true },
    });

    // A cancelled Google event removes its local copy rather than leaving a ghost. Only this
    // area's copy: the other calendar still lists it, so removing that one too would delete an
    // event the other area can still see on Google.
    if (ev.status === 'cancelled') {
      if (existing) await this.prisma.calendar_events.update({ where: { id: existing.id }, data: { deleted_at: new Date(), updated_at: new Date() } });
      return false;
    }

    const startIso = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
    if (!startIso) return false;
    const start = new Date(startIso);
    const date = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

    // What Google actually knows about. Safe to write on every pull, because Google is the source
    // of truth for all of it.
    const fromGoogle = {
      title: (ev.summary ?? '(no title)').slice(0, 255),
      date, time,
      location: ev.location ? ev.location.slice(0, 255) : null,
      description: ev.description ?? null,
      google_calendar_id: ev.id,
      last_synced_to_google: new Date(),
      user_id: userId,
      // Which area's calendar this belongs to. Written on update as well as create, so the events
      // that pre-date the split are classified the first time they are seen again.
      domain: area,
      updated_at: new Date(),
    };

    if (existing) {
      // `type` and `status` are deliberately NOT in this update.
      //
      // They are the brokerage's own vocabulary — Open House, Showing, Viewing; Completed,
      // Cancelled, Rescheduled — and Google has no equivalent to supply. They used to be written
      // here as a hardcoded `meeting`/`scheduled` on every pull, which meant an agent who marked a
      // showing Completed found it Scheduled again a few minutes later, on a schedule, silently.
      // Nearly every event in this database arrives from Google, so that reverted almost the whole
      // calendar's status history. Writing a field a sync cannot know can only ever destroy
      // information, so this branch leaves both alone.
      await this.prisma.calendar_events.update({ where: { id: existing.id }, data: fromGoogle });
    } else {
      // On first arrival there is nothing to preserve, so the defaults apply.
      await this.prisma.calendar_events.create({
        data: { ...fromGoogle, type: 'meeting', status: 'scheduled', created_by: 'Google Calendar', created_at: new Date() },
      });
    }
    return true;
  }

  /**
   * Mirror a locally created event to Google, best-effort. Called after an event is created. Silent
   * when the user has no Google connection for that area, and never throws into the caller — a
   * calendar save must not fail because Google was briefly unreachable.
   *
   * The event is read FIRST so its area can choose the connection. Both connection lookups default
   * to `crm`, so before this every event pushed to the CRM's Google calendar — a Transaction Desk
   * appointment appeared in the CRM's calendar and nowhere else, which is precisely the mixing this
   * separation removes.
   */
  async pushEvent(userId: number | null, eventId: number): Promise<void> {
    if (!userId) return;

    const ev = await this.prisma.calendar_events.findFirst({ where: { id: eventId, user_id: userId } });
    // Don't echo an event that came FROM Google back to Google.
    if (!ev || ev.google_calendar_id) return;

    const conn = await this.connectionFor(userId, ev.domain);
    if (!conn) return;

    try {
      const googleId = await this.google.insertEvent(conn.token, conn.calendarId, this.googlePayload(ev));
      if (googleId) {
        await this.prisma.calendar_events.update({ where: { id: ev.id }, data: { google_calendar_id: googleId, last_synced_to_google: new Date() } });
      }
    } catch (ex) {
      this.log.warn(`Push to Google Calendar failed for event #${eventId}: ${(ex as Error).message}`);
    }
  }

  /**
   * Mirror an edit out to Google. Called after an event is updated.
   *
   * Without this, the mirror only ever ran once: a viewing moved from 2pm to 5pm, or renamed, or
   * given a new address, kept its original details on the agent's phone and on any calendar shared
   * with a client. The push and the pull were a one-way street in both directions at once — the app
   * could not send a change out, and the next pull wrote Google's stale copy back over the local
   * one. Same best-effort contract as `pushEvent`: Google being unreachable must never fail a save.
   */
  async updateEvent(userId: number | null, eventId: number): Promise<void> {
    if (!userId) return;
    const ev = await this.prisma.calendar_events.findFirst({ where: { id: eventId, user_id: userId } });
    // Nothing to update if it was never mirrored. `pushEvent` covers first publication.
    if (!ev?.google_calendar_id) return;

    const conn = await this.connectionFor(userId, ev.domain);
    if (!conn) return;

    try {
      const ok = await this.google.patchEvent(conn.token, conn.calendarId, ev.google_calendar_id, this.googlePayload(ev));
      if (ok) await this.prisma.calendar_events.update({ where: { id: ev.id }, data: { last_synced_to_google: new Date() } });
    } catch (ex) {
      this.log.warn(`Update to Google Calendar failed for event #${eventId}: ${(ex as Error).message}`);
    }
  }

  /**
   * Remove an event from Google after it is deleted here.
   *
   * Read before the local delete happens, because a soft-deleted row is still the only place the
   * Google id is recorded — so the caller passes the details in rather than looking them up again.
   */
  async removeEvent(userId: number | null, googleEventId: string | null, domain: string | null): Promise<void> {
    if (!userId || !googleEventId) return;
    const conn = await this.connectionFor(userId, domain);
    if (!conn) return;
    try {
      await this.google.deleteEvent(conn.token, conn.calendarId, googleEventId);
    } catch (ex) {
      this.log.warn(`Delete from Google Calendar failed for event ${googleEventId}: ${(ex as Error).message}`);
    }
  }

  /**
   * The connection an event belongs to.
   *
   * An unclassified event goes to the CRM connection, which is where every event went before the
   * split — the same choice `areaFor` makes for the old URLs, for the same reason.
   */
  private async connectionFor(userId: number, domain: string | null): Promise<{ token: string; calendarId: string } | null> {
    const area: IntegrationScope = domain === 'desk' ? 'desk' : 'crm';
    const token = await this.connections.accessToken(userId, area).catch(() => null);
    if (!token) return null;
    const conn = await this.connections.find(userId, area);
    return conn ? { token, calendarId: conn.calendar_id } : null;
  }

  /** One event, in Google's shape — used by insert and patch alike so the two cannot drift. */
  private googlePayload(ev: { title: string; date: Date; time: string | null; end_time: string | null; description: string | null; location: string | null; status: string }): Record<string, unknown> {
    const day = ev.date.toISOString().slice(0, 10);
    const start = new Date(`${day}T${(ev.time || '09:00').slice(0, 5)}:00`);
    // A real end time when the event has one; otherwise the hour this has always assumed.
    const end = ev.end_time ? new Date(`${day}T${ev.end_time.slice(0, 5)}:00`) : new Date(start.getTime() + 60 * 60 * 1000);
    const tz = process.env.TZ || 'America/Toronto';
    return {
      summary: ev.title,
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      // A cancelled appointment shows as cancelled in Google rather than sitting there as if live.
      ...(ev.status === 'cancelled' ? { status: 'cancelled' } : {}),
    };
  }
}
