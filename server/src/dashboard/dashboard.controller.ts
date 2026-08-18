import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import { ScreenGuard } from '../auth/guards/screen.guard';
import type { AuthUserRecord } from '../auth/auth.types';
import { DashboardService, type DashboardCommissions } from './dashboard.service';
import { AreaDashboardService, type CrmDashboard, type DeskDashboard } from './area-dashboard.service';
import { DeskAnalyticsService, type DeskAnalytics } from './desk-analytics.service';
import { parseAnalyticsFilters, ALL_STATUSES } from './desk-analytics.filters';
import { DeskAnalyticsExportService } from './desk-analytics-export.service';
import { TRANSACTION_TYPES } from '../reference/transaction.constants';
import { TransactionReviewService } from '../transactions/transaction-review.service';

/**
 * Every route here is behind `ScreenGuard` as well as `AuthGuard`.
 *
 * It was authentication only, which meant the `dashboard` screen permission was enforced in the
 * browser and nowhere else: a user whose permission was set to `none` saw an empty page and could
 * still read the whole payload from the console. The `/crm` and `/desk` routes additionally name
 * their area, because Dashboard is a `common` screen and without that the module check has nothing
 * to test — a user assigned only the Transaction Desk could read the CRM's figures.
 */
@Controller('dashboard')
@UseGuards(AuthGuard, ScreenGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly areas: AreaDashboardService,
    private readonly analytics: DeskAnalyticsService,
    private readonly analyticsExport: DeskAnalyticsExportService,
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
  @Screen('dashboard', 'view', 'crm')
  crm(@CurrentUser() user: AuthUserRecord | undefined): Promise<CrmDashboard> {
    return this.areas.crm(user ?? null);
  }

  @Get('desk')
  @Screen('dashboard', 'view', 'desk')
  desk(@CurrentUser() user: AuthUserRecord | undefined): Promise<DeskDashboard> {
    return this.areas.desk(user ?? null);
  }

  /**
   * The Transaction Desk Analytics screen's figures.
   *
   * Its own endpoint under the `analytics` screen permission rather than part of `/desk`: the two
   * screens are separately permissioned, and the dashboard should not pay for an aggregate nobody
   * looking at it asked for. The screen used to derive these in the browser from the whole
   * transaction list — see `DeskAnalyticsService`.
   */
  @Get('analytics')
  @Screen('analytics', 'view', 'desk')
  deskAnalytics(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Query() query: Record<string, unknown>,
  ): Promise<DeskAnalytics> {
    /*
     * The filters are parsed and AUTHORIZED here, then applied in SQL.
     *
     * `parseAnalyticsFilters` refuses an unknown type, an unknown status, a malformed or inverted
     * date range, and an agent asking for anybody but themselves. Nothing reaches the aggregate
     * unchecked, and nothing is silently dropped — a filter that cannot be honoured is a 400 rather
     * than a quietly wider answer.
     */
    return this.analytics.summary(user ?? null, parseAnalyticsFilters(query ?? {}, user ?? null));
  }

  /**
   * The values the Analytics filter controls offer.
   *
   * The agent list is the one place the selector could leak a roster, so it answers with the
   * caller's own single entry when they are an agent — the same rule the Reports module applies —
   * rather than the brokerage's list with the control hidden in the browser.
   */
  @Get('analytics/filter-options')
  @Screen('analytics', 'view', 'desk')
  async deskAnalyticsOptions(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.analytics.filterOptions(user ?? null, [...TRANSACTION_TYPES], ALL_STATUSES);
  }

  /**
   * The CURRENT filtered Analytics result, as a spreadsheet.
   *
   * POST, like the Reports exports, because the filters travel in the body rather than a query
   * string that has to be re-encoded. Same guard, same filter parsing and the same authorization as
   * the screen it exports: an agent's export is their own figures, and asking for another agent's is
   * refused before anything is generated.
   */
  @Post('analytics/export/xlsx')
  @Screen('analytics', 'view', 'desk')
  async deskAnalyticsXlsx(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const filters = parseAnalyticsFilters(body ?? {}, user ?? null);
    const { buffer, filename } = await this.analyticsExport.xlsx(user ?? null, filters);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Get('commissions')
  @Screen('dashboard', 'view')
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
  @Screen('dashboard', 'view')
  reviews(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.reviews_.stats(user ?? null);
  }

  /** What keeps going wrong, and how long it takes to put right — the charts and the metrics. */
  @Get('review-errors')
  @Screen('dashboard', 'view')
  reviewErrors(
    @CurrentUser() user: AuthUserRecord | undefined,
    /** `YYYY-MM` narrows it to one month; absent means the twelve months ending today. */
    @Query('month') month?: string,
  ): Promise<Record<string, unknown>> {
    return this.reviews_.recurringErrors(user ?? null, { month });
  }
}
