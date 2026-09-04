import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { BulkExportService, type BulkSelection, type DocFilter } from './bulk-export.service';
import { contentDisposition } from '../common/content-disposition';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Bulk transaction data export and document ZIP download.
 * Gated on `transactions` view — the service additionally scopes agents to their own deals,
 * so a selection can never reach a transaction the user isn't entitled to.
 */
@Controller('transactions/bulk')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class BulkExportController {
  constructor(private readonly bulk: BulkExportService) {}

  /** Confirmation summary — what will be exported, before anything is generated. */
  @Post('summary')
  @HttpCode(200)
  summary(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.bulk.summary(parseSelection(body), user);
  }

  /** Complete structured transaction data (documents as metadata only, never the files). */
  @Post('export/xlsx')
  @HttpCode(200)
  async xlsx(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const buf = await this.bulk.dataXlsx(parseSelection(body), user);
    this.send(res, buf, `Transaction_Data_${stamp()}.xlsx`, XLSX_MIME);
  }

  /**
   * EVERYTHING on one row per transaction — Basic Info, team split, clients, lawyer,
   * co-op brokerage, financial, adjustments, conditions and the calculated columns.
   */
  @Post('export/complete/xlsx')
  @HttpCode(200)
  async completeXlsx(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const buf = await this.bulk.completeXlsx(parseSelection(body), user);
    this.send(res, buf, `All_Transactions_${stamp()}.xlsx`, XLSX_MIME);
  }

  @Post('export/complete/csv')
  @HttpCode(200)
  async completeCsv(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const buf = await this.bulk.completeCsv(parseSelection(body), user);
    this.send(res, buf, `All_Transactions_${stamp()}.csv`, 'text/csv; charset=utf-8');
  }

  /** The same data flattened to a single CSV table (one row per transaction). */
  @Post('export/csv')
  @HttpCode(200)
  async csv(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const buf = await this.bulk.dataCsv(parseSelection(body), user);
    this.send(res, buf, `Transaction_Data_${stamp()}.csv`, 'text/csv; charset=utf-8');
  }

  /**
   * PDF export. `mode: 'zip'` produces one PDF per transaction packaged in a ZIP; the
   * default produces a single consolidated PDF with each transaction on its own page.
   */
  @Post('export/pdf')
  @HttpCode(200)
  async pdf(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const sel = parseSelection(body);
    if (body.mode === 'zip') return this.bulk.dataPdfZip(sel, user, res);
    const buf = await this.bulk.dataPdf(sel, user);
    this.send(res, buf, `Transaction_Data_${stamp()}.pdf`, 'application/pdf');
  }

  /** ZIP of the actual uploaded documents, organised per transaction and category. */
  @Post('documents/zip')
  @HttpCode(200)
  documentsZip(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    return this.bulk.documentsZip(parseSelection(body), user, res);
  }

  private send(res: Response, buf: Buffer, name: string, mime: string): void {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', contentDisposition(name));
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
}

const stamp = (): string => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((s) => s !== '') : []);
const dateOrU = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const DOC_FILTERS = ['all', 'pending', 'invalid', 'valid', 'mandatory'];

/** Shared with the Export Centre so a queued job parses its selection identically. */
export function parseSelection(body: Record<string, unknown>): BulkSelection {
  const ids = (Array.isArray(body.transaction_ids) ? body.transaction_ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const f = (body.filters && typeof body.filters === 'object' ? body.filters : {}) as Record<string, unknown>;
  return {
    transaction_ids: [...new Set(ids)],
    all_matching: body.all_matching === true,
    filters: {
      search: typeof f.search === 'string' && f.search !== '' ? f.search : undefined,
      deal_type: strArr(f.deal_type),
      agent: strArr(f.agent),
      payment_type: strArr(f.payment_type),
      year: f.year != null && f.year !== '' && Number.isFinite(Number(f.year)) ? Number(f.year) : undefined,
      offer_date_from: dateOrU(f.offer_date_from), offer_date_to: dateOrU(f.offer_date_to),
      closing_date_from: dateOrU(f.closing_date_from), closing_date_to: dateOrU(f.closing_date_to),
    },
    documents: DOC_FILTERS.includes(String(body.documents)) ? (body.documents as DocFilter) : 'all',
    categories: strArr(body.categories),
    uploaded_from: dateOrU(body.uploaded_from),
    uploaded_to: dateOrU(body.uploaded_to),
  };
}
