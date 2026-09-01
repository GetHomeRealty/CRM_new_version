import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TransactionImportService } from './transaction-import.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Uploads arrive base64-encoded in JSON (same convention the mail attachments use). */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Bulk transaction import — SUPER ADMIN ONLY (TD-103).
 *
 * This comment used to say that importing is creating transactions many times, so it is gated
 * identically on `transactions: edit`. That was never quite what the code did — the service already
 * singled out agents and refused them — and it is not the intent the product documents: TD-057 and
 * TD-103 both record bulk import as Super Admin work.
 *
 * Under the old rule FOUR roles could run a real import, because `transactions: edit` is held by
 * admin, manager, agent, accounting and documentation. Agents were refused in the service; nobody
 * else was. Accounting — a billing seat — could create transactions in bulk, and the three read
 * routes answered 200 to it: the history names who uploaded what and when, and `template`/`sample`
 * took no user at all, so nothing could have refused them.
 *
 * `AdminGuard` is the fix because it covers EVERY route on the controller, including those two that
 * have no `@CurrentUser()` to check, and it answers with the same 'Administrator access required.'
 * that `/api/users` already gives this role. `ScreenGuard` is kept in front of it rather than
 * replaced: a seat with no transactions access at all should be turned away by the module gate, not
 * by the tier gate.
 */
// NOT mounted under /transactions — a bare GET there would be swallowed by the
// TransactionsController's `:transaction` route and return a single transaction instead.
@Controller('transaction-imports')
@UseGuards(AuthGuard, ScreenGuard, AdminGuard)
@Screen('transactions', 'edit')
export class TransactionImportController {
  constructor(private readonly imports: TransactionImportService) {}

  /** Download the import template (data sheet + instructions + valid-status reference). */
  @Get('template')
  async template(@Res() res: Response): Promise<void> {
    const buf = await this.imports.template();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="transaction-import-template.xlsx"');
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  /** Download a filled example — the same sheets as the template, with four worked deals. */
  @Get('sample')
  async sample(@Res() res: Response): Promise<void> {
    const buf = await this.imports.sample();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="transaction-import-sample.xlsx"');
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  /** Validate an uploaded file. Nothing is created — this only reports what would happen. */
  @Post('validate')
  @HttpCode(200)
  validate(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    const fileName = String(body.file_name ?? '').trim();
    const content = String(body.content ?? '');
    if (!fileName) throw new BadRequestException({ message: 'file_name is required.' });
    if (!content) throw new BadRequestException({ message: 'No file content was uploaded.' });

    // strip an optional data: URI prefix, then guard the decoded size
    const base64 = content.includes(',') && content.slice(0, 64).includes('base64') ? content.slice(content.indexOf(',') + 1) : content;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new BadRequestException({ message: 'The uploaded file is empty or not valid base64.' });
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({ message: `The file is ${(buffer.length / 1048576).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1048576} MB.` });
    }
    return this.imports.validate(fileName, buffer, user);
  }

  /** Create the rows that passed validation (invalid rows are skipped, never blocking). */
  @Post(':batchId/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUserRecord, @Param('batchId') batchId: string): Promise<unknown> {
    return this.imports.confirm(batchId, user);
  }

  /** Downloadable validation report: row, field, invalid value, error, suggested correction. */
  @Get(':batchId/errors')
  async errors(@CurrentUser() user: AuthUserRecord, @Param('batchId') batchId: string, @Res() res: Response): Promise<void> {
    const { buffer, fileName } = await this.imports.errorReport(batchId, user);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /** Bulk import history. */
  @Get()
  history(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.imports.history(user, Number(limit) || 50);
  }
}
