import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * A person's own notification choices. Authentication only, and every method is scoped to the
 * signed-in user — the same rule as the rest of `account/*`. There is deliberately no way to read
 * or set anyone else's: an administrator muting an agent's closing reminders is not a feature.
 */
@Controller('account/notification-preferences')
@UseGuards(AuthGuard)
export class NotificationPreferenceController {
  constructor(private readonly prefs: NotificationPreferenceService) {}

  @Get()
  list(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.prefs.list(user.id ?? -1);
  }

  /**
   * Save the screen in one call.
   *
   * The body is a plain `{ [category]: boolean }` map. Unknown keys are rejected by the service
   * rather than ignored, so a typo in a category name fails loudly instead of silently saving
   * nothing — a preference that appears to save and does not is the worst outcome here.
   */
  @Put()
  save(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const prefs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(body ?? {})) prefs[k] = v === true;
    return this.prefs.setMany(user.id ?? -1, prefs);
  }
}
