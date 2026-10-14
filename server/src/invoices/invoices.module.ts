import { MobileInvoiceReminderScheduler } from './mobile-invoice-reminder-scheduler';
import { MobileInvoicesService } from './mobile-invoices.service';
import { MobileInvoiceMailService } from './mobile-invoice-mail.service';
import { MobileInvoicesController } from './mobile-invoices.controller';
import { EmailModule } from '../email/email.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { CustomersService } from './customers.service';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { TransactionInvoiceService } from './transaction-invoice.service';

// CommissionService comes from the global CommissionModule (no TransactionsModule import,
// which would create a cycle: transactions store → invoice generation).
@Module({
  imports: [AuthModule, SettingsModule, EmailModule],
  controllers: [InvoicesController, MobileInvoicesController],
  providers: [MobileInvoiceReminderScheduler, MobileInvoicesService, MobileInvoiceMailService, InvoicesService, CustomersService, InvoiceCalculator, InvoiceNumberService, TransactionInvoiceService],
  exports: [TransactionInvoiceService, InvoiceCalculator],
})
export class InvoicesModule {}
