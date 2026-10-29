import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { ReminderRulesService } from './reminder-rules.service';

/**
 * The reminder switches and days on the Triggers screen (29 Oct 2026). Transactions view opens the
 * door to read them; the service lets only a Super Admin change them.
 */
@Controller('reminder-rules')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class ReminderRulesController {
  constructor(private readonly rules: ReminderRulesService) {}

  @Get()
  read(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.rules.read(user);
  }

  @Put()
  save(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.rules.save(user, body ?? {});
  }
}
