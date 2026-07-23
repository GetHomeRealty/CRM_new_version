import { Global, Module } from '@nestjs/common';
import { CommissionService } from './commission.service';

/**
 * Global so both TransactionsModule and InvoicesModule (via TransactionInvoiceService)
 * can inject the commission engine without importing each other — which would create
 * a cycle (transactions store → invoice generation → commission math).
 */
@Global()
@Module({
  providers: [CommissionService],
  exports: [CommissionService],
})
export class CommissionModule {}
