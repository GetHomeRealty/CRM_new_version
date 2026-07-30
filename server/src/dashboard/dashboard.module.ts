import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { AreaDashboardService } from './area-dashboard.service';
import { DashboardService } from './dashboard.service';

// CommissionService comes from the global CommissionModule.
@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService, AreaDashboardService],
})
export class DashboardModule {}
