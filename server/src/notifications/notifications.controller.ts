import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
import {
  NotificationCenterService,
  type NotificationFilter,
  type NotificationSource,
} from './notification-center.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';
import { ReminderSweepService } from '../transactions/reminder-sweep.service';
import type { ResourceUser } from '../transactions/transaction.resource';

const toResourceUser = (u: AuthUserRecord | undefined): ResourceUser | null =>
  u ? { id: u.id, role: u.role, name: u.name } : null;

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly reviews: TransactionReviewService,
    private readonly reminders: ReminderSweepService,
    private readonly centre: NotificationCenterService,
  ) {}

  /*
   * ---------------------------------------------------------------- Notification Centre
   *
   * One list over the four feeds below, which stay exactly as they were: the two bells in
   * `DeskLayout` still call them, so adding the Centre changes nothing that already worked.
   */

  /** The merged feed. `filter` gives the Centre its unread / read / history views. */
  @Get('notifications')
  centreFeed(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Query('filter') filter?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const allowedFilters: NotificationFilter[] = ['all', 'unread', 'read'];
    const allowedSources: NotificationSource[] = ['agent-change', 'doc-review', 'review-decision', 'reminder', 'direct'];
    return this.centre.feed(toResourceUser(user), {
      // Anything unrecognised falls back to the safe default rather than 400ing: a stale bookmark
      // with an old query string should still show the person their notifications.
      filter: allowedFilters.includes(filter as NotificationFilter) ? (filter as NotificationFilter) : 'all',
      source: allowedSources.includes(source as NotificationSource) ? (source as NotificationSource) : undefined,
      search: search ?? undefined,
      limit: Number.isFinite(Number(limit)) ? Number(limit) : undefined,
      offset: Number.isFinite(Number(offset)) ? Number(offset) : undefined,
    });
  }

  /** Just the badge number, so the bell can poll something cheap. */
  @Get('notifications/count')
  centreCount(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.centre.unreadCount(toResourceUser(user));
  }

  /** Mark one line read. The body names which system it came from. */
  @Post('notifications/read')
  @HttpCode(200)
  centreMarkRead(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() body: { source?: string; transaction_id?: number },
  ) {
    const allowed: NotificationSource[] = ['agent-change', 'doc-review', 'review-decision', 'reminder', 'direct'];
    if (!allowed.includes(body?.source as NotificationSource) || !Number.isInteger(body?.transaction_id)) {
      return { ok: false };
    }
    return this.centre.markRead(toResourceUser(user), body.source as NotificationSource, Number(body.transaction_id));
  }

  /** Mark everything currently unread as read. */
  @Post('notifications/read-all')
  @HttpCode(200)
  centreMarkAllRead(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.centre.markAllRead(toResourceUser(user));
  }

  @Get('agent-change-notifications')
  agentChanges(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.notifications.agentChangeNotifications(toResourceUser(user));
  }

  @Get('doc-notifications')
  docs(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.notifications.docNotifications(toResourceUser(user));
  }

  /** Listing-expiry and lawyer-detail reminders the agent has not seen. */
  @Get('reminder-notifications')
  reminderNotifications(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.reminders.notifications(user?.name ?? null);
  }

  /** Opening the deal marks that day's reminder read. */
  @Post('transactions/:transaction/reminders/seen')
  @HttpCode(200)
  markRemindersSeen(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    return this.reminders.markSeen(user?.name ?? null, id);
  }

  /**
   * Review decisions the agent has not seen — a separate feed from the document one so neither can
   * break the other, merged into a single bell on screen.
   */
  @Get('review-notifications')
  reviewDecisions(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.reviews.notifications(toResourceUser(user));
  }

  @Post('transactions/:transaction/doc-notifications/seen')
  @HttpCode(200)
  markSeen(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    return this.notifications.markDocNotificationsSeen(toResourceUser(user), id);
  }
}
