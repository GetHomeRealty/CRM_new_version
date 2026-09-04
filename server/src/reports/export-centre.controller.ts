import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { ExportJobService, type ExportAction } from './export-job.service';
import { parseSelection } from './bulk-export.controller';
import { contentDisposition } from '../common/content-disposition';

/**
 * Export & Download Centre. Queues bulk exports for background processing and serves the
 * generated files through expiring, token-based links.
 */
@Controller('export-centre')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class ExportCentreController {
  constructor(private readonly jobs: ExportJobService) {}

  /** Queue an export. Returns immediately with the job — the file is built in the background. */
  @Post('queue/:action')
  @HttpCode(202)
  queue(@CurrentUser() user: AuthUserRecord, @Param('action') action: string, @Body() body: Record<string, unknown>): Promise<unknown> {
    const hours = Number(body.expiry_hours);
    return this.jobs.enqueue(
      action as ExportAction,
      parseSelection(body),
      user,
      Number.isFinite(hours) && hours > 0 ? Math.min(24 * 30, hours) : undefined,
    );
  }

  /** Export history / current job statuses. */
  @Get()
  history(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.jobs.history(user, Number(limit) || 50);
  }

  /** Poll one job (the UI uses this while a job is Queued/Processing). */
  @Get('job/:exportId')
  job(@CurrentUser() user: AuthUserRecord, @Param('exportId') exportId: string): Promise<unknown> {
    return this.jobs.get(exportId, user);
  }

  /** Download a generated file by its token. Enforces expiry and ownership. */
  @Get('download/:token')
  async download(@CurrentUser() user: AuthUserRecord, @Param('token') token: string, @Res() res: Response): Promise<void> {
    const { abs, fileName, mime } = await this.jobs.download(token, user);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    // streamed, so a large ZIP is never held in memory
    createReadStream(abs).pipe(res);
  }

  /** Delete a generated file (admin/staff only). */
  @Delete(':exportId')
  remove(@CurrentUser() user: AuthUserRecord, @Param('exportId') exportId: string): Promise<unknown> {
    return this.jobs.remove(exportId, user);
  }

  /** Force the expiry sweep (used by tests and by an admin clearing space). */
  @Post('sweep')
  @HttpCode(200)
  async sweep(@CurrentUser() user: AuthUserRecord): Promise<{ swept: number }> {
    if ((user.role ?? 'agent') === 'agent') return { swept: 0 };
    return { swept: await this.jobs.sweepExpired() };
  }
}
