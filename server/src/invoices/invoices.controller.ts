import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import type { ActingUser } from '../audit/audit.service';
import { InvoicesService, type InvoiceListPage, type InvoiceListQuery } from './invoices.service';
import { CustomersService } from './customers.service';
import { InvoiceAccessGuard } from './invoice-access.guard';

const actor = (u: AuthUserRecord | undefined): ActingUser | null => (u ? { id: u.id, name: u.name } : null);

/**
 * Every route here requires BOTH the `invoice` screen permission AND a brokerage financial role.
 *
 * The permission alone was not enough: the service applies no ownership or role filter of its own,
 * so `invoice: view` granted through Roles & Permissions — to an agent, to the CRM role, to
 * Documentation — returned the brokerage's entire invoice ledger. `InvoiceAccessGuard` refuses on
 * the role, which is not a dial anybody can turn by accident. See `core/authz.ts`.
 */
@Controller()
@UseGuards(AuthGuard, ScreenGuard, InvoiceAccessGuard)
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly customers: CustomersService,
  ) {}

  // ---- reads (invoice:view) ----
  @Get('invoices')
  @Screen('invoice', 'view')
  index(@Query() query: InvoiceListQuery): Promise<InvoiceListPage> {
    return this.invoices.index(query ?? {});
  }

  @Get('invoices/:invoice')
  @Screen('invoice', 'view')
  show(@Param('invoice', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    return this.invoices.show(id);
  }

  @Get('customers')
  @Screen('invoice', 'view')
  customerIndex(): Promise<Record<string, unknown>[]> {
    return this.customers.index();
  }

  // ---- writes (invoice:edit) ----
  @Post('invoices')
  @Screen('invoice', 'edit')
  @HttpCode(201)
  store(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoices.store(actor(user), body ?? {});
  }

  @Post('transactions/:transaction/invoices')
  @Screen('invoice', 'edit')
  async generate(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) txnId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const out = await this.invoices.generateForTransaction(actor(user), txnId);
    res.status(out.existing ? 200 : 201); // Laravel: existing → 200, created → 201
    return out;
  }

  @Put('invoices/:invoice')
  @Screen('invoice', 'edit')
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoices.update(actor(user), id, body ?? {});
  }

  @Delete('invoices/:invoice')
  @Screen('invoice', 'edit')
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<{ message: string }> {
    return this.invoices.destroy(actor(user), id, (body?.reason ?? null) as string | null);
  }

  @Post('invoices/:invoice/payments')
  @Screen('invoice', 'edit')
  recordPayment(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoices.recordPayment(actor(user), id, body ?? {});
  }

  @Delete('invoices/:invoice/payments/:payment')
  @Screen('invoice', 'edit')
  deletePayment(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Param('payment', ParseIntPipe) paymentId: number): Promise<Record<string, unknown>> {
    return this.invoices.deletePayment(actor(user), id, paymentId);
  }

  /*
   * Both of these take the rendered invoice PDF in the body.
   *
   * The document is produced in the BROWSER (`InvoiceDoc` + `desk/pdf.ts`) because that is where
   * the invoice layout lives — there is no server-side renderer for it. The client has always
   * posted it here; the server accepted the body and threw it away, so the toast promising "PDF
   * attached" was a second untrue statement beside the send itself. It is now attached.
   */
  @Post('invoices/:invoice/reminders')
  @Screen('invoice', 'edit')
  recordReminder(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoices.recordReminder(actor(user), id, pdfAttachment(body));
  }

  @Post('invoices/:invoice/send')
  @Screen('invoice', 'edit')
  send(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoices.send(actor(user), id, pdfAttachment(body));
  }

  @Post('customers')
  @Screen('invoice', 'edit')
  @HttpCode(201)
  customerStore(@Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.customers.store(body ?? {});
  }

  @Put('customers/:customer')
  @Screen('invoice', 'edit')
  customerUpdate(@Param('customer', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.customers.update(id, body ?? {});
  }

  @Delete('customers/:customer')
  @Screen('invoice', 'edit')
  customerDestroy(@Param('customer', ParseIntPipe) id: number): Promise<{ message: string }> {
    return this.customers.destroy(id);
  }
}

/**
 * The invoice PDF off the request body, or null.
 *
 * Defensive because this is a client-supplied blob that will be attached to an outbound email. The
 * caller is already an authenticated brokerage financial user, so this is not an authorization
 * boundary — it is a sanity boundary: a malformed or absurd body must fail the attachment rather
 * than the send, and must never reach a mail server as a 200 MB string.
 *
 * The client posts raw base64 (`desk/pdf.ts` documents "no data: prefix"), but a `data:` URI is
 * accepted and stripped so a future caller cannot break the send by being more helpful.
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function pdfAttachment(body: Record<string, unknown> | undefined): { data: string; name: string; mime: string } | null {
  const raw = typeof body?.pdf === 'string' ? body.pdf : '';
  if (!raw) return null;
  const data = raw.replace(/^data:[^;]*;(?:[^,]*;)?base64,/i, '').trim();
  if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return null;
  // base64 is 4 characters per 3 bytes; compare before decoding so an oversized string is refused
  // rather than materialised.
  if ((data.length * 3) / 4 > MAX_PDF_BYTES) return null;
  const name = typeof body?.filename === 'string' && body.filename.trim() ? body.filename.trim() : 'invoice.pdf';
  return { data, name: name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'invoice.pdf', mime: 'application/pdf' };
}
