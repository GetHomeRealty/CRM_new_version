import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { UsersService } from './users.service';
import { UserOnboardingService, type AdHocAttachment, type OnboardingKind, type OnboardingPreview } from './user-onboarding.service';
import { OffboardingService, type OffboardingChecklist } from './offboarding.service';
import { contentDisposition } from '../common/content-disposition';

/** Attachment types safe to render in the browser rather than download. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The address the browser reached this API on, used to render the logo in the onboarding signature
 * so the review screen can load it. Nothing outside this browser depends on it — the message the
 * agent receives carries the image inside it — so there is no setting to get wrong.
 */
function publicBaseUrl(req: Request): string {
  const first = (v: unknown): string => String(v ?? '').split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  return host ? `${proto}://${host}` : '';
}

// User management — administrators only (Route::middleware('admin')).
@Controller()
@UseGuards(AuthGuard, AdminGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly onboarding: UserOnboardingService,
    private readonly offboardingService: OffboardingService,
  ) {}

  // ---- Onboarding email + contract agreement --------------------------------
  /**
   * The message as it would arrive for this agent, variables already filled in, so the screen can
   * show it before anything is sent. Nothing is sent by asking; the template and the documents it
   * carries are seeded here on first use.
   */
  @Get('users/:user/onboarding/:kind')
  onboardingPreview(
    @Param('user', ParseIntPipe) id: number,
    @Param('kind') kind: string,
    @Req() req: Request,
  ): Promise<OnboardingPreview> {
    return this.onboarding.preview(id, kind as OnboardingKind, publicBaseUrl(req));
  }

  /** Send it. A subject/body in the body are the reviewed version and win over the template. */
  @Post('users/:user/onboarding/:kind')
  @HttpCode(200)
  onboardingSend(
    @Param('user', ParseIntPipe) id: number,
    @Param('kind') kind: string,
    @Body() body: { subject?: string; html?: string; attachments?: AdHocAttachment[] },
    @Req() req: Request,
  ): Promise<{ message: string; to: string }> {
    return this.onboarding.send(id, kind as OnboardingKind, body ?? {}, publicBaseUrl(req));
  }

  /**
   * One of the files that will be sent with the onboarding email or contract agreement, so it can
   * be read before it goes out. Nobody should have to send a document to a new recruit on the
   * strength of its filename.
   */
  /**
   * The document that will be attached, rendered from the message as it currently stands — so what
   * is read here is what the agent receives, including an edit made moments ago. A POST because the
   * body being rendered is sent with the request; nothing is stored and nothing is sent.
   */
  @Post('users/:user/onboarding/:kind/document')
  @HttpCode(200)
  async onboardingDocument(
    @Param('user', ParseIntPipe) id: number,
    @Param('kind') kind: string,
    @Body() body: { html?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (kind !== 'contract' && kind !== 'media') {
      throw new BadRequestException({ message: `No document is generated for "${kind}".` });
    }
    const html = (body?.html ?? '').trim() || (await this.onboarding.preview(id, kind, publicBaseUrl(req))).html;
    const file = await this.onboarding.agreementDocument(id, kind, html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(file.filename, { inline: true }));
    res.end(file.data);
  }

  @Get('onboarding/:kind/attachments/:attachmentId')
  async onboardingAttachment(
    @Param('kind') kind: string,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.onboarding.attachment(kind as OnboardingKind, attachmentId);
    res.setHeader('Content-Type', file.contentType);
    // Shown in the browser only for the formats a preview is useful for. Anything else downloads:
    // a stored HTML or SVG file rendered in this origin would run alongside the session cookie.
    const inline = INLINE_TYPES.has(file.contentType.toLowerCase().split(';')[0].trim());
    res.setHeader('Content-Disposition', contentDisposition(file.filename, { inline }));
    res.end(file.data);
  }

  @Get('users/catalog')
  catalog(): ReturnType<UsersService['catalog']> {
    return this.users.catalog();
  }

  @Get('users/:user/deal-history')
  dealHistory(@Param('user', ParseIntPipe) id: number): Promise<Record<string, unknown>[]> {
    return this.users.dealHistory(id);
  }

  /**
   * What this person still holds, asked before switching their account off.
   *
   * Counts only, Super Admin only — see `OffboardingService`. Read-only: it reports, and never
   * disconnects or moves anything on the caller's behalf.
   */
  @Get('users/:user/offboarding')
  offboarding(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('user', ParseIntPipe) id: number,
  ): Promise<OffboardingChecklist> {
    return this.offboardingService.checklist(user ?? null, id);
  }

  @Get('users')
  index(@Query('page') page?: string, @Query('limit') limit?: string): Promise<Record<string, unknown>[]> {
    return this.users.index({ page, limit });
  }

  @Post('users')
  @HttpCode(201)
  store(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.users.store(user ?? null, body ?? {});
  }

  @Put('users/:user')
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('user', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.users.update(user ?? null, id, body ?? {});
  }

  @Patch('users/:user')
  updatePatch(@CurrentUser() user: AuthUserRecord | undefined, @Param('user', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.users.update(user ?? null, id, body ?? {});
  }

  @Delete('users/:user')
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('user', ParseIntPipe) id: number): Promise<{ message: string }> {
    return this.users.destroy(user ?? null, id);
  }
}
