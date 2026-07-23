import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { MailAccountService } from '../email/mail-account.service';
import { MailerService } from '../email/mailer.service';

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
  /** Signature, default reply template, auto-sync — the user's own, plus their integrations. */
  @Get('settings')
  async accountSettings(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    const [settings, integrations] = await Promise.all([
      this.settings.getSettings(user),
      this.settings.integrations(user),
    ]);
    return { emailSettings: settings.emailSettings, integrations };
  }

  @Put('settings')
  saveSettings(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    // Only the email-preferences section is writable here; wrap it so saveSettings' "at least one
    // section" guard is satisfied and nothing else can be touched from this screen.
    return this.settings.saveSettings(user, { emailSettings: body?.emailSettings ?? body ?? {} });
  }

  // ---------------------------------------------------- personal mail accounts
  @Get('mail-accounts')
  mailAccounts(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.accounts.indexForUser(user.id ?? -1);
  }

  @Post('mail-accounts')
  @HttpCode(201)
  addMailAccount(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.accounts.storeForUser(user.id ?? -1, body ?? {});
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
