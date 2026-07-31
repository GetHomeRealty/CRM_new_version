import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { EmailModule } from '../email/email.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransactionsWriteService } from './transactions-write.service';
import { TradeNumberService } from './trade-number.service';
import { TransactionLawyerReminderService } from './transaction-lawyer-reminder.service';
import { LawyerReminderSchedulerService } from './lawyer-reminder-scheduler.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { TransactionReviewService } from './transaction-review.service';
import { ReviewSlaService } from './review-sla.service';
import { ReviewSlaSchedulerService } from './review-sla-scheduler.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  // SettingsModule exports CompanySettingsService, which the review email needs for the brand name.
  imports: [AuthModule, InvoicesModule, EmailModule, SettingsModule], // EmailModule exports MailerService (lawyer reminders)
  controllers: [TransactionsController, MessagesController],
  providers: [TransactionsService, TransactionsWriteService, MessagesService, TradeNumberService, TransactionLawyerReminderService, LawyerReminderSchedulerService, TransactionReviewService, ReviewSlaService, ReviewSlaSchedulerService],
  // the bulk importer creates transactions through the same write path as the UI;
  // the review service is exported so the agent's notification bell can read from it.
  exports: [TransactionsWriteService, TransactionReviewService],
})
export class TransactionsModule {}
