import { Controller, Get, NotFoundException, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { scopedUser, transactionScopeWhere } from '../common/transaction-scope';
import { InvoicesService } from './invoices.service';
import { TransactionInvoiceService } from './transaction-invoice.service';

/**
 * THE INDIA INVOICE PREVIEW (Sai, 24 Oct 2026: "use the india template for the preview").
 *
 * The deal page's Invoice button shows a preview when the deal has no invoice yet and the person may
 * not create one (an agent). Canada's preview is drawn on the page from the deal's own figures; an
 * India deal's needs our India company, office, bank and the builder - so it is worked out here, the
 * way Create Term Invoices would, and drawn in the India template. Read-only: nothing is saved and no
 * invoice number is taken.
 *
 * Same door as the deal itself: Transactions view, and only a deal the person could open (an agent
 * their own). Its path is under /api/transactions/:id, so the country check refuses an India deal to
 * someone working in Canada, as for the deal page.
 */
@Controller('transactions')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class IndiaInvoicePreviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txInvoices: TransactionInvoiceService,
    private readonly invoices: InvoicesService,
  ) {}

  @Get(':transaction/invoice-preview')
  async preview(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) id: number): Promise<{ data: Record<string, unknown>[] }> {
    const visible = user
      ? await this.prisma.transactions.findFirst({ where: { AND: [{ id, deleted_at: null }, transactionScopeWhere(scopedUser(user))] }, select: { id: true } })
      : null;
    if (!visible) throw new NotFoundException({ message: 'Transaction not found.' });
    const pages = await this.txInvoices.previewIndia(this.prisma as never, id);
    const data: Record<string, unknown>[] = [];
    for (const p of pages) {
      const india = await this.invoices.indiaBlock({ tax_total: p.invoice.tax_total as number, transactions: p.deal });
      data.push({ ...p.invoice, india });
    }
    return { data };
  }
}
