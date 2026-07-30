import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { RolesService } from './roles.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Settings → Roles & Permissions.
 *
 * Behind `@Screen('users', 'edit')` rather than AdminGuard: the ability to change what roles grant
 * belongs with the ability to change who holds them, and both are the Users screen's `edit` right.
 * Using the screen permission also means this endpoint is governed by the same system it edits,
 * which is the point of having one authorization engine.
 */
@Controller('roles')
@UseGuards(AuthGuard, ScreenGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Screen('users', 'view')
  index(): Promise<Record<string, unknown>[]> {
    return this.roles.list();
  }

  @Post()
  @Screen('users', 'edit')
  store(@CurrentUser() user: AuthUserRecord | undefined, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.roles.create(user ?? null, body ?? {});
  }

  @Patch(':role')
  @Screen('users', 'edit')
  update(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('role', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.roles.update(user ?? null, id, body ?? {});
  }

  /** Replace what a role grants. Takes the same screen → level map the users screen already speaks. */
  @Put(':role/permissions')
  @Screen('users', 'edit')
  permissions(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('role', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.roles.setGrants(user ?? null, id, (body?.permissions ?? body ?? {}) as Record<string, unknown>);
  }

  @Delete(':role')
  @Screen('users', 'edit')
  destroy(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('role', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    return this.roles.remove(user ?? null, id);
  }
}
