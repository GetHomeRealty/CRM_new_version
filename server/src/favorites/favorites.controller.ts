import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { FavoritesService } from './favorites.service';

/**
 * Per-user MLS favorites. Everything is self-scoped, so `mls`/`favorites` view is enough to manage
 * your own — there is no admin surface here. The literal `keys` route precedes `:listingKey`.
 */
@Controller('favorites')
@UseGuards(AuthGuard, ScreenGuard)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @Screen('favorites', 'view')
  list(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.favorites.list(user);
  }

  @Get('keys')
  @Screen('favorites', 'view')
  keys(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.favorites.keys(user);
  }

  @Post('toggle')
  @HttpCode(200)
  @Screen('favorites', 'view')
  toggle(@CurrentUser() user: AuthUserRecord, @Body() body: { listing_key?: string; snapshot?: unknown }): Promise<unknown> {
    return this.favorites.toggle(user, String(body?.listing_key ?? ''), body?.snapshot);
  }

  @Delete(':listingKey')
  @Screen('favorites', 'view')
  remove(@CurrentUser() user: AuthUserRecord, @Param('listingKey') listingKey: string): Promise<unknown> {
    return this.favorites.remove(user, listingKey);
  }
}
