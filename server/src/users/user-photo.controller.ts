import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { UserPhotoService } from './user-photo.service';

/**
 * Profile pictures.
 *
 * Separate from UsersController because that whole controller is administrators-only, and
 * every user — whatever their role — must be able to manage their own picture. The
 * self-or-admin rule is enforced per request in the service instead.
 *
 * Unlike the brand logo these stay behind the session guard: a staff photo is not public
 * branding, so it should not be readable by anyone who can guess a user id.
 */
@Controller()
@UseGuards(AuthGuard)
export class UserPhotoController {
  constructor(private readonly photos: UserPhotoService) {}

  /** My own picture — the route the personal Settings screen uses. */
  @Get('account/photo')
  mine(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.photos.describe(user?.id ?? -1);
  }

  @Post('account/photo')
  @HttpCode(200)
  uploadMine(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.photos.store(user ?? null, user?.id ?? -1, String(body.file_name ?? ''), String(body.content ?? ''));
  }

  @Delete('account/photo')
  removeMine(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.photos.remove(user ?? null, user?.id ?? -1);
  }

  /** Any signed-in user may render a colleague's avatar. */
  @Get('users/:user/photo')
  async serve(
    @Param('user', ParseIntPipe) id: number,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.photos.file(id);
    // Cached either way, so a user list does not re-request every avatar on each render.
    // A `?v=` URL is version-pinned and can be held indefinitely.
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=300');
    if (!file) {
      res.status(404).json({ message: 'This user has no profile picture.' });
      return;
    }
    res.setHeader('ETag', `"${Math.round(file.mtime)}-${file.size}"`);
    if (req.fresh) { res.status(304).end(); return; }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.size));
    createReadStream(file.abs).pipe(res);
  }

  /** Set someone else's picture — administrators, or the user themselves. */
  @Post('users/:user/photo')
  @HttpCode(200)
  upload(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('user', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.photos.store(user ?? null, id, String(body.file_name ?? ''), String(body.content ?? ''));
  }

  @Delete('users/:user/photo')
  remove(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('user', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.photos.remove(user ?? null, id);
  }
}
