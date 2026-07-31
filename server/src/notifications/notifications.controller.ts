import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';
import type { ResourceUser } from '../transactions/transaction.resource';

const toResourceUser = (u: AuthUserRecord | undefined): ResourceUser | null =>
  u ? { id: u.id, role: u.role, name: u.name } : null;

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly reviews: TransactionReviewService,
  ) {}

  @Get('agent-change-notifications')
  agentChanges(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.notifications.agentChangeNotifications(toResourceUser(user));
  }

  @Get('doc-notifications')
  docs(@CurrentUser() user: AuthUserRecord | undefined) {
    return this.notifications.docNotifications(toResourceUser(user));
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
