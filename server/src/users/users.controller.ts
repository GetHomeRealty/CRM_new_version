import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { UsersService } from './users.service';
import { UserOnboardingService, type AdHocAttachment, type OnboardingKind, type OnboardingPreview } from './user-onboarding.service';

// User management — administrators only (Route::middleware('admin')).
@Controller()
@UseGuards(AuthGuard, AdminGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly onboarding: UserOnboardingService,
  ) {}

  // ---- Onboarding email + contract agreement --------------------------------
  /**
   * The message as it would arrive for this agent, variables already filled in. Read-only, so
   * the screen can show it before anything is sent.
   */
  @Get('users/:user/onboarding/:kind')
  onboardingPreview(
    @Param('user', ParseIntPipe) id: number,
    @Param('kind') kind: string,
  ): Promise<OnboardingPreview> {
    return this.onboarding.preview(id, kind as OnboardingKind);
  }

  /** Send it. A subject/body in the body are the reviewed version and win over the template. */
  @Post('users/:user/onboarding/:kind')
  @HttpCode(200)
  onboardingSend(
    @Param('user', ParseIntPipe) id: number,
    @Param('kind') kind: string,
    @Body() body: { subject?: string; html?: string; attachments?: AdHocAttachment[] },
  ): Promise<{ message: string; to: string }> {
    return this.onboarding.send(id, kind as OnboardingKind, body ?? {});
  }

  @Get('users/catalog')
  catalog(): ReturnType<UsersService['catalog']> {
    return this.users.catalog();
  }

  @Get('users/:user/deal-history')
  dealHistory(@Param('user', ParseIntPipe) id: number): Promise<Record<string, unknown>[]> {
    return this.users.dealHistory(id);
  }

  @Get('users')
  index(): Promise<Record<string, unknown>[]> {
    return this.users.index();
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
