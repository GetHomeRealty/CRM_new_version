import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TransactionsService, type TransactionListResult } from './transactions.service';
import { TransactionsWriteService } from './transactions-write.service';
import { TransactionReviewService, type ReviewFilters } from './transaction-review.service';
import { ReviewThreadService, type PostedAttachment } from './review-thread.service';
import { ReviewExportService } from './review-export.service';
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
    private readonly thread: ReviewThreadService,
    private readonly reviewExport: ReviewExportService,
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

  /** What is still unresolved on a deal — read before closing it. */
  @Get(':transaction/reviews/open')
  openReviews(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.reviewService.openSummary(user ?? null, id);
  }

  /**
   * Reject several changes under one reason, or approve several corrections at once.
   * `action` is 'reject' or 'approve'.
   */
  @Post(':transaction/reviews/bulk')
  @HttpCode(200)
  bulkReviews(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
    const text = String(body?.reason ?? body?.note ?? '');
    return String(body?.action) === 'approve'
      ? this.reviewService.bulkResolve(user ?? null, id, ids, text).then((r) => ({ ...r }))
      : this.reviewService.bulkReject(user ?? null, ids, text, async (auditId, reason) => {
        await this.write.rejectAgentChange(user ?? null, id, auditId, reason);
      }).then((r) => ({ ...r }));
  }

  /** The review history as a spreadsheet or a document, honouring the screen's filters. */
  @Get(':transaction/reviews/export.:ext')
  async exportReviews(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Param('ext') ext: string,
    @Query() query: ReviewFilters,
    @Res() res: Response,
  ): Promise<void> {
    const wantsPdf = String(ext).toLowerCase() === 'pdf';
    const file = wantsPdf
      ? await this.reviewExport.pdf(user ?? null, id, query ?? {})
      : await this.reviewExport.xlsx(user ?? null, id, query ?? {});
    res.setHeader('Content-Type', wantsPdf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.end(file.buffer);
  }

  /** The conversation on one review item — readable by the office and the deal's agent. */
  @Get('reviews/:review/messages')
  reviewMessages(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('review', ParseIntPipe) reviewId: number,
  ): Promise<Record<string, unknown>[]> {
    return this.thread.list(user ?? null, reviewId);
  }

  @Post('reviews/:review/messages')
  @HttpCode(200)
  postReviewMessage(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('review', ParseIntPipe) reviewId: number,
    @Body() body: { body?: string; attachments?: PostedAttachment[] },
  ): Promise<Record<string, unknown>[]> {
    return this.thread.post(user ?? null, reviewId, String(body?.body ?? ''), body?.attachments ?? []);
  }

  /** One attached file. Always downloaded — a stored file must not execute in this origin. */
  @Get('reviews/attachments/:attachment')
  async reviewAttachment(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('attachment', ParseIntPipe) attachmentId: number,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.thread.attachment(user ?? null, attachmentId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    res.end(file.data);
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
