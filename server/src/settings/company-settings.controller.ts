import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { can } from '../core/authz';
import { CompanySettingsService } from './company-settings.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';

@Controller('company-settings')
export class CompanySettingsController {
  constructor(private readonly settings: CompanySettingsService) {}

  /**
   * Readable by any authenticated staff — but the bank account is not part of "readable".
   *
   * The branding half of this row (name, address, phone, logo, currency, tax rate) is needed by
   * every screen, so the endpoint stays open. The banking half is printed only on the Invoice,
   * Trade Sheet, Notice of Sale, Deposit Receipt and Lawyer Statement, and is withheld from anyone
   * who cannot produce those.
   *
   * THIS ASKS A CAPABILITY, NOT A ROLE. It used to strip for `isAgent(user)`, which answered "is
   * this person an agent?" when the question is "may this person see the operating account?" —
   * so `crm`, a role with `transactions: 'none'` and `invoice: 'none'`, received the brokerage's
   * account and transit numbers on request. A brokerage's operating account is the raw material of
   * payment-redirection fraud; it should not be one fetch away from a login that cannot open a
   * single screen displaying it. See `company.read-banking` in authz.ts for why the line sits where
   * it does.
   *
   * Stripped rather than 403'd, because the same request legitimately carries the branding the
   * caller genuinely needs.
   */
  @Get()
  @UseGuards(AuthGuard)
  async show(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    const row = this.settings.serialize(await this.settings.current());
    if (can(user, 'company.read-banking')) return row;

    const withheld = ['bank_beneficiary', 'bank_name', 'transit_no', 'account_no', 'institution_no', 'hst_number'];
    const safe: Record<string, unknown> = { ...row };
    for (const key of withheld) delete safe[key];
    return safe;
  }

  /**
   * Gated on the `settings` screen at `edit` — the permission the Roles & Permissions screen
   * actually grants.
   *
   * WHY THIS CHANGED, AND WHY IT CHANGES NOTHING BY DEFAULT. These three writes were on
   * `AdminGuard` (`isSuperAdmin`) while `CompanySettingsPage` decided whether to render an editable
   * form from `can('settings','edit')`. Two authorities for one action, and the product ships a
   * screen whose whole purpose is to grant the one the server ignored: granting `settings: edit` to
   * the Admin role returned 200, `/api/user` reported it, the form enabled, Save appeared — and
   * every save came back 403 saying the caller was not an administrator.
   *
   * The default permission map is unchanged by this: `admin` holds `settings: 'edit'` and every
   * other role holds `view` or `none`, so exactly the same people can write today as could before.
   * What is different is that the grant now means what the screen says it means.
   */
  @Put()
  @UseGuards(AuthGuard, ScreenGuard)
  @Screen('settings', 'edit')
  async update(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: UpdateCompanySettingsDto,
  ): Promise<Record<string, unknown>> {
    const actor = user ? { id: user.id, name: user.name } : null;
    return this.settings.serialize(await this.settings.update(actor, dto));
  }

  /**
   * The brand logo, served to anyone.
   *
   * Deliberately unauthenticated: it is rendered by plain <img> tags — on the sign-in
   * screen before any session exists, inside printed invoices and receipts, and in emails
   * that reach clients outside the brokerage. Requiring a session would break all three,
   * and the logo is public branding by definition: it is printed on documents sent to
   * customers. Nothing else on this controller is readable without a session.
   */
  @Get('logo')
  async logo(@Req() req: Request, @Res() res: Response): Promise<void> {
    const file = await this.settings.logoFile();
    // Both outcomes are cached. Without this the sidebar re-requests the logo — or
    // re-discovers its absence — on every page load, which is exactly the kind of
    // per-navigation round trip branding should never add.
    //
    // A `?v=` URL is version-pinned (the settings screen passes the settings timestamp),
    // so it can be cached indefinitely; the bare URL used by the shell revalidates after
    // a few minutes, which is how quickly a replaced logo reaches everyone else.
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    if (!file) {
      res.status(404).json({ message: 'No logo has been uploaded.' });
      return;
    }
    // ETag before the freshness check — req.fresh compares the request's If-None-Match
    // against the ETag already on the response. Piping a stream by hand does not handle
    // conditional requests the way res.sendFile does, so this is done explicitly.
    res.setHeader('ETag', `"${Math.round(file.mtime)}-${file.size}"`);
    if (req.fresh) {
      res.status(304).end();   // unchanged — no body re-sent
      return;
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.size));
    createReadStream(file.abs).pipe(res);
  }

  /** Upload a new logo. Sent base64-encoded in JSON, as the other uploads in this API are. */
  @Post('logo')
  @HttpCode(200)
  @UseGuards(AuthGuard, ScreenGuard)
  @Screen('settings', 'edit')
  async uploadLogo(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const actor = user ? { id: user.id, name: user.name } : null;
    const saved = await this.settings.storeLogo(actor, String(body.file_name ?? ''), String(body.content ?? ''));
    return this.settings.serialize(saved);
  }

  /** Remove the logo; every surface falls back to the text wordmark. */
  @Delete('logo')
  @UseGuards(AuthGuard, ScreenGuard)
  @Screen('settings', 'edit')
  async deleteLogo(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    const actor = user ? { id: user.id, name: user.name } : null;
    return this.settings.serialize(await this.settings.removeLogo(actor));
  }
}
