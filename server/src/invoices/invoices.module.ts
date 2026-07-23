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
  imports: [AuthModule, SettingsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, CustomersService, InvoiceCalculator, InvoiceNumberService, TransactionInvoiceService],
  exports: [TransactionInvoiceService, InvoiceCalculator],
})
export class InvoicesModule {}
