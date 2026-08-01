import type { Request } from 'express';
import { AreaGuard } from '../core/area.guard';
import { parseArea } from '../common/domain';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CalendarService, isSeriesScope, type EventInput, type EventQuery } from './calendar.service';
import { CalendarAnalyticsService, type CalendarAnalytics } from './calendar-analytics.service';
import { EventSuggestionsService, type SuggestionResult } from './event-suggestions.service';
import { WebPushService } from './web-push.service';
import { EVENT_TYPES, EVENT_STATUSES, EVENT_TYPE_LABELS } from './calendar.constants';
import {
  DEFAULT_PROVINCE, FESTIVAL_YEARS, holidaysBetween, holidaysForYear, isProvince, type Province,
} from './holidays';

/** Calendar events. Reading needs `calendar` view; creating/editing needs `calendar` edit. */
@Controller('calendar')
@UseGuards(AuthGuard, ScreenGuard, AreaGuard)
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly analytics: CalendarAnalyticsService,
    private readonly suggestions: EventSuggestionsService,
    private readonly push: WebPushService,
  ) {}

  // ------------------------------------------------------------------- push
  /**
   * What a browser needs to subscribe, and whether it is worth offering at all.
   *
   * `view` rather than `edit`: reading whether push is available is not a change. A null key means
   * the server has no VAPID pair, and the client hides the whole thing rather than showing a
   * control that cannot work.
   */
  @Get('push/key')
  @Screen('calendar', 'view')
  pushKey(): { public_key: string | null; configured: boolean } {
    return { public_key: this.push.publicKey(), configured: this.push.configured() };
  }

  /** The browsers this person has subscribed, so they can see and revoke them. */
  @Get('push/subscriptions')
  @Screen('calendar', 'view')
  pushList(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.push.forUser(user.id ?? -1);
  }

  @Post('push/subscribe')
  @HttpCode(200)
  @Screen('calendar', 'view')
  async pushSubscribe(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; scope?: string },
    @Req() req: Request,
  ): Promise<{ id: number }> {
    const endpoint = String(body?.endpoint ?? '').trim();
    const p256dh = String(body?.keys?.p256dh ?? '').trim();
    const auth = String(body?.keys?.auth ?? '').trim();
    // All three come from the browser's own PushSubscription; a request missing any of them cannot
    // have come from one, and storing a partial subscription would fail silently at send time.
    if (!endpoint.startsWith('https://') || !p256dh || !auth) {
      throw new BadRequestException({ message: 'That is not a usable push subscription.' });
    }
    const scope = body?.scope === 'crm' || body?.scope === 'desk' ? body.scope : null;
    return this.push.subscribe(user.id ?? -1, { endpoint, keys: { p256dh, auth } }, scope, req.headers['user-agent'] ?? null);
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  @Screen('calendar', 'view')
  pushUnsubscribe(@CurrentUser() user: AuthUserRecord, @Body() body: { endpoint?: string }): Promise<unknown> {
    return this.push.unsubscribe(user.id ?? -1, String(body?.endpoint ?? '').trim());
  }

  /** Prove it works, to this person's own browsers only. */
  @Post('push/test')
  @HttpCode(200)
  @Screen('calendar', 'view')
  pushTest(@CurrentUser() user: AuthUserRecord, @Query('area') area?: string): Promise<unknown> {
    return this.push.sendToUser(user.id ?? -1, {
      title: 'Test notification',
      body: 'Push notifications are working. Appointment reminders will arrive like this.',
      tag: 'calendar-test',
    }, parseArea(area));
  }

  /** Vocabularies for the event form (types + statuses with their labels). */
  @Get('options')
  @Screen('calendar', 'view')
  options(): Record<string, unknown> {
    return {
      types: EVENT_TYPES.map((value) => ({ value, label: EVENT_TYPE_LABELS[value] ?? value })),
      statuses: EVENT_STATUSES.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
    };
  }

  /**
   * Canadian statutory holidays and cultural festivals in a date range.
   *
   * Computed on request rather than stored, so no year is ever missing and nothing is written
   * into `calendar_events` — holidays stay separate from the user's own appointments.
   */
  @Get('holidays')
  @Screen('calendar', 'view')
  holidays(@Query() q: Record<string, string>): Record<string, unknown> {
    const province = isProvince(String(q.province ?? '')) ? (q.province as Province) : DEFAULT_PROVINCE;
    const dateLike = /^\d{4}-\d{2}-\d{2}$/;

    // Either an explicit range (what the month grid asks for) or a whole year.
    if (dateLike.test(q.from ?? '') && dateLike.test(q.to ?? '')) {
      return { province, festival_years: FESTIVAL_YEARS, data: holidaysBetween(q.from, q.to, province) };
    }
    const year = Number(q.year) || new Date().getFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new BadRequestException({ message: 'Enter a year between 1900 and 2200.' });
    }
    return { province, festival_years: FESTIVAL_YEARS, data: holidaysForYear(year, province) };
  }

  /**
   * What actually happened in the caller's own diary over a range.
   *
   * Defaults to the last 90 days, which is long enough for a rate to mean something and short
   * enough that a slow month does not disappear into a year of averages.
   */
  @Get('analytics')
  @Screen('calendar', 'view')
  analyticsSummary(@CurrentUser() user: AuthUserRecord, @Query() q: Record<string, string>): Promise<CalendarAnalytics> {
    const dateLike = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const defaultFrom = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    const from = dateLike.test(q.from ?? '') ? q.from : defaultFrom;
    const to = dateLike.test(q.to ?? '') ? q.to : defaultTo;
    // Reversed by hand in the URL would otherwise return an empty report that looks like "no work".
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return this.analytics.summary(user, parseArea(q.area), lo, hi);
  }

  @Get('events')
  @Screen('calendar', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query() q: Record<string, string>): Promise<unknown> {
    const query: EventQuery = {
      from: /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : undefined,
      to: /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : undefined,
      type: q.type || undefined,
      status: q.status || undefined,
      transaction_id: Number(q.transaction_id) > 0 ? Number(q.transaction_id) : undefined,
      lead_id: Number(q.lead_id) > 0 ? Number(q.lead_id) : undefined,
    };
    // The area comes from the query string, so a link can address one calendar directly. An
    // absent or unrecognised value falls back to the Transaction Desk, keeping older callers working.
    return this.calendar.list(user, parseArea(q.area), query);
  }

  @Get('events/:id')
  @Screen('calendar', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Query('area') area?: string): Promise<unknown> {
    return this.calendar.get(id, user, parseArea(area));
  }

  @Post('events')
  @HttpCode(201)
  @Screen('calendar', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: EventInput, @Query('area') area?: string): Promise<unknown> {
    return this.calendar.create(body ?? {}, user, parseArea(area));
  }

  @Put('events/:id')
  @Screen('calendar', 'edit')
  update(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EventInput,
    @Query('area') area?: string,
    /** `series` applies the change to this occurrence and the later ones. Default is this one only. */
    @Query('scope') scope?: string,
  ): Promise<unknown> {
    return this.calendar.update(id, body ?? {}, user, parseArea(area), isSeriesScope(scope) ? scope : 'this');
  }

  /**
   * Suggested follow-ups for one appointment.
   *
   * POST rather than GET: it costs money per call and must not be fired by a prefetch, a refresh or
   * a link somebody pasted. `calendar` edit rather than view, for the same reason — spending the
   * brokerage's AI budget is not a read.
   */
  @Post('events/:id/suggestions')
  @HttpCode(200)
  @Screen('calendar', 'edit')
  suggest(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
  ): Promise<SuggestionResult> {
    return this.suggestions.forEvent(id, user, parseArea(area));
  }

  @Delete('events/:id')
  @Screen('calendar', 'edit')
  remove(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
    /** `series` also removes the later occurrences. Default is this one only. */
    @Query('scope') scope?: string,
  ): Promise<unknown> {
    return this.calendar.remove(id, user, parseArea(area), isSeriesScope(scope) ? scope : 'this');
  }
}
