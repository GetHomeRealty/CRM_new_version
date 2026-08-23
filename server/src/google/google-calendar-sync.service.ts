import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GoogleService, isPermanentSyncFailure, isUnmanageableEvent, type GoogleEvent,
} from './google.service';
import { GoogleConnectionService } from './google-connection.service';
import type { IntegrationScope } from '../email/mail-account.service';
import { GOOGLE_ORIGIN_CREATED_BY, MAX_EVENTS_PER_SYNC, SYNC_WINDOW_FUTURE_DAYS, SYNC_WINDOW_PAST_DAYS } from './google.constants';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker, trackedTick } from '../observability/worker-health';

/** How often the retry sweep runs. Slow on purpose: this exists for outages, not for latency. */
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
/** Delay before the first pass, so it does not compete with boot. */
const FIRST_RETRY_DELAY_MS = 90 * 1000;
/**
 * The most events one pass will attempt.
 *
 * A brokerage-wide Google outage could leave hundreds outstanding; pushing all of them the moment
 * Google returns would be its own thundering herd, and each one is a separate HTTPS round trip.
 * The rest are picked up on the following pass, oldest first.
 */
const RETRY_BATCH = 50;

/**
 * How often connected calendars are pulled FROM Google — the inbound half of the sync.
 *
 * WHY THIS EXISTS. The worker above is an OUTBOUND retry sweep and nothing else: it calls
 * `retryFailedPushes`, which only ever re-sends events this application already owes Google. So
 * `pull` — the entire Google → CRM direction — ran only when somebody pressed "Sync now" or
 * finished the OAuth callback. An event created in Google Calendar simply never appeared in the CRM
 * on its own, and the five-minute log line said "0 of 0 recovered" while doing exactly what it
 * claimed: retrying nothing outbound.
 *
 * FIVE MINUTES, not one. Each pass is one HTTPS request per connected calendar, and `pull` sends
 * the stored `syncToken` so Google returns only what changed since the last pass — cheap, but not
 * free, and multiplied by every connected agent. Five minutes is well inside what people read as
 * "it turns up by itself" and keeps a brokerage of fifty agents to ten requests a minute.
 * `GOOGLE_PULL_SECONDS` overrides it; the floor stops a stray 0 from turning it into a hot loop.
 */
const PULL_INTERVAL_MS = Math.max(60, Number(process.env.GOOGLE_PULL_SECONDS ?? 300)) * 1000;

