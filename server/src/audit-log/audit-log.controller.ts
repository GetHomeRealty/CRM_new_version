import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { Screen } from '../auth/decorators';
import { AuditLogService, type AuditLogQuery } from './audit-log.service';

@Controller('audit-logs')
@UseGuards(AuthGuard, ScreenGuard)
export class AuditLogController {
  constructor(private readonly auditLogs: AuditLogService) {}

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
}
