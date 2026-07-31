import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TransactionsService, type TransactionListResult } from './transactions.service';
import { TransactionsWriteService } from './transactions-write.service';
import { TransactionReviewService, type ReviewFilters } from './transaction-review.service';
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
    private readonly reviewService: TransactionReviewService,
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

  /** `note` is optional — a line saying what was checked, kept with the review record. */
  @Post(':transaction/review-agent-changes')
  @HttpCode(200)
  review(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.reviewAgentChanges(user ?? null, id, body?.note === undefined ? null : String(body.note));
  }

  /** `reason` is required — the service refuses a rejection without one. */
  @Post(':transaction/reject-agent-change')
  @HttpCode(200)
  rejectAgentChange(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> }> {
    return this.write.rejectAgentChange(user ?? null, id, Number(body?.audit_id), String(body?.reason ?? ''));
  }

  /**
   * One deal's review history — its own endpoint, so the transaction screen is not made heavier by
   * a list that only grows. Readable by the office and by the agent whose deal it is.
   */
  @Get(':transaction/reviews')
  reviews(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Query() query: ReviewFilters,
  ): Promise<Record<string, unknown>> {
    return this.reviewService.list(user ?? null, id, query ?? {});
  }

  /** Opening the deal clears the agent's review notifications for it. */
  @Post(':transaction/reviews/seen')
  @HttpCode(200)
  reviewsSeen(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    return this.reviewService.markSeen(toResourceUser(user), id);
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
