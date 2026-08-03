import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CrmSettingsService } from './crm-settings.service';
import { CrmAdvancedEmailService, type PromotionalOffer, type ReferralCode } from './crm-advanced-email.service';
import { SEASONS, BROADCAST_TYPES } from './crm-settings.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * CRM Settings, migrated from the CRM app and mounted alongside Transaction Desk's own Email
 * Settings — nothing under `mail-accounts`, `email-templates` or `company-settings` is affected.
 *
 * Everything here is gated on the `settings` screen, matching where it is surfaced in the UI.
 * The personal-profile and per-user preference endpoints only need `view`, because a user edits
 * their own record; the shared email settings and broadcasts need `edit`.
 */
@Controller('crm-settings')
@UseGuards(AuthGuard, ScreenGuard)
export class CrmSettingsController {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly email: CrmAdvancedEmailService,
  ) {}

  /** Vocabularies for the forms, so the client never hardcodes a list the server validates. */
  @Get('options')
  @Screen('settings', 'view')
  options(): Record<string, unknown> {
    return { seasons: SEASONS, broadcast_types: BROADCAST_TYPES };
  }

  // -------------------------------------------------------------- settings
  @Get()
  @Screen('settings', 'view')
  get(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.settings.getSettings(user);
  }

  /**
   * `edit`, not `view` — these write, and for anyone in `CRM_ADMIN_ROLES` they write the SHARED
   * GLOBAL row (`scopeId` returns null for them), including the email settings that decide which
   * automatic sends are enabled.
   *
   * They were gated on `view`, which is precisely the level the Admin role is given so that it
   * cannot change settings: `permission.service.ts` sets `manager` to `settings: 'view'` on purpose,
   * and an Admin was writing brokerage-wide CRM configuration through it anyway. A write has to ask
   * for write.
   */
  @Put()
  @Screen('settings', 'edit')
  save(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveSettings(user, body ?? {});
  }

  /** The CRM exposed POST as an alias of PUT on /api/settings; kept so behaviour matches. */
  @Post()
  @HttpCode(200)
  @Screen('settings', 'edit')
  savePost(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveSettings(user, body ?? {});
  }

  // --------------------------------------------------------------- profile
  @Get('profile')
  @Screen('settings', 'view')
  profile(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.settings.getProfile(user);
  }

  /**
   * Left on `view`, deliberately, unlike the two writes above.
   *
   * This one writes a single row — `users` WHERE id = the caller — so the authority it needs is
   * "are you yourself", which the session already establishes, and the screen permission is doing
   * visibility rather than authority. Raising it to `edit` would stop an Admin editing their own
   * name and phone number, which is not what the finding was about.
   */
  @Put('profile')
  @Screen('settings', 'view')
  saveProfile(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveProfile(user, body ?? {});
  }

  // -------------------------------------------------------- email settings
  @Get('email-settings')
  @Screen('settings', 'view')
  emailSettings(): Promise<unknown> {
    return this.settings.getEmailSettings();
  }

  @Put('email-settings')
  @Screen('settings', 'edit')
  saveEmailSettings(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveEmailSettings(user, body ?? {});
  }

  /**
   * The CRM's action-dispatch endpoint. Kept as one route with an `action` field so the
   * migrated behaviour — including its exact action names — is preserved.
   */
  @Post('email-settings')
  @HttpCode(200)
  @Screen('settings', 'edit')
  async emailAction(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    const action = str(body.action);
    const data = body as Record<string, unknown>;
    const signature = await this.signature(user);

    switch (action) {
      case 'updateSettings':
        return this.settings.saveEmailSettings(user, data);

      case 'sendWeddingEmail':
        return this.email.sendWeddingCongratulations(str(data.leadName), str(data.leadEmail), str(data.weddingDate), user, signature);

      case 'sendSeasonalEmail':
        return this.email.sendSeasonalWishes(str(data.leadName), str(data.leadEmail), str(data.season), str(data.year), user, signature);

      case 'sendPromotionalEmail':
        return this.email.sendPromotionalOffer(str(data.leadName), str(data.leadEmail), (data.offer ?? {}) as PromotionalOffer, user, signature);

      case 'sendReferralEmail':
        return this.email.sendReferralCode(str(data.leadName), str(data.leadEmail), (data.referralCode ?? {}) as ReferralCode, user, signature);

      case 'sendCustomEmail':
        return this.email.sendCustomEmail(str(data.leadName), str(data.leadEmail), str(data.subject), str(data.content), user, signature);

      case 'generateReferralCode':
        return { success: true, data: await this.email.generateReferralCode(data, user) };

      case 'bulkSend':
        return {
          success: true,
          ...(await this.email.bulkSend(
            Array.isArray(data.leads) ? (data.leads as Record<string, unknown>[]) : [],
            str(data.emailType),
            (data.emailData ?? {}) as Record<string, unknown>,
            user,
            signature,
          )),
        };

      default:
        return { success: false, error: 'Invalid action' };
    }
  }

  @Get('referral-codes')
  @Screen('settings', 'view')
  referralCodes(): Promise<unknown> {
    return this.email.listReferralCodes();
  }

  @Get('email-log')
  @Screen('settings', 'view')
  emailLog(@Query('limit') limit?: string): Promise<unknown> {
    return this.email.listLog(Number(limit) || 100);
  }

  // ------------------------------------------------------------ broadcasts
  @Post('broadcasts')
  @HttpCode(201)
  @Screen('settings', 'edit')
  broadcast(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.broadcast(user, body ?? {});
  }

  @Get('broadcasts')
  @Screen('settings', 'view')
  broadcasts(@Query('limit') limit?: string): Promise<unknown> {
    return this.settings.listBroadcasts(Number(limit) || 50);
  }

  // ---------------------------------------------------------- integrations
  @Get('integrations')
  @Screen('settings', 'view')
  integrations(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.settings.integrations(user);
  }

  /** The signature the user saved, appended to every advanced email they send. */
  private async signature(user: AuthUserRecord): Promise<string | undefined> {
    const s = await this.settings.getSettings(user);
    const email = s.emailSettings as { signature?: string } | undefined;
    return email?.signature ? email.signature : undefined;
  }
}
