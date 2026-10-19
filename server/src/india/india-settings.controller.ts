import { Body, Controller, Get, NotFoundException, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { allowedMarkets } from '../common/market';
import { IndiaSettingsService } from './india-settings.service';

/** India invoicing settings (19 Oct 2026). Read by anyone with India access; changed by a Super Admin. */
@Controller('india-settings')
@UseGuards(AuthGuard)
export class IndiaSettingsController {
  constructor(private readonly settings: IndiaSettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthUserRecord | undefined) {
    if (!user || !allowedMarkets(user.markets).includes('IN')) throw new NotFoundException({ message: 'Not found.' });
    return this.settings.get();
  }

  @Put()
  update(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>) {
    return this.settings.update(user, body ?? {});
  }
}
