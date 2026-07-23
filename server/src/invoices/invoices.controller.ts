import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import type { ActingUser } from '../audit/audit.service';
import { InvoicesService } from './invoices.service';
import { CustomersService } from './customers.service';

const actor = (u: AuthUserRecord | undefined): ActingUser | null => (u ? { id: u.id, name: u.name } : null);

@Controller()
@UseGuards(AuthGuard, ScreenGuard)
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly customers: CustomersService,
  ) {}

  // ---- reads (invoice:view) ----
  @Get('invoices')
  @Screen('invoice', 'view')
  index(): Promise<Record<string, unknown>[]> {
    return this.invoices.index();
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

  @Post('invoices/:invoice/reminders')
  @Screen('invoice', 'edit')
  recordReminder(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    return this.invoices.recordReminder(actor(user), id);
  }

  @Post('invoices/:invoice/send')
  @Screen('invoice', 'edit')
  send(@CurrentUser() user: AuthUserRecord | undefined, @Param('invoice', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    return this.invoices.send(actor(user), id);
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
