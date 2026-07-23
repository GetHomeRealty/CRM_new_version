import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailModule } from '../email/email.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { ReportsController } from './reports.controller';
import { TransactionImportController } from './transaction-import.controller';
import { TransactionImportService } from './transaction-import.service';
import { BulkExportController } from './bulk-export.controller';
import { BulkExportService } from './bulk-export.service';
import { ExportCentreController } from './export-centre.controller';
import { ExportJobService } from './export-job.service';
import { ReportsService } from './reports.service';
import { ReportDataService } from './report-data.service';
import { ReportExportService } from './report-export.service';
import { DocumentReminderService } from './document-reminder.service';

// CommissionService is provided by the global CommissionModule (already imported in AppModule).
@Module({
  imports: [AuthModule, SettingsModule, EmailModule, TransactionsModule],
  controllers: [ReportsController, TransactionImportController, BulkExportController, ExportCentreController],
  providers: [ReportsService, ReportDataService, ReportExportService, DocumentReminderService, TransactionImportService, BulkExportService, ExportJobService],
})
export class ReportsModule {}
