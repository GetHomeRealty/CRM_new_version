import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DashboardService, type DashboardCommissions } from './dashboard.service';
import { AreaDashboardService, type CrmDashboard, type DeskDashboard } from './area-dashboard.service';

@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly areas: AreaDashboardService,
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
}
