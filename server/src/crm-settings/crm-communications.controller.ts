import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import { EmailTemplateService } from '../email/email-template.service';
import { CrmCommunicationsService } from './crm-communications.service';
import type { AuthUserRecord } from '../auth/auth.types';

type Res = Record<string, unknown>;

/**
 * CRM → Settings → Communications.
 *
 * THE PERMISSION MODEL IS THE POINT OF THIS FILE, so it is stated plainly rather than left to be
 * inferred from decorators:
 *
 *   Everyone signed in  — read the list, read their own preferences, set their OWN preferences,
 *                         preview a template.
 *   `settings: edit`    — the brokerage controls: the master switch and the per-communication
 *                         defaults. Exactly the permission `PUT /api/crm-settings/email-settings`
 *                         has always enforced for these two values, carried over unchanged when
 *                         they moved off the Triggers screen. NOT `superAdmin`: a brokerage can
 *                         grant this through Roles & Permissions, and the control must follow the
 *                         grant rather than the role.
 *   Super Admin only    — edit template content, choose a sender, manage attachments, set the
 *                         template Active/Off, create a template.
 *
 * `ScreenGuard` is mounted on the class and does nothing to a route with no `@Screen` — so the open
 * routes below stay open and the one route that declares a screen is the only one gated by it.
 *
 * ENFORCED HERE, NOT IN THE SCREEN. An agent who calls the write endpoints directly is refused by
 * `AdminGuard` on those routes; hiding the buttons is presentation, not authorization. The read and
 * preference routes carry `AuthGuard` alone, which is the widening this screen needs and the
 * narrowest one that makes it work.
 *
 * SETTING SOMEBODY ELSE'S PREFERENCE IS NOT REFUSED — IT IS UNEXPRESSIBLE. `setPreference` takes
 * the caller from the session and has no user parameter, so there is no request shape that names
 * another person. A check can be forgotten; a missing parameter cannot.
 *
 * TEMPLATE EDITING IS DELIBERATELY NOT RE-IMPLEMENTED. Editing, preview and attachments already
 * exist on `EmailTemplateService` and are used by Transaction Desk's own screen. This controller
 * calls the same service so the two screens cannot drift, and so nothing about Desk changes.
 */
@Controller('crm-communications')
@UseGuards(AuthGuard, ScreenGuard)
export class CrmCommunicationsController {
  constructor(
    private readonly comms: CrmCommunicationsService,
    private readonly templates: EmailTemplateService,
  ) {}

  /** The whole screen: brokerage switch, communications, this person's preferences, templates. */
  @Get()
  overview(@CurrentUser() user: AuthUserRecord): Promise<Res> {
    return this.comms.overview(user);
  }

  /** Set one channel of one communication — always for the caller. */
  @Put('preferences/:key/:channel')
  setPreference(
    @CurrentUser() user: AuthUserRecord,
    @Param('key') key: string,
    @Param('channel') channel: string,
    @Body() body: Res,
  ): Promise<Res> {
    return this.comms.setPreference(user, key, channel, body?.enabled === true);
  }

  /**
   * Preview a template. Open to any signed-in user: an agent deciding whether to switch a
   * communication off should be able to see what it says, and a preview renders sample values —
   * it exposes no client data.
   */
  @Post('templates/:id/preview')
  @HttpCode(200)
  preview(@Param('id', ParseIntPipe) id: number): Promise<{ subject: string; html: string }> {
    return this.templates.preview(id);
  }

  /**
   * The brokerage controls — the master switch and the per-communication defaults.
   *
   * `settings: edit`, the permission these two values have always been written behind. This is the
   * one place they are set now: the card that used to hold them on Triggers → CRM Triggers is gone
   * with that screen, and there is no second endpoint offering them.
   *
   * A PATCH in everything but the verb: an absent field is unchanged. See `setBrokerage`.
   */
  @Put('brokerage')
  @Screen('settings', 'edit')
  setBrokerage(@CurrentUser() user: AuthUserRecord, @Body() body: Res): Promise<Res> {
    return this.comms.setBrokerage(user, body ?? {});
  }

  // ------------------------------------------------------- Super Admin only

  /** Edit shared template content. Same service the Transaction Desk screen uses. */
  @Put('templates/:id')
  @UseGuards(AdminGuard)
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: Res): Promise<{ data: Res }> {
    return { data: await this.templates.update(id, body ?? {}) };
  }

  /** Create a CRM template. Unmapped templates are created inactive and cannot send — see the service. */
  @Post('templates')
  @HttpCode(201)
  @UseGuards(AdminGuard)
  create(@CurrentUser() user: AuthUserRecord, @Body() body: Res): Promise<Res> {
    return this.comms.createTemplate(user, body ?? {});
  }
}
