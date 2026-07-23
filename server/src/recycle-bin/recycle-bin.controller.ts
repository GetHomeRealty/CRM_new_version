import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecycleBinService } from './recycle-bin.service';

type Res = Record<string, unknown>;
const u = (x: AuthUserRecord | undefined): AuthUserRecord | null => x ?? null;

// Recycle Bin — Super Admin only (enforced in the service, matching the controller guard).
@Controller('trash')
@UseGuards(AuthGuard)
export class RecycleBinController {
  constructor(private readonly bin: RecycleBinService) {}

  @Get('transactions')
  transactions(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.transactions(u(user)); }
  @Post('transactions/:id/restore')
  @HttpCode(200)
  restoreTransaction(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.restoreTransaction(u(user), id); }
  @Delete('transactions/:id')
  forceDeleteTransaction(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.forceDeleteTransaction(u(user), id); }

  @Get('documents')
  documents(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.documents(u(user)); }
  @Post('documents/:id/restore')
  @HttpCode(200)
  restoreDocument(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.restoreDocument(u(user), id); }
  @Delete('documents/:id')
  forceDeleteDocument(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.forceDeleteDocument(u(user), id); }

  @Get('invoices')
  invoices(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.invoices(u(user)); }
  @Post('invoices/:id/restore')
  @HttpCode(200)
  restoreInvoice(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.restoreInvoice(u(user), id); }
  @Delete('invoices/:id')
  forceDeleteInvoice(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.forceDeleteInvoice(u(user), id); }

  @Get('payments')
  payments(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.payments(u(user)); }
  @Post('payments/:id/restore')
  @HttpCode(200)
  restorePayment(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.restorePayment(u(user), id); }
  @Delete('payments/:id')
  forceDeletePayment(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.forceDeletePayment(u(user), id); }

  @Get('row-items')
  rowItems(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.rowItems(u(user)); }
  @Post('row-items/:id/restore')
  @HttpCode(200)
  restoreRowItem(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.restoreRowItem(u(user), id); }
  @Delete('row-items/:id')
  forceDeleteRowItem(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number): Promise<Res> { return this.bin.forceDeleteRowItem(u(user), id); }

  @Get('deletions')
  deletions(@CurrentUser() user: AuthUserRecord | undefined): Promise<Res> { return this.bin.deletions(u(user)); }
}