/** Offset from the retry sweep's first pass, so a restart does not fire both at once. */
const FIRST_PULL_DELAY_MS = 45 * 1000;

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
export class GoogleCalendarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GoogleCalendarSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  /** One pass at a time. A slow pass must not overlap the next tick and double every attempt. */
  private sweeping = false;

  /** The inbound worker's own timers and re-entry guard, kept separate from the outbound sweep's. */
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private pullFirst: ReturnType<typeof setTimeout> | null = null;
  private pulling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleService,
    private readonly connections: GoogleConnectionService,
    // Optional so existing constructions — including this service's specs — keep working.
    // Used only to decide whether THIS process should run a given pass; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    /*
     * The first background worker this integration has had.
     *
     * Before it, a push that failed was simply gone: `pushEvent` is called with `void` from the
     * request that saved the event, so nothing survived that request to try again. Gated like every
     * other scheduler here — off in tests, off unless this process owns the schedulers — so a test
     * run never calls Google and two instances never retry the same event twice.
     */
    if (!schedulersEnabled()) {
      this.log.log(`Google Calendar retry sweep not started (${schedulerSkipReason()}). Retry on the Calendar screen still works.`);
      return;
    }
    this.first = setTimeout(() => { void this.sweep(); }, FIRST_RETRY_DELAY_MS);
    if (typeof this.first.unref === 'function') this.first.unref();

    registerWorker('google-calendar-retry', RETRY_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'google-calendar-retry', () => this.sweep())
        : trackedTick('google-calendar-retry', () => this.sweep()),
      RETRY_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.log(`Google Calendar OUTBOUND retry sweep every ${RETRY_INTERVAL_MS / 1000}s (first pass in ${FIRST_RETRY_DELAY_MS / 1000}s)`);

    /*
     * THE INBOUND HALF, and a separate worker on purpose.
     *
     * It could have been folded into `sweep()`, and that would have been the shorter change and the
     * wrong one. The two have nothing in common but a timer: the retry sweep is bounded by an
     * attempt count and a backoff schedule and exists for outages, while a pull is unconditional,
     * cheap because of the sync token, and needs to happen on a cadence somebody waiting for an
     * appointment would call prompt. Sharing a pass would force one interval on both and make a slow
     * pull delay the retry of an unrelated event.
     *
     * Its own `clusterTick` key, so in a multi-instance deployment exactly one process pulls and
     * exactly one retries — and they need not be the same process.
     */
    this.pullFirst = setTimeout(() => { void this.pullAll(); }, FIRST_PULL_DELAY_MS);
    if (typeof this.pullFirst.unref === 'function') this.pullFirst.unref();

    registerWorker('google-calendar-pull', PULL_INTERVAL_MS);
    this.pullTimer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'google-calendar-pull', () => this.pullAll())
        : trackedTick('google-calendar-pull', () => this.pullAll()),
      PULL_INTERVAL_MS,
    );
    if (typeof this.pullTimer.unref === 'function') this.pullTimer.unref();
    this.log.log(`Google Calendar INBOUND pull every ${PULL_INTERVAL_MS / 1000}s (first pass in ${FIRST_PULL_DELAY_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    if (this.pullFirst) clearTimeout(this.pullFirst);
    if (this.pullTimer) clearInterval(this.pullTimer);
  }

  /**
   * One inbound pass: pull every actively connected calendar into the CRM.
   *
   * DELEGATES TO `pull`, and does not reimplement any of it. That method owns the sync token, the
   * event window, `applyGoogleEvent` and every rule inside it — the birthday and Gmail exclusions,
   * the duplicate check that matches an existing row by (google id, area), the cancelled-event
   * handling and the token refresh. Copying any of that here would create a second importer free to
   * drift from the one the manual "Sync now" button uses, which is precisely the class of bug this
   * codebase keeps recording.
   *
   * ONE CONNECTION'S FAILURE MUST NOT STOP THE OTHERS. `pull` already answers with `{ pulled,
   * error }` rather than throwing, and records the error against the connection itself; the
   * try/catch is for anything it cannot foresee, so a single bad row cannot end the pass for
   * everybody else.
   *
   * INACTIVE CONNECTIONS ARE NOT ASKED. `is_active` is what a revoked grant clears, so this is the
   * same filter that keeps a dead credential from being retried every five minutes for ever.
   */
  async pullAll(): Promise<{ connections: number; pulled: number; failed: number }> {
    if (this.pulling) return { connections: 0, pulled: 0, failed: 0 };
    this.pulling = true;
    try {
      const connected = await this.prisma.google_connections.findMany({
        where: { is_active: true },
        select: { user_id: true, scope: true },
      });
      let pulled = 0;
      let failed = 0;

      for (const c of connected) {
        if (!c.user_id) continue;
        try {
          const r = await this.pull(c.user_id, (c.scope as IntegrationScope) ?? 'crm');
          if (r.error) {
            failed += 1;
            this.log.warn(`Google Calendar inbound pull failed for user #${c.user_id} (${c.scope}): ${r.error}`);
          } else {
            pulled += r.pulled;
          }
        } catch (ex) {
          failed += 1;
          this.log.warn(`Google Calendar inbound pull threw for user #${c.user_id} (${c.scope}): ${(ex as Error).message}`);
        }
      }

      // Logged only when it did something or something went wrong: a quiet pass every five minutes
      // across every deployment is noise that trains people to stop reading the log.
      if (pulled || failed) {
        this.log.log(`Google Calendar INBOUND pull: ${pulled} event(s) from ${connected.length} connection(s), ${failed} failed.`);
      }
      return { connections: connected.length, pulled, failed };
    } catch (ex) {
      this.log.warn(`Google Calendar inbound pull pass failed: ${(ex as Error).message}`);
      return { connections: 0, pulled: 0, failed: 0 };
    } finally {
      this.pulling = false;
    }
  }

  /** One pass over every connection with a failed push to retry. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.retryFailedPushes();
    } catch (ex) {
      this.log.warn(`Google Calendar retry sweep failed: ${(ex as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * How many times the sweep will try one event before it stops asking.
   *
   * Five attempts over roughly four hours of backoff. Past that the failure is not a blip, and
   * carrying on would spend Google quota on something that needs a person — so the event keeps its
   * error, stops being retried automatically, and stays available to the manual Retry button, which
   * resets the count.
   */
  private static readonly MAX_SYNC_ATTEMPTS = 5;

  /** 1 min, 5, 15, 60, 180 — then no more automatic attempts. */
  private static readonly BACKOFF_MINUTES = [1, 5, 15, 60, 180];

  /**
   * Record that an event is now owed to Google, with when to try again.
   *
   * A non-null `google_sync_error` IS the definition of "outstanding" — the sweep, the count on the
   * calendar screen and the manual retry all read it, so there is one fact rather than three that
   * can disagree.
   */
  /**
   * A refusal that will never become an acceptance: stop asking, and stop counting it as owed.
   *
   * WHAT WAS WRONG. Every push failure went to `recordSyncFailure`, which sets `google_sync_error`
   * and schedules a retry. "Owed to Google" is *defined* as that column being non-null, and the
   * screen counts it — so an event Google refuses on principle sat at "1 appointment has not reached
   * Google yet" indefinitely. The background sweep did give up at `MAX_SYNC_ATTEMPTS`, but the
   * Retry button resets the attempt count, so every press restarted a loop whose only possible
   * outcome was "0 of 1 reached Google".
   *
   * WHAT THIS DOES INSTEAD. Clears the outstanding flag, so the count drops and neither the sweep
   * nor the button will select the row again, and DETACHES the Google id — this application is not
   * the manager of that entry and should not hold a pointer to it as though it were.
   *
   * IT DOES NOT TOUCH THE GOOGLE EVENT. Deleting the birthday from the person's calendar to make our
   * own counter go down would be destroying somebody's data to tidy a number. The entry stays
   * exactly where it is; we simply stop claiming it.
   *
   * The reason is kept in the log rather than the row, because the row's error column is precisely
   * what "still owed" means — writing the explanation there is what caused the bug.
   */
  private async recordPermanentFailure(eventId: number, message: string): Promise<void> {
    this.log.warn(
      `Google Calendar refuses event #${eventId} permanently; giving up and releasing it. ${message.slice(0, 200)}`,
    );
    await this.prisma.calendar_events.update({
      where: { id: eventId },
      data: {
        google_sync_error: null,
        google_sync_next_retry_at: null,
        google_sync_attempts: GoogleCalendarSyncService.MAX_SYNC_ATTEMPTS,
        google_calendar_id: null,
      },
    }).catch(() => undefined);
  }

  private async recordSyncFailure(eventId: number, message: string): Promise<void> {
    // A permanent refusal is not a failed attempt to be tried again — see `recordPermanentFailure`.
    if (isPermanentSyncFailure(message)) return this.recordPermanentFailure(eventId, message);

    const row = await this.prisma.calendar_events.findUnique({
      where: { id: eventId }, select: { google_sync_attempts: true },
    });
    const attempts = (row?.google_sync_attempts ?? 0) + 1;
    const wait = GoogleCalendarSyncService.BACKOFF_MINUTES[
      Math.min(attempts - 1, GoogleCalendarSyncService.BACKOFF_MINUTES.length - 1)
    ];
    await this.prisma.calendar_events.update({
      where: { id: eventId },
      data: {
        google_sync_error: message.slice(0, 500),
        google_sync_attempts: attempts,
        // Still stamped past the cap: the column then reads as "when it would have tried", and the
        // sweep is bounded by the attempt count rather than by the absence of a date.
        google_sync_next_retry_at: new Date(Date.now() + wait * 60_000),
      },
    }).catch(() => undefined);
  }

  /** Clear the outstanding state after a push finally lands. */
  private async recordSyncSuccess(eventId: number, extra: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.calendar_events.update({
      where: { id: eventId },
      data: {
        ...extra,
        last_synced_to_google: new Date(),
        google_sync_error: null, google_sync_attempts: 0, google_sync_next_retry_at: null,
      },
    }).catch(() => undefined);
  }

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
    /*
     * GOOGLE-GENERATED ENTRIES ARE NOT MIRRORED, and this is the fix for the outstanding
     * appointment that could never clear.
     *
     * A Contact's birthday appears on the primary calendar as an ordinary-looking all-day event, so
     * the pull imported it like anything else and gave the CRM row a `google_calendar_id`. The
     * moment that row was deleted, the push tried to DELETE the birthday from Google and was
     * refused with `eventTypeRestriction` — permanently, by design, for every caller.
     *
     * Skipping them at the boundary is the real cure: nothing downstream can attempt to modify an
     * event that was never adopted. `isUnmanageableEvent` treats a missing `eventType` as `default`,
     * so ordinary appointments — including out-of-office and focus-time entries a person actually
     * created — are unaffected.
     *
     * Rows imported BEFORE this guard existed still carry the link; `recordPermanentFailure` below
     * is what releases those.
     */
    if (isUnmanageableEvent(ev)) return false;

    const existing = await this.prisma.calendar_events.findFirst({
      // `domain: null` is included so an event that pre-dates the split is claimed and stamped by
      // the next pull rather than being duplicated alongside itself.
      //
      // DELETED ROWS ARE DELIBERATELY IN SCOPE. This has never filtered `deleted_at`, and must not
      // start: matching a hidden row is what makes a reconnect REUSE it instead of inserting a
      // second copy of the same appointment beside it.
      where: { google_calendar_id: ev.id, user_id: userId, OR: [{ domain: area }, { domain: null }] },
      select: { id: true, google_disconnected_at: true },
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
      await this.prisma.calendar_events.update({
        where: { id: existing.id },
        data: {
          ...fromGoogle,
          /*
           * BRING BACK ONLY WHAT A DISCONNECT HID.
           *
           * `google_disconnected_at` is set exactly once — by `GoogleConnectionService.disconnect`
           * — so a row carrying it is one this integration hid, and reconnecting is precisely the
           * event that should undo that. Clearing both fields restores it in place, which is also
           * what stops the reconnect creating a duplicate: the row is reused, so the calendar shows
           * one appointment rather than two.
           *
           * A row WITHOUT the marker is one the agent deleted, and it stays deleted. That case is
           * real rather than theoretical: `remove()` pushes the deletion on to Google best-effort
           * and never blocks on it, so when that push fails the event still exists in Google and is
           * returned by the very next pull. Restoring unconditionally would undo the agent's
           * deletion, on a schedule, with nothing to show why.
           */
          ...(existing.google_disconnected_at ? { deleted_at: null, google_disconnected_at: null } : {}),
        },
      });
    } else {
      // On first arrival there is nothing to preserve, so the defaults apply.
      await this.prisma.calendar_events.create({
        data: { ...fromGoogle, type: 'meeting', status: 'scheduled', created_by: GOOGLE_ORIGIN_CREATED_BY, created_at: new Date() },
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
      if (googleId) await this.recordSyncSuccess(ev.id, { google_calendar_id: googleId });
      // A null id is not an exception but is not a success either — Google accepted nothing, so the
      // event is still owed and must be retried like any other failure.
      else await this.recordSyncFailure(ev.id, 'Google accepted the request but returned no event id.');
    } catch (ex) {
      this.log.warn(`Push to Google Calendar failed for event #${eventId}: ${(ex as Error).message}`);
      await this.recordSyncFailure(ev.id, (ex as Error).message);
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
      if (ok) await this.recordSyncSuccess(ev.id);
      else await this.recordSyncFailure(ev.id, 'Google refused the change to this appointment.');
    } catch (ex) {
      this.log.warn(`Update to Google Calendar failed for event #${eventId}: ${(ex as Error).message}`);
      await this.recordSyncFailure(ev.id, (ex as Error).message);
    }
  }

  /**
   * Remove an event from Google after it is deleted here.
   *
   * Read before the local delete happens, because a soft-deleted row is still the only place the
   * Google id is recorded — so the caller passes the details in rather than looking them up again.
   */
  async removeEvent(userId: number | null, googleEventId: string | null, domain: string | null, eventId?: number): Promise<void> {
    if (!userId || !googleEventId) return;
    const conn = await this.connectionFor(userId, domain);
    // No usable connection is not the same as a failed call: there is nothing to retry until the
    // agent reconnects, and marking every deleted event as "owed" while disconnected would fill the
    // screen's count with things no retry can fix.
    if (!conn) return;
    try {
      await this.google.deleteEvent(conn.token, conn.calendarId, googleEventId);
      if (eventId) await this.recordSyncSuccess(eventId);
    } catch (ex) {
      this.log.warn(`Delete from Google Calendar failed for event ${googleEventId}: ${(ex as Error).message}`);
      /*
       * `eventId` is optional only because this method is called with the row's details read BEFORE
       * the delete — the row still exists (soft delete), so it can carry the outstanding state like
       * any other. Without it a failed delete leaves a cancelled showing on the client's shared
       * calendar with nothing to try again, which is the worst of the three failures.
       */
      if (eventId) await this.recordSyncFailure(eventId, (ex as Error).message);
    }
  }


  // ------------------------------------------------------- retry (CRM-GCAL-M01)
  /**
   * Retry the pushes Google refused, oldest first.
   *
   * WHY A SWEEP AT ALL, given there was no Google scheduler before this. Because the alternative for
   * a transient failure is nothing: `pushEvent` and friends are called with `void` from the request
   * that saved the event, so once that request has returned there is no other thread of control
   * left. Retrying inline would make an agent wait on Google to save a viewing, which is exactly the
   * coupling `void` exists to avoid.
   *
   * BOUNDED IN THREE WAYS on purpose, because an unbounded retry against a third party is its own
   * outage: five attempts per event, an increasing wait between them, and a cap on how many events
   * one pass will take. A connection whose credential is permanently dead is excluded entirely —
   * `accessToken` deactivates it (CRM-GCAL-M02), and a deactivated connection yields no token, so
   * those events stop consuming attempts instead of burning all five on a certainty.
   */
  async retryFailedPushes(): Promise<{ attempted: number; recovered: number }> {
    let attempted = 0;
    let recovered = 0;

    /*
     * ONLY USERS WHO ARE ACTUALLY CONNECTED, which the first runtime check of this sweep earned.
     *
     * An event owed to Google by somebody with no active connection is picked up, finds no token,
     * and returns without recording anything — correct, because a disconnected agent must not burn
     * the five attempts on a certainty, and the event stays counted and visible until they
     * reconnect. But it is also picked up on EVERY pass thereafter, so the sweep logged
     * "0 of 1 recovered" every five minutes for ever and spent a slot in each batch on work that
     * cannot succeed. Observed at 17:00 on 2026-08-05 against a seeded event.
     *
     * `is_active` is also what CRM-GCAL-M02 clears for a revoked grant, so this is the same filter
     * that keeps a dead credential out of the batch.
     */
    const connected = await this.prisma.google_connections.findMany({
      where: { is_active: true }, select: { user_id: true },
    });
    if (!connected.length) return { attempted: 0, recovered: 0 };

    const due = await this.prisma.calendar_events.findMany({
      where: {
        user_id: { in: connected.map((c) => c.user_id) },
        google_sync_error: { not: null },
        google_sync_attempts: { lt: GoogleCalendarSyncService.MAX_SYNC_ATTEMPTS },
        OR: [{ google_sync_next_retry_at: null }, { google_sync_next_retry_at: { lte: new Date() } }],
      },
      // Oldest failure first, so a backlog drains in the order it happened rather than newest-wins.
      orderBy: { google_sync_next_retry_at: 'asc' },
      take: RETRY_BATCH,
      select: { id: true, user_id: true, deleted_at: true, google_calendar_id: true, domain: true },
    });

    for (const ev of due) {
      if (!ev.user_id) continue;
      attempted += 1;
      const before = ev.google_calendar_id;
      /*
       * The operation is derived from the row rather than stored beside it: deleted means remove,
       * never-mirrored means insert, otherwise patch. One source of truth, so the retry cannot
       * disagree with what the event actually is now — an event created, edited and then deleted
       * before the sweep ran needs a delete, not the insert that first failed.
       */
      if (ev.deleted_at) await this.removeEvent(ev.user_id, ev.google_calendar_id, ev.domain, ev.id);
      else if (!before) await this.pushEvent(ev.user_id, ev.id);
      else await this.updateEvent(ev.user_id, ev.id);

      const after = await this.prisma.calendar_events.findUnique({
        where: { id: ev.id }, select: { google_sync_error: true },
      });
      if (!after?.google_sync_error) recovered += 1;
    }

    // "OUTBOUND" is not decoration: this line reading "0 of 0 recovered" every five minutes was
    // read as evidence that calendar sync was running, when the inbound half did not exist at all.
    if (attempted) this.log.log(`Google Calendar OUTBOUND retry: ${recovered} of ${attempted} recovered.`);
    return { attempted, recovered };
  }

  /**
   * What one person still owes Google, for the calendar screen.
   *
   * Counted rather than listed: the screen needs to say "three appointments have not reached Google"
   * and offer one button, and listing them would invite a per-event control that nobody can act on
   * differently from the others.
   */
  async pendingSyncCount(userId: number, area: IntegrationScope = 'crm'): Promise<number> {
    return this.prisma.calendar_events.count({
      where: {
        user_id: userId, google_sync_error: { not: null },
        OR: [{ domain: area }, { domain: null }],
      },
    });
  }

  /**
   * The Retry button: try this person's outstanding events again, now.
   *
   * The attempt COUNT is reset first, which is the whole point of a manual retry — an event that has
   * exhausted its five automatic attempts is precisely the one somebody is pressing this for, and it
   * would otherwise be skipped by the same rule that stopped the sweep. `next_retry_at` is cleared
   * so nothing is waiting out a backoff either.
   */
  async retryNow(userId: number, area: IntegrationScope = 'crm'): Promise<{ attempted: number; recovered: number; released: number }> {
    const mine = await this.prisma.calendar_events.findMany({
      where: {
        user_id: userId, google_sync_error: { not: null },
        OR: [{ domain: area }, { domain: null }],
      },
      orderBy: { id: 'asc' },
      take: RETRY_BATCH,
      select: { id: true, deleted_at: true, google_calendar_id: true, domain: true },
    });
    if (!mine.length) return { attempted: 0, recovered: 0, released: 0 };

    await this.prisma.calendar_events.updateMany({
      where: { id: { in: mine.map((m) => m.id) } },
      data: { google_sync_attempts: 0, google_sync_next_retry_at: null },
    });

    let recovered = 0;
    /** Rows Google refuses permanently: no longer outstanding, but they never reached Google. */
    let released = 0;
    for (const ev of mine) {
      if (ev.deleted_at) await this.removeEvent(userId, ev.google_calendar_id, ev.domain, ev.id);
      else if (!ev.google_calendar_id) await this.pushEvent(userId, ev.id);
      else await this.updateEvent(userId, ev.id);

      const after = await this.prisma.calendar_events.findUnique({
        where: { id: ev.id }, select: { google_sync_error: true, google_sync_attempts: true },
      });
      /*
       * CLEARED IS NOT THE SAME AS SYNCED.
       *
       * A permanent refusal also clears `google_sync_error` — that is how the row stops being
       * outstanding — so counting "no error" as recovered would report an event Google flatly
       * refused as having reached it. The two are told apart without a new column by the attempt
       * count: `recordSyncSuccess` zeroes it, `recordPermanentFailure` pins it at the cap.
       */
      if (!after?.google_sync_error) {
        if (after?.google_sync_attempts === GoogleCalendarSyncService.MAX_SYNC_ATTEMPTS) released += 1;
        else recovered += 1;
      }
    }
    return { attempted: mine.length, recovered, released };
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
