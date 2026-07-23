import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TransactionImportService } from './transaction-import.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Uploads arrive base64-encoded in JSON (same convention the mail attachments use). */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Bulk transaction import. Creating transactions requires the `transactions` edit
 * permission — importing is simply doing that many times, so it is gated identically.
 */
// NOT mounted under /transactions — a bare GET there would be swallowed by the
// TransactionsController's `:transaction` route and return a single transaction instead.
@Controller('transaction-imports')
@UseGuards(AuthGuard, ScreenGuard)
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
