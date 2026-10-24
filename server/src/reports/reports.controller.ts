import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CompanySettingsService } from '../settings/company-settings.service';
import { ReportsService } from './reports.service';
import { ReportExportService } from './report-export.service';
import { DocumentReminderService, type ReminderRequest, type ReminderScope } from './document-reminder.service';
import type { ReportFilters, ReportQuery } from './report.types';
import { contentDisposition } from '../common/content-disposition';
import { marketOf } from '../common/market';
import { ReportRemarksService, type RemarkField } from './report-remarks.service';

/** Reports API — all endpoints require the `reports` screen (agents are auto-scoped in the service). */
@Controller('reports')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('reports', 'view')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exporter: ReportExportService,
    private readonly settings: CompanySettingsService,
    private readonly reminders: DocumentReminderService,
    private readonly remarks: ReportRemarksService,
  ) {}

  @Get()
  list(): { type: string; name: string; description: string; category: string }[] {
    return this.reports.list();
  }

  /*
   * Pending Payments: the brokerage's own Payment Sheet (payment-sheet.ts). Declared before the
   * `:reportType` routes. Reading what is stored needs only the report; changing it — upload, remove,
   * or downloading the filled template — is Super Admin, Admin or Accounting, checked in the service.
   */
  @Get('pending-payments/sheet')
  paySheetInfo(@CurrentUser() user: AuthUserRecord): Promise<{ count: number; uploaded_at: string | null; uploaded_by: string | null }> {
    return this.reports.paySheetInfo(user);
  }

  @Post('pending-payments/sheet')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadPaySheet(@CurrentUser() user: AuthUserRecord, @UploadedFile() file?: Express.Multer.File): Promise<{ count: number }> {
    return this.reports.uploadPaySheet(user, file?.buffer);
  }

  @Delete('pending-payments/sheet')
  removePaySheet(@CurrentUser() user: AuthUserRecord): Promise<{ count: number }> {
    return this.reports.removePaySheet(user);
  }

  @Get('pending-payments/sheet/template')
  async paySheetTemplate(@CurrentUser() user: AuthUserRecord, @Res() res: Response): Promise<void> {
    const buffer = await this.reports.paySheetTemplate(user);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition('Pay Sheet.xlsx'));
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /**
   * Pending Payments: save a deal's Validation Comments or Accounting Remarks from the report.
   * Declared before the `:reportType` routes; the service decides who may write which field.
   */
  @Put('pending-payments/:transaction/remarks')
  saveRemark(
    @CurrentUser() user: AuthUserRecord,
    @Param('transaction', ParseIntPipe) transaction: number,
    @Body() body: { field?: RemarkField; text?: unknown },
  ): Promise<{ value: string | null }> {
    return this.remarks.save(user, transaction, body?.field as RemarkField, body?.text);
  }

  @Get('filter-options')
  filterOptions(@CurrentUser() user: AuthUserRecord): Promise<Record<string, { value: string; label: string }[]>> {
    return this.reports.filterOptions(user);
  }

  /**
   * What a reminder would do — deals, applicable document count, recipients and duplicate
   * warnings. The UI shows this before anything is sent (nothing is sent by this call).
   */
  @Post('reminders/preview')
  @HttpCode(200)
  previewReminders(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.reminders.preview(parseReminder(body), user);
  }

  /** Send documentation reminders (individual, whole-deal, or bulk across deals). */
  @Post('reminders/send')
  @HttpCode(200)
  sendReminders(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.reminders.send(parseReminder(body), user);
  }

  /** Expand one deal to its individual documents (pending / invalid / valid, kept separate). */
  @Get('documents/:transactionId')
  documents(@CurrentUser() user: AuthUserRecord, @Param('transactionId') id: string): Promise<unknown> {
    return this.reports.documentsFor(Number(id), user);
  }

  @Get(':reportType/columns')
  columns(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string): unknown {
    return taxWords(user, this.reports.meta(type));
  }

  @Post(':reportType/search')
  @HttpCode(200)
  async search(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    return taxWords(user, await this.reports.run(type, user, parseQuery(body)));
  }

  @Post(':reportType/export/xlsx')
  @HttpCode(200)
  async exportXlsx(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const branding = (await this.settings.current()).name;
    const payload = taxWords(user, await this.reports.exportData(type, user, parseQuery(body), branding));
    const buf = await this.exporter.xlsx(payload);
    this.download(res, buf, payload.reportName, this.exporter.fileStamp(payload.generatedAt), 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Post(':reportType/export/pdf')
  @HttpCode(200)
  async exportPdf(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const branding = (await this.settings.current()).name;
    const payload = taxWords(user, await this.reports.exportData(type, user, parseQuery(body), branding));
    const buf = await this.exporter.pdf(payload);
    this.download(res, buf, payload.reportName, this.exporter.fileStamp(payload.generatedAt), 'pdf', 'application/pdf');
  }

  private download(res: Response, buf: Buffer, name: string, stamp: string, ext: string, mime: string): void {
    const file = `${name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '')}_${stamp}.${ext}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', contentDisposition(file));
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
}

/**
 * India's tax is GST (24 Oct 2026): the column headings say "HST" ("Agent HST", "Brokerage HST"), so a
 * person working in India reads GST instead - on the screen and in the Excel / PDF. Only the words; the
 * figures under them are already the deal's own rate. Canada's reply is returned untouched.
 */
function taxWords<T>(user: AuthUserRecord, out: T): T {
  if (marketOf(user) !== 'IN' || !out || typeof out !== 'object') return out;
  const o = out as unknown as { columns?: { label?: string }[] };
  if (!Array.isArray(o.columns)) return out;
  return { ...out, columns: o.columns.map((c) => (typeof c.label === 'string' ? { ...c, label: c.label.replace(/\bHST\b/g, 'GST') } : c)) };
}

// ---- defensive request parsing (validates/coerces the raw body into a ReportQuery) ----
const strArr = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String).filter((s) => s !== '');
  if (typeof v === 'string' && v !== '') return [v];
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const dateOrU = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

function parseFilters(f: Record<string, unknown>): ReportFilters {
  return {
    search: str(f.search),
    deal_type: strArr(f.deal_type),
    agent: strArr(f.agent),
    payment_type: strArr(f.payment_type),
    year: f.year != null && f.year !== '' && Number.isFinite(Number(f.year)) ? Number(f.year) : undefined,
    offer_date_from: dateOrU(f.offer_date_from),
    offer_date_to: dateOrU(f.offer_date_to),
    closing_date_from: dateOrU(f.closing_date_from),
    closing_date_to: dateOrU(f.closing_date_to),
    payout_status: str(f.payout_status),
    reco_ready: f.reco_ready === 'Yes' || f.reco_ready === 'No' ? f.reco_ready : undefined,
    reminder_type: str(f.reminder_type),
    sent_from: dateOrU(f.sent_from), sent_to: dateOrU(f.sent_to),
    status: str(f.status),
    split_ratio: strArr(f.split_ratio),
    sections: strArr(f.sections),
    match_mode: f.match_mode === 'all' ? 'all' : f.match_mode === 'any' ? 'any' : undefined,
    advance_paid_from: dateOrU(f.advance_paid_from), advance_paid_to: dateOrU(f.advance_paid_to),
    cashback_from: dateOrU(f.cashback_from), cashback_to: dateOrU(f.cashback_to),
    referral_from: dateOrU(f.referral_from), referral_to: dateOrU(f.referral_to),
  };
}

/** Reminder request body — ids are coerced to positive integers, scope to a known value. */
function parseReminder(body: Record<string, unknown>): ReminderRequest {
  const ids = (v: unknown): number[] => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const scope = body.scope === 'invalid' ? 'invalid' : body.scope === 'all' ? 'all' : 'pending';
  return {
    transaction_ids: [...new Set(ids(body.transaction_ids))],
    document_ids: [...new Set(ids(body.document_ids))],
    scope: scope as ReminderScope,
    channel: str(body.channel) ?? 'email',
  };
}

function parseQuery(body: Record<string, unknown>): ReportQuery {
  const filters = parseFilters((body.filters && typeof body.filters === 'object' ? body.filters : {}) as Record<string, unknown>);
  const page = Number(body.page); const perPage = Number(body.per_page);
  return {
    filters,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    per_page: Number.isFinite(perPage) && perPage > 0 ? Math.floor(perPage) : undefined,
    sort: str(body.sort),
    dir: body.dir === 'asc' ? 'asc' : body.dir === 'desc' ? 'desc' : undefined,
    columns: strArr(body.columns),
  };
}
