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
   * Save the whole matrix in one call.
   *
   * The body is `{ [category]: { [channel]: boolean } }`. Unknown categories and channels are
   * rejected by the service rather than ignored, so a typo fails loudly instead of silently saving
   * nothing — a preference that appears to save and does not is the worst outcome here.
   *
   * THE OLD FLAT SHAPE IS STILL ACCEPTED: `{ [category]: boolean }` is read as the PUSH answer,
   * which is exactly what it meant before channels existed. An older client — or a tab left open
   * across the deploy — therefore keeps working and keeps meaning the same thing, rather than
   * silently writing every channel at once.
   */
  @Put()
  save(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const prefs: Record<string, Record<string, boolean>> = {};
    for (const [category, value] of Object.entries(body ?? {})) {
      if (value !== null && typeof value === 'object') {
        const channels: Record<string, boolean> = {};
        for (const [channel, on] of Object.entries(value as Record<string, unknown>)) channels[channel] = on === true;
        prefs[category] = channels;
      } else {
        prefs[category] = { push: value === true };
      }
    }
    return this.prefs.setMany(user.id ?? -1, prefs);
  }
}
