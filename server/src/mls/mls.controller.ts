import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { Screen } from '../auth/decorators';
import { MlsService, type MlsSearchQuery } from './mls.service';

/**
 * MLS listings proxy. Every route needs `mls` view. Unlike the source (which was unauthenticated),
 * this sits behind AuthGuard + ScreenGuard. The literal `status` route is declared before `:key`
 * so it isn't captured as a listing id.
 */
@Controller('mls')
@UseGuards(AuthGuard, ScreenGuard)
export class MlsController {
  constructor(private readonly mls: MlsService) {}

  @Get()
  @Screen('mls', 'view')
  search(@Query() q: MlsSearchQuery): Promise<unknown> {
    return this.mls.search(q);
  }

  /** Whether the MLS feed is wired up (drives the "not configured" banner). Never 503s. */
  @Get('status')
  @Screen('mls', 'view')
  status(): { configured: boolean } {
    return { configured: this.mls.configured };
  }

  @Get(':key')
  @Screen('mls', 'view')
  getOne(@Param('key') key: string): Promise<unknown> {
    return this.mls.getOne(key);
  }
}
