import { BadRequestException, Injectable } from '@nestjs/common';
import * as ical from 'node-ical';
import { PrismaService } from '../prisma/prisma.service';
import { SYNC_WINDOW_FUTURE_DAYS, SYNC_WINDOW_PAST_DAYS } from './google.constants';

export interface FeedSyncResult { pulled: number; error: string | null }

/** Google's own secret-iCal host. Restricting to it keeps the server-side fetch SSRF-safe. */
const ALLOWED_HOSTS = new Set(['calendar.google.com']);

/**
 * Read-only Google Calendar sync via the calendar's secret iCal (.ics) address — the no-OAuth
 * connect option. The URL is a per-user credential; it is fetched server-side (only from Google's
 * calendar host, so it can't be pointed at an internal address) and its events are pulled into the
 * CRM calendar. It cannot push, so this is one-way by nature.
 */
@Injectable()
export class IcalFeedService {
  constructor(private readonly prisma: PrismaService) {}

  find(userId: number) {
    return this.prisma.ical_feeds.findUnique({ where: { user_id: userId } });
  }

  /** Only https, and only Google's calendar host — this URL is fetched by the server. */
  private validate(raw: string): string {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new BadRequestException({ message: 'That is not a valid URL.' }); }
    if (url.protocol !== 'https:') throw new BadRequestException({ message: 'The calendar link must start with https://' });
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new BadRequestException({ message: 'Use the secret iCal address from Google Calendar (it starts with https://calendar.google.com/).' });
    }
    return url.toString();
  }

  /** Save the link after confirming it fetches and parses, then pull once. */
  async connect(userId: number, rawUrl: string): Promise<FeedSyncResult & { name: string | null }> {
    const url = this.validate(rawUrl);
    const parsed = await this.fetchAndParse(url); // throws if the link is bad, before storing it
    const now = new Date();
    await this.prisma.ical_feeds.upsert({
      where: { user_id: userId },
      create: { user_id: userId, url, name: parsed.name, created_at: now, updated_at: now },
      update: { url, name: parsed.name, sync_error: null, updated_at: now },
    });
    const result = await this.applyEvents(userId, parsed.events);
    await this.prisma.ical_feeds.update({ where: { user_id: userId }, data: { last_sync: new Date(), sync_error: null } });
    return { ...result, name: parsed.name };
  }

  async sync(userId: number): Promise<FeedSyncResult> {
    const feed = await this.find(userId);
    if (!feed) return { pulled: 0, error: 'No calendar link connected.' };
    try {
      const parsed = await this.fetchAndParse(feed.url);
      const result = await this.applyEvents(userId, parsed.events);
      await this.prisma.ical_feeds.update({ where: { user_id: userId }, data: { name: parsed.name, last_sync: new Date(), sync_error: null } });
      return result;
    } catch (ex) {
      const error = (ex as Error).message.slice(0, 500);
      await this.prisma.ical_feeds.update({ where: { user_id: userId }, data: { sync_error: error, last_sync: new Date() } }).catch(() => {});
      return { pulled: 0, error };
    }
  }

  async disconnect(userId: number): Promise<void> {
    await this.prisma.ical_feeds.deleteMany({ where: { user_id: userId } });
    // Leave already-imported events on the calendar; they are the user's schedule. Re-connecting
    // simply updates them again.
  }

  /** Fetch the ICS and return its calendar name plus VEVENTs. */
  private async fetchAndParse(url: string): Promise<{ name: string | null; events: ical.VEvent[] }> {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) });
    } catch (ex) {
      throw new BadRequestException({ message: `Could not reach the calendar link: ${(ex as Error).message}` });
    }
    if (!res.ok) throw new BadRequestException({ message: `The calendar link returned HTTP ${res.status}. Check that it is the current secret address.` });
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new BadRequestException({ message: 'That link did not return a calendar. Copy the "Secret address in iCal format" from Google Calendar settings.' });

    const data = ical.parseICS(text);
    const nameMatch = /X-WR-CALNAME:(.+)/i.exec(text);
    const name = nameMatch ? nameMatch[1].trim().slice(0, 255) : null;
    const events = Object.values(data).filter((v): v is ical.VEvent => (v as ical.VEvent).type === 'VEVENT');
    return { name, events };
  }

  /** Upsert the feed's events into calendar_events, tagged so they never clash with OAuth events. */
  private async applyEvents(userId: number, events: ical.VEvent[]): Promise<FeedSyncResult> {
    const now = Date.now();
    const min = now - SYNC_WINDOW_PAST_DAYS * 86400000;
    const max = now + SYNC_WINDOW_FUTURE_DAYS * 86400000;
    let pulled = 0;

    for (const ev of events) {
      const start = ev.start instanceof Date ? ev.start : new Date(ev.start as unknown as string);
      if (Number.isNaN(start.getTime())) continue;
      if (start.getTime() < min || start.getTime() > max) continue; // only the visible window

      // `ical:` prefix keeps these distinct from OAuth-synced Google events, which store the raw
      // Google event id — so the two sync paths never overwrite each other's rows.
      const tag = `ical:${String(ev.uid ?? `${start.toISOString()}-${ev.summary ?? ''}`).slice(0, 240)}`;
      const date = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
      const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

      const data = {
        title: String(ev.summary ?? '(no title)').slice(0, 255),
        date, time, type: 'meeting', status: 'scheduled',
        location: ev.location ? String(ev.location).slice(0, 255) : null,
        description: ev.description ? String(ev.description) : null,
        google_calendar_id: tag, user_id: userId, updated_at: new Date(),
      };
      const existing = await this.prisma.calendar_events.findFirst({ where: { google_calendar_id: tag, user_id: userId }, select: { id: true } });
      if (existing) await this.prisma.calendar_events.update({ where: { id: existing.id }, data });
      else await this.prisma.calendar_events.create({ data: { ...data, created_by: 'Google Calendar (link)', created_at: new Date() } });
      pulled++;
    }
    return { pulled, error: null };
  }
}
