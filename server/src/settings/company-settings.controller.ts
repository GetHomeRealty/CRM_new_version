import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CompanySettingsService } from './company-settings.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';

@Controller('company-settings')
export class CompanySettingsController {
  constructor(private readonly settings: CompanySettingsService) {}

  /** Readable by any authenticated staff (printed on invoices). */
  @Get()
  @UseGuards(AuthGuard)
  async show(): Promise<Record<string, unknown>> {
    return this.settings.serialize(await this.settings.current());
  }

  /** Administrators only. */
  @Put()
  @UseGuards(AuthGuard, AdminGuard)
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
  @UseGuards(AuthGuard, AdminGuard)
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
  @UseGuards(AuthGuard, AdminGuard)
  async deleteLogo(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    const actor = user ? { id: user.id, name: user.name } : null;
    return this.settings.serialize(await this.settings.removeLogo(actor));
  }
}
