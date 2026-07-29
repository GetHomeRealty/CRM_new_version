import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TransactionsService, type TransactionListResult } from './transactions.service';
import { TransactionsWriteService } from './transactions-write.service';
import type { ResourceUser } from './transaction.resource';
import { ListTransactionsDto } from './dto/list-transactions.dto';

const toResourceUser = (u: AuthUserRecord | undefined): ResourceUser | null =>
  u ? { id: u.id, role: u.role, name: u.name } : null;

@Controller('transactions')
@UseGuards(AuthGuard)
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly write: TransactionsWriteService,
  ) {}

  @Post()
  @HttpCode(201)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  store(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.store(user ?? null, body ?? {});
  }

  @Put(':transaction')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  update(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.update(user ?? null, id, body ?? {});
  }

  @Delete(':transaction')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  destroy(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    return this.write.destroy(user ?? null, id);
  }

  @Post(':transaction/review-agent-changes')
  @HttpCode(200)
  review(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.reviewAgentChanges(user ?? null, id);
  }

  @Post(':transaction/reject-agent-change')
  @HttpCode(200)
  rejectAgentChange(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.rejectAgentChange(user ?? null, id, Number(body?.audit_id));
  }

  @Get()
  index(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Query() query: ListTransactionsDto,
  ): Promise<TransactionListResult> {
    return this.transactions.index(toResourceUser(user), query);
  }

  @Get(':transaction')
  show(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.transactions.show(toResourceUser(user), id);
  }
}
