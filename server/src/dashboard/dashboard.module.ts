import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { AreaDashboardService } from './area-dashboard.service';
import { DashboardService } from './dashboard.service';
import { TransactionsModule } from '../transactions/transactions.module';

// CommissionService comes from the global CommissionModule.
@Module({
  // TransactionsModule exports TransactionReviewService, which owns the review figures.
  imports: [AuthModule, TransactionsModule],
  controllers: [DashboardController],
  providers: [DashboardService, AreaDashboardService],
})
export class DashboardModule {}
