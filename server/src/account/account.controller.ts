import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { MailAccountService, parseScope } from '../email/mail-account.service';
import { MailerService } from '../email/mailer.service';
import { emailLimitFor } from '../email/agent-email-limit';
import { PrismaService } from '../prisma/prisma.service';
import { parseArea } from '../common/domain';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * A user's own Settings — the same for everyone, agent to super-admin. Guarded only by
 * authentication, NOT by the admin `settings` screen: this is a person managing their own
 * profile, their own mail accounts, their own signature and their own integrations. Every method
 * is scoped to the signed-in user, so no one reaches anyone else's account.
 *
 * The profile, preference and integration reads reuse CrmSettingsService, which is already
 * per-user. Mail accounts are the per-user methods on MailAccountService — a personal account is
 * private to its owner and used to send their own mail.
 */
@Controller('account')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly accounts: MailAccountService,
    private readonly mailer: MailerService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------- personal information
  @Get('profile')
  profile(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.settings.getProfile(user);
  }

  @Put('profile')
  saveProfile(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.settings.saveProfile(user, body ?? {});
  }

  // -------------------------------------------------------- email preferences
  /**
   * Signature, default reply template, auto-sync — the user's own, plus their integrations.
   *
   * `getOwnSettings` / `saveOwnSettings`, NOT `getSettings` / `saveSettings`. Those two resolve
   * their scope from the caller's ROLE, and for `admin`, `manager`, `administrator` and `developer`
   * that resolves to `user_id = null` — the shared brokerage-wide row. This controller carries
   * `AuthGuard` and nothing else, so it was a settings write with no settings permission on it:
   * measured on 2026-08-04, an Admin holding `settings: 'view'` got 403 from
   * `PUT /api/crm-settings` and 200 from `PUT /api/account/settings`, writing the global row the
   * first route had just refused them. The self-scoped pair forces `user_id = user.id` regardless
   * of role, which is what this screen has always claimed to do.
   *
   * Brokerage-wide CRM settings are still editable — under CRM Settings, behind
   * `@Screen('settings', 'edit')`, which is the one place that asks for the authority.
   */
  @Get('settings')
  async accountSettings(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    const [settings, integrations] = await Promise.all([
      this.settings.getOwnSettings(user),
      this.settings.integrations(user),
    ]);
    return { emailSettings: settings.emailSettings, integrations };
  }

  @Put('settings')
  saveSettings(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    // Only the email-preferences section is writable here; wrap it so the "at least one section"
    // guard is satisfied and nothing else can be touched from this screen.
    return this.settings.saveOwnSettings(user, { emailSettings: body?.emailSettings ?? body ?? {} });
  }

  // ---------------------------------------------------- personal mail accounts
  /**
   * `?scope=crm|desk` narrows the list to the integrations area that is asking, so CRM
   * Settings and Transaction Desk Settings never show each other's accounts. Omitting it
   * returns every account, which is what the personal Settings screen wants — and keeps
   * the endpoint backward compatible for any caller that predates the split.
   */
  @Get('mail-accounts')
  mailAccounts(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<unknown> {
    return this.accounts.indexForUser(user.id ?? -1, parseScope(scope));
  }

  /**
   * How many accounts this user may connect in one area, and how many they already have.
   *
   * The rule is the server's — the frontend asks rather than deriving it from the role, so the
   * screen and the validation can never disagree about who may add another address. The Add button
   * uses this to explain itself before it is pressed; the POST above enforces it regardless.
   */
  @Get('mail-accounts/limit')
  mailAccountLimit(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<unknown> {
    return emailLimitFor(this.prisma, user.id ?? -1, parseArea(scope));
  }

  @Post('mail-accounts')
  @HttpCode(201)
  addMailAccount(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    // The new account belongs to whichever area added it.
    return this.accounts.storeForUser(user.id ?? -1, body ?? {}, parseScope(body?.scope));
  }

  /** Assign an existing account to CRM / Transaction Desk, or back to unassigned (both). */
  @Put('mail-accounts/:id/scope')
  setMailAccountScope(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.accounts.setScopeForUser(user.id ?? -1, id, parseScope(body?.scope) ?? null);
  }

  @Put('mail-accounts/:id')
  updateMailAccount(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.accounts.updateForUser(user.id ?? -1, id, body ?? {});
  }

  @Delete('mail-accounts/:id')
  removeMailAccount(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.accounts.destroyForUser(user.id ?? -1, id);
  }

  @Post('mail-accounts/:id/default')
  @HttpCode(200)
  makeDefault(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.accounts.setDefaultForUser(user.id ?? -1, id);
  }

  /** Send a test message through the user's own account, to prove the credentials work. */
  @Post('mail-accounts/:id/test')
  @HttpCode(200)
  async test(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    const account = await this.accounts.findForUser(user.id ?? -1, id);
    const to = str(body.to) || account.from_email;
    await this.mailer.test(account, to);
    return { message: `Test email sent to ${to}.` };
  }
}
