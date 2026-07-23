import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CalendarService, type EventInput, type EventQuery } from './calendar.service';
import { EVENT_TYPES, EVENT_STATUSES, EVENT_TYPE_LABELS } from './calendar.constants';
import {
  DEFAULT_PROVINCE, FESTIVAL_YEARS, holidaysBetween, holidaysForYear, isProvince, type Province,
} from './holidays';

/** Calendar events. Reading needs `calendar` view; creating/editing needs `calendar` edit. */
@Controller('calendar')
@UseGuards(AuthGuard, ScreenGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

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
    return this.calendar.list(user, query);
  }

  @Get('events/:id')
  @Screen('calendar', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.calendar.get(id, user);
  }

  @Post('events')
  @HttpCode(201)
  @Screen('calendar', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: EventInput): Promise<unknown> {
    return this.calendar.create(body ?? {}, user);
  }

  @Put('events/:id')
  @Screen('calendar', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: EventInput): Promise<unknown> {
    return this.calendar.update(id, body ?? {}, user);
  }

  @Delete('events/:id')
  @Screen('calendar', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.calendar.remove(id, user);
  }
}
