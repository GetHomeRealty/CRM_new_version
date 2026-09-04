import { AreaGuard } from '../core/area.guard';
import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { Screen } from '../auth/decorators';
import { AuditLogService, type AuditLogQuery } from './audit-log.service';
import { AuditExportService, type ExportFormat } from './audit-export.service';
import type { Response } from 'express';
import { contentDisposition } from '../common/content-disposition';

@Controller('audit-logs')
@UseGuards(AuthGuard, ScreenGuard, AreaGuard)
export class AuditLogController {
  constructor(
    private readonly auditLogs: AuditLogService,
    private readonly exports: AuditExportService,
  ) {}

  /**
   * One area's audit trail — anyone with the Audit Trail screen (Super Admin always; Admin by
   * default). The area arrives in the query string, so `/crm/audit` and `/desk/audit` each load
   * their own trail and a direct link to either works.
   *
   * The screen permission is unchanged: splitting the trail in two does not widen who can read it.
   */
  @Get()
  @Screen('audit', 'view')
  index(@Query() query: AuditLogQuery): Promise<Record<string, unknown>> {
    return this.auditLogs.index(query ?? {});
  }

  /**
   * The same trail, as a file.
   *
   * AUTHORIZATION IS IDENTICAL TO THE LISTING and comes from the same three guards plus the same
   * `@Screen('audit', 'view')` — this endpoint cannot be reached by anybody who could not already
   * read the rows on screen. Nothing about the export widens who may see what; hiding the button
   * would not have been enough, and the button is not what stops anyone.
   *
   * The area, domain and every filter arrive in the query string exactly as they do for the
   * listing, and are handed to the same `buildWhere`. A CRM export therefore cannot contain a
   * Transaction Desk row, and the brokerage filter is applied by the Prisma extension to every
   * query in the application — a company id from the browser is never consulted.
   *
   * `@Res({ passthrough: false })` because this writes a binary body with its own headers rather
   * than returning JSON.
   */
  @Get('export')
  @Screen('audit', 'view')
  @Header('Cache-Control', 'no-store')
  async export(
    @Query() query: AuditLogQuery & { format?: string },
    @Res() res: Response,
  ): Promise<void> {
    const format: ExportFormat = String(query.format ?? 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    const file = await this.exports.export(query ?? {}, format);

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    res.setHeader('Content-Length', String(file.body.length));
    // Read by the client so it can tell somebody their export was cut short, rather than handing
    // them a file that looks complete.
    res.setHeader('X-Export-Rows', String(file.rows));
    res.setHeader('X-Export-Truncated', file.truncated ? '1' : '0');
    // Both are custom headers, so they must be exposed or the browser will not let JS read them.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Export-Truncated');
    res.status(200).send(file.body);
  }
}
