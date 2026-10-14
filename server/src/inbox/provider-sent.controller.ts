import { BadRequestException, Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AreaGuard } from '../core/area.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { isArea } from '../common/domain';
import { ProviderSentService, type SentReference } from './provider-sent.service';
@Controller('account/provider-sent')
@UseGuards(AuthGuard, AreaGuard)
export class ProviderSentController {
  constructor(private readonly sent: ProviderSentService) {}
  private async run<T>(req: Request, res: Response, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController(); const closed = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', closed); res.once('close', closed);
    res.setHeader('Cache-Control', 'no-store');
    try { return await work(controller.signal); } finally { req.off('aborted', closed); res.off('close', closed); }
  }
  private check(query: SentReference & { area?: string }) { if (!isArea(query.area)) throw new BadRequestException('Choose CRM or Transaction Desk.'); }
  @Get()
  list(@CurrentUser() user: AuthUserRecord, @Query() query: SentReference & { area?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) { this.check(query); return this.run(req, res, signal => this.sent.list(user.id ?? -1, query, signal)); }
  @Get(':uid')
  detail(@CurrentUser() user: AuthUserRecord, @Param('uid') uid: string, @Query() query: SentReference & { area?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) { this.check(query); return this.run(req, res, signal => this.sent.detail(user.id ?? -1, uid, query, signal)); }
}
