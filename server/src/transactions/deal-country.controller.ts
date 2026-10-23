import { Controller, Get, NotFoundException, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { allowedMarkets, marketOf, type Market } from '../common/market';
import { scopedUser, transactionScopeWhere } from '../common/transaction-scope';

/**
 * "IS THIS DEAL IN MY OTHER COUNTRY?" (23 Oct 2026).
 *
 * A deal page that cannot load its deal used to sit on "Loading..." for ever. It now says "not found",
 * and - when the deal is in the other country - offers the switch. This route answers that one
 * question, and answers it only when the answer would let the person open the deal there:
 *   - they may work in both countries;
 *   - the deal exists, is not deleted, and is in the country they are NOT working in now;
 *   - in that country they could open it (an agent only their own deals, as everywhere else).
 * Anything else is a plain 404, so it never tells anyone that a deal they could not open exists.
 *
 * Its path is deliberately not /api/transactions/:id - the MarketInterceptor refuses those for a deal
 * of the other country, which is exactly the case this route is for.
 */
@Controller('deal-country')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class DealCountryController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async locate(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<{ market: Market }> {
    const notFound = new NotFoundException({ message: 'Transaction not found.' });
    if (!user) throw notFound;
    const mine = allowedMarkets(user.markets);
    const now = marketOf(user);
    const other = mine.filter((m) => m !== now);
    if (!other.length) throw notFound;
    for (const m of other) {
      const scoped = scopedUser({ ...user, market: m });
      const hit = await this.prisma.transactions.findFirst({
        where: { AND: [{ id, deleted_at: null }, transactionScopeWhere(scoped)] },
        select: { id: true },
      });
      if (hit) return { market: m };
    }
    throw notFound;
  }
}
