import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailModule } from '../email/email.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { CustomersService } from './customers.service';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { TransactionInvoiceService } from './transaction-invoice.service';
import { InvoiceAccessGuard } from './invoice-access.guard';
import { InvoiceReminderService } from './invoice-reminder.service';
import { InvoiceReminderScheduler } from './invoice-reminder.scheduler';

// CommissionService comes from the global CommissionModule (no TransactionsModule import,
// which would create a cycle: transactions store → invoice generation).
@Module({
  // EmailModule exports MailerService: invoice send/reminder deliver before recording.
  imports: [AuthModule, SettingsModule, EmailModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService, CustomersService, InvoiceCalculator, InvoiceNumberService,
    TransactionInvoiceService, InvoiceAccessGuard,
    // The auto-reminder sweep and the timer that wakes it. The timer is inert unless
    // RUN_SCHEDULERS allows it; the sweep itself is callable directly, which is how it is tested.
    InvoiceReminderService, InvoiceReminderScheduler,
  ],
  exports: [TransactionInvoiceService, InvoiceCalculator, InvoiceReminderService],
})
export class InvoicesModule {}
