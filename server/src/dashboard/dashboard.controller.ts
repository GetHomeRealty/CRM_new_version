import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DashboardService, type DashboardCommissions } from './dashboard.service';

@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('commissions')
  commissions(@CurrentUser() user: AuthUserRecord | undefined): Promise<DashboardCommissions> {
    return this.dashboard.commissions(user ? { id: user.id, role: user.role, name: user.name } : null);
  }
}
