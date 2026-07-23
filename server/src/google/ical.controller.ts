import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { IcalFeedService } from './ical-feed.service';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Connect a Google Calendar by its secret iCal link — the no-OAuth option. Guarded by
 * authentication and scoped to the signed-in user.
 */
@Controller('calendar/ical')
@UseGuards(AuthGuard)
export class IcalController {
  constructor(private readonly feeds: IcalFeedService) {}

  @Get('status')
  async status(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const feed = await this.feeds.find(user.id ?? -1);
    return {
      connected: !!feed,
      name: feed?.name ?? null,
      last_sync: feed?.last_sync ? feed.last_sync.toISOString() : null,
      error: feed?.sync_error ?? null,
    };
  }

  @Post('connect')
  async connect(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.feeds.connect(user.id ?? -1, str(body.url));
    return { ...result, message: `Connected${result.name ? ` "${result.name}"` : ''} — pulled ${result.pulled} event${result.pulled === 1 ? '' : 's'}.` };
  }

  @Post('sync')
  async sync(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const result = await this.feeds.sync(user.id ?? -1);
    return { ...result, message: result.error ? result.error : `Synced ${result.pulled} event${result.pulled === 1 ? '' : 's'} from your calendar link.` };
  }

  @Post('disconnect')
  async disconnect(@CurrentUser() user: AuthUserRecord): Promise<{ disconnected: boolean }> {
    await this.feeds.disconnect(user.id ?? -1);
    return { disconnected: true };
  }
}
