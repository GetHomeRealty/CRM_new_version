import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { AreaDashboardService } from './area-dashboard.service';
import { DeskAnalyticsService } from './desk-analytics.service';
import { DashboardService } from './dashboard.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { SettingsModule } from '../settings/settings.module';
import { DeskAnalyticsExportService } from './desk-analytics-export.service';
import { ReportExportService } from '../reports/report-export.service';
import { TeamStructureService } from './team-structure.service';
import { TeamLeadLeadsService } from './team-lead-leads.service';
import { LeadAssignmentHistoryService } from '../leads/lead-assignment-history.service';
import { LeadAuditService } from '../leads/lead-audit.service';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';

// CommissionService comes from the global CommissionModule.
@Module({
  // TransactionsModule exports TransactionReviewService, which owns the review figures.
  // SettingsModule for the brokerage name the exported workbook is branded with.
  // NotificationDispatcherModule for the "lead assigned to you" notification the Team Lead's assignment sends.
  imports: [AuthModule, TransactionsModule, SettingsModule, NotificationDispatcherModule],
  controllers: [DashboardController],
  /*
   * `ReportExportService` is provided here rather than imported from `ReportsModule`.
   *
   * It is a stateless renderer with no injected dependencies, and `ReportsModule` does not export
   * it. Exporting it would make Reports part of the Dashboard's dependency graph for the sake of a
   * formatting class — and the Analytics export deliberately reuses the RENDERER, not the reports
   * engine. A second instance of a class holding no state costs nothing.
   */
  providers: [DashboardService, AreaDashboardService, DeskAnalyticsService, DeskAnalyticsExportService, ReportExportService, TeamStructureService,
    // The Team Lead's lead assignment reuses the Leads module's own history and audit writers. Both
    // are stateless and need only Prisma, and LeadsModule does not export them — the same reasoning
    // as ReportExportService above.
    TeamLeadLeadsService, LeadAssignmentHistoryService, LeadAuditService],
})
export class DashboardModule {}
