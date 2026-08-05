import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BROADCAST_LIMIT, SETTINGS_WRITE_LIMIT } from '../config/rate-limits';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CrmSettingsService } from './crm-settings.service';
import { CrmAdvancedEmailService, type PromotionalOffer, type ReferralCode } from './crm-advanced-email.service';
import { CrmTriggersService } from './crm-triggers.service';
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
    private readonly triggers: CrmTriggersService,
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
  @Throttle({ default: SETTINGS_WRITE_LIMIT })
  @Screen('settings', 'edit')
  save(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveSettings(user, body ?? {});
  }

  /** The CRM exposed POST as an alias of PUT on /api/settings; kept so behaviour matches. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: SETTINGS_WRITE_LIMIT })
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
  @Throttle({ default: SETTINGS_WRITE_LIMIT })
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

  // ------------------------------------------------------------- triggers
  /**
   * A PERSON'S OWN CRM email triggers.
   *
   * Gated on `triggers`, not `settings` — the permission the route and the sidebar entry already
   * ask for. They asked for `triggers` while this screen's data asked for `settings`, so agent,
   * accounting, documentation and crm were all offered a Triggers item in the navigation and met a
   * 403 behind it (CRM › Triggers audit, T-H1). One permission for one screen.
   *
   * Safe to widen because the rows are per-user: `crm_trigger_settings` is one row per person, and
   * neither endpoint takes a user id from the caller. Whoever is signed in reads and writes their
   * own switches and cannot reach anybody else's — an agent turning off promotional email changes
   * what THEY send and nothing else.
   */
  @Get('triggers')
  @Screen('triggers', 'view')
  myTriggers(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.triggers.getForUser(user);
  }

  @Put('triggers')
  @Screen('triggers', 'edit')
  saveMyTriggers(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.triggers.saveForUser(user, body ?? {});
  }

  @Get('referral-codes')
  @Screen('settings', 'view')
  referralCodes(): Promise<unknown> {
    return this.email.listReferralCodes();
  }

  @Get('email-log')
  @Screen('settings', 'view')
  emailLog(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.email.listLog(user, Number(limit) || 100);
  }

  // ------------------------------------------------------------ broadcasts
  /**
   * Its own rate limit, unlike everything else here: this is the one endpoint on the screen whose
   * cost is one SMTP round trip per member of staff, and whose effect cannot be undone. The general
   * 600-a-minute bucket is sized for a form that auto-saves. See `BROADCAST_LIMIT`.
   */
  @Post('broadcasts')
  @HttpCode(201)
  @Throttle({ default: BROADCAST_LIMIT })
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

  /**
   * The signature appended to every advanced email this person sends: their own, falling back to
   * the brokerage's.
   *
   * It read `getSettings(user)`, whose scope comes from the caller's ROLE — so an administrator got
   * the shared global signature and their own was never consulted. That was invisible while
   * `/api/account/settings` also wrote the global row; now that a person's own Settings page writes
   * their own row (see `saveOwnSettings`), reading only the global one would mean an Admin could
   * set a personal signature and watch every email go out with somebody else's.
   *
   * Own first, brokerage second, none third. An agent who has set nothing still signs with the
   * brokerage default, which is what the fallback is for.
   */
  private async signature(user: AuthUserRecord): Promise<string | undefined> {
    const own = await this.settings.getOwnSettings(user);
    const mine = (own.emailSettings as { signature?: string } | undefined)?.signature;
    if (mine) return mine;

    const shared = await this.settings.getSettings(user);
    const theirs = (shared.emailSettings as { signature?: string } | undefined)?.signature;
    return theirs || undefined;
  }
}
