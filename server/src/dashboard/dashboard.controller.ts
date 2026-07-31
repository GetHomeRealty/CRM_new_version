import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DashboardService, type DashboardCommissions } from './dashboard.service';
import { AreaDashboardService, type CrmDashboard, type DeskDashboard } from './area-dashboard.service';
import { TransactionReviewService } from '../transactions/transaction-review.service';

@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly areas: AreaDashboardService,
    private readonly reviews_: TransactionReviewService,
  ) {}

  /**
   * The two dashboards are two endpoints, not one endpoint with a flag.
   *
   * Section 10 asks for separate queries, services and APIs — so each reads only its own area's
   * tables. `/crm` never touches transactions, invoices or documents; `/desk` never touches leads,
   * lead tasks or campaigns.
   */
  @Get('crm')
  crm(@CurrentUser() user: AuthUserRecord | undefined): Promise<CrmDashboard> {
    return this.areas.crm(user ?? null);
  }

  @Get('desk')
  desk(@CurrentUser() user: AuthUserRecord | undefined): Promise<DeskDashboard> {
    return this.areas.desk(user ?? null);
  }

  @Get('commissions')
  commissions(@CurrentUser() user: AuthUserRecord | undefined): Promise<DashboardCommissions> {
    return this.dashboard.commissions(user ? { id: user.id, role: user.role, name: user.name } : null);
  }

  /**
   * Review figures for the dashboard widgets — its own endpoint rather than part of `/desk`.
   *
   * The desk dashboard is already the heaviest read in the application; adding five aggregates over
   * a table that grows with every decision would make every visit pay for them, including the
   * visits that never scroll far enough to see them.
   */
  @Get('reviews')
  reviews(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.reviews_.stats(user ?? null);
  }

  /** What keeps going wrong, and how long it takes to put right — the charts and the metrics. */
  @Get('review-errors')
  reviewErrors(
    @CurrentUser() user: AuthUserRecord | undefined,
    /** `YYYY-MM` narrows it to one month; absent means the twelve months ending today. */
    @Query('month') month?: string,
  ): Promise<Record<string, unknown>> {
    return this.reviews_.recurringErrors(user ?? null, { month });
  }
}
