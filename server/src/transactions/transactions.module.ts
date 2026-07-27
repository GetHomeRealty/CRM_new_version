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

@Module({
  imports: [AuthModule, InvoicesModule, EmailModule], // EmailModule exports MailerService (lawyer reminders)
  controllers: [TransactionsController, MessagesController],
  providers: [TransactionsService, TransactionsWriteService, MessagesService, TradeNumberService, TransactionLawyerReminderService, LawyerReminderSchedulerService],
  // the bulk importer creates transactions through the same write path as the UI
  exports: [TransactionsWriteService],
})
export class TransactionsModule {}
