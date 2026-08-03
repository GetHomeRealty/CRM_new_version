import { Global, Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * Global so both TransactionsModule and InvoicesModule (via TransactionInvoiceService)
 * can inject the commission engine without importing each other — which would create
 * a cycle (transactions store → invoice generation → commission math).
 */
@Global()
@Module({
  // PersonResolver is provided here too, not only in CoreModule: this module is @Global and is
  // injected in places that never import CoreModule, so relying on that would be a load-order trap.
  providers: [CommissionService, PersonResolver],
  exports: [CommissionService, PersonResolver],
})
export class CommissionModule {}
