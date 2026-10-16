import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { marketOf } from './market';

/**
 * ONE DEAL, ONE COUNTRY - checked once, in front of every route that names a deal (India desk,
 * 16 Oct 2026).
 *
 * The lists are narrowed in `transactionScopeWhere`. A single deal is reached by its number in the
 * URL - /api/transactions/812, its documents, invoices, messages, notice of sale, reviews and about
 * forty more - and each of those handlers loads the deal itself. Rather than teach forty handlers
 * about countries, this asks the question once, before any of them runs: does the deal named in
 * this URL (or the deal behind the invoice, payment, request or bin row it names) belong to the
 * country this request works in? If not, the answer is the same 404 a deal that does not exist
 * gets, so its number is no way to learn it is there.
 *
 * It runs after the guards, so `req.authUser.market` is already set (see AuthGuard). A request with
 * no signed-in user is left to the guards that refused it. A URL naming none of these passes
 * untouched, which is every route that existed before this.
 */
type Lookup = (prisma: PrismaService, id: number) => Promise<string | null | undefined>;

const deal: Lookup = async (p, id) => (await p.transactions.findUnique({ where: { id }, select: { market: true } }))?.market;
/** A manual invoice has no deal; it is Canada's, as every invoice was before. */
const invoice: Lookup = async (p, id) => {
  const i = await p.invoices.findUnique({ where: { id }, select: { transaction_id: true, transactions: { select: { market: true } } } });
  return i ? (i.transactions?.market ?? 'CA') : undefined;
};

const ROUTES: [RegExp, Lookup][] = [
  [/\/api\/transactions\/(\d+)(?:\/|$)/, deal], // /transactions/:id/... and /transactions/:transaction/...
  [/\/api\/documents\/(\d+)(?:\/|$)/, deal], // documents/:transactionId
  [/\/api\/pending-payments\/(\d+)\/remarks(?:\/|$)/, deal],
  [/\/api\/trash\/transactions\/(\d+)(?:\/|$)/, deal],
  [/\/api\/(?:trash\/)?invoices\/(\d+)(?:\/|$)/, invoice],
  [/\/api\/trash\/documents\/(\d+)(?:\/|$)/, async (p, id) => (await p.documents.findUnique({ where: { id }, select: { transactions: { select: { market: true } } } }))?.transactions.market],
  [/\/api\/trash\/payments\/(\d+)(?:\/|$)/, async (p, id) => {
    const pay = await p.invoice_payments.findUnique({ where: { id }, select: { invoice_id: true } });
    return pay ? invoice(p, pay.invoice_id) : undefined;
  }],
  [/\/api\/trash\/row-items\/(\d+)(?:\/|$)/, async (p, id) => (await p.trashed_row_items.findUnique({ where: { id }, select: { transactions: { select: { market: true } } } }))?.transactions.market],
  [/\/api\/edit-requests\/(\d+)(?:\/|$)/, async (p, id) => (await p.transaction_edit_requests.findUnique({ where: { id }, select: { transactions: { select: { market: true } } } }))?.transactions.market],
  [/\/api\/delete-requests\/(\d+)(?:\/|$)/, async (p, id) => (await p.transaction_delete_requests.findUnique({ where: { id }, select: { transactions: { select: { market: true } } } }))?.transactions.market],
];

@Injectable()
export class MarketInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.authUser;
    if (!user) return next.handle();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];

    for (const [re, lookup] of ROUTES) {
      const m = re.exec(path);
      if (!m) continue;
      const dealMarket = await lookup(this.prisma, Number(m[1]));
      // Not found at all: the handler gives its own 404, exactly as before.
      if (dealMarket != null && marketOf({ market: dealMarket }) !== marketOf(user)) {
        throw new NotFoundException({ message: 'No query results for model [App\\Models\\Transaction].' });
      }
      break;
    }
    return next.handle();
  }
}
