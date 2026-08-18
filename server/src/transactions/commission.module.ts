import { Global, Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { PaymentCacheService } from './payment-cache.service';
import { PersonResolver } from '../core/person-resolver.service';

/**
 * Global so both TransactionsModule and InvoicesModule (via TransactionInvoiceService)
 * can inject the commission engine without importing each other — which would create
 * a cycle (transactions store → invoice generation → commission math).
 *
 * `PaymentCacheService` lives here rather than in TransactionsModule for the same reason and one
 * more: it needs the commission engine to resolve a deal's agent names, and it is called from the
 * transaction write path — so putting it anywhere else would recreate exactly the cycle this module
 * exists to avoid.
 */
@Global()
@Module({
  // PersonResolver is provided here too, not only in CoreModule: this module is @Global and is
  // injected in places that never import CoreModule, so relying on that would be a load-order trap.
  providers: [CommissionService, PersonResolver, PaymentCacheService],
  exports: [CommissionService, PersonResolver, PaymentCacheService],
})
export class CommissionModule {}
