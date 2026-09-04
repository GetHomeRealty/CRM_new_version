import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
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
  ) {}

  @Get()
  list(): { type: string; name: string; description: string; category: string }[] {
    return this.reports.list();
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
  columns(@Param('reportType') type: string): unknown {
    return this.reports.meta(type);
  }

  @Post(':reportType/search')
  @HttpCode(200)
  search(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.reports.run(type, user, parseQuery(body));
  }

  @Post(':reportType/export/xlsx')
  @HttpCode(200)
  async exportXlsx(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const branding = (await this.settings.current()).name;
    const payload = await this.reports.exportData(type, user, parseQuery(body), branding);
    const buf = await this.exporter.xlsx(payload);
    this.download(res, buf, payload.reportName, this.exporter.fileStamp(payload.generatedAt), 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Post(':reportType/export/pdf')
  @HttpCode(200)
  async exportPdf(@CurrentUser() user: AuthUserRecord, @Param('reportType') type: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const branding = (await this.settings.current()).name;
    const payload = await this.reports.exportData(type, user, parseQuery(body), branding);
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
