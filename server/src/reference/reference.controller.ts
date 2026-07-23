import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { LISTING_TYPES, TRANSACTION_TYPES } from './transaction.constants';

/** Reference data available to any authenticated user (mirrors the inline route). */
@Controller()
@UseGuards(AuthGuard)
export class ReferenceController {
  @Get('transaction-types')
  transactionTypes(): { types: readonly string[]; listing_types: readonly string[] } {
    return { types: TRANSACTION_TYPES, listing_types: LISTING_TYPES };
  }
}
