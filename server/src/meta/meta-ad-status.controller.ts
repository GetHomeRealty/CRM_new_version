import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { META_SYNC_LIMIT } from '../config/rate-limits';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaAdStatusService, formStatus } from './meta-ad-status.service';

const MAX_FORMS = 200;

/**
 * Advertising status for lead forms — READ ONLY. Nothing here, or in the service behind it, sends
 * anything but GET requests to Meta; no ad, ad set or campaign can be changed from this endpoint.
 *
 * `form_ids` names the forms the screen is showing; only those are answered. Each person reads with
 * their own Meta login, so they see the ads their own access allows and nobody else's.
 */
@Controller('meta')
@UseGuards(AuthGuard, ScreenGuard)
export class MetaAdStatusController {
  constructor(private readonly adStatus: MetaAdStatusService) {}

  @Get('ad-status')
  @Throttle({ default: META_SYNC_LIMIT })
  @Screen('meta', 'view')
  async status(
    @CurrentUser() user: AuthUserRecord,
    @Query('form_ids') formIds?: string,
    @Query('refresh') refresh?: string,
  ): Promise<Record<string, unknown>> {
    const ids = [...new Set(String(formIds ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,32}$/.test(s)))].slice(0, MAX_FORMS);
    const scan = await this.adStatus.scanFor(user.id ?? 0, refresh === '1' || refresh === 'true');
    return {
      checked_at: scan.checked_at,
      blocked: scan.blocked,
      accounts_checked: scan.accounts_checked,
      accounts_failed: scan.accounts_failed,
      forms: Object.fromEntries(ids.map((id) => [id, formStatus(scan, id)])),
    };
  }
}
