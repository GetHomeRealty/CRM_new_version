import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentOnboardingService } from './recruitment-onboarding.service';
import { RecruitmentNoAgentsGuard } from './recruitment-no-agents.guard';

/**
 * Recruitment → Onboarding & Training tab. The same guards as the rest of Recruitment: the screen
 * permission opens the routes (`view` to read, `edit` to fill in cells and add people), agents are
 * refused outright, and the administrator-only actions — the step list, removing a person, the
 * sheet import — are checked in the service against `recruitment.decide`.
 */
@Controller('recruitment/onboarding')
@UseGuards(AuthGuard, ScreenGuard, RecruitmentNoAgentsGuard)
export class RecruitmentOnboardingController {
  constructor(private readonly onboarding: RecruitmentOnboardingService) {}

  @Get()
  @Screen('recruitment', 'view')
  list(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    return this.onboarding.list(user);
  }

  @Put('people/:personId/marks/:stepId')
  @Screen('recruitment', 'edit')
  setMark(
    @CurrentUser() user: AuthUserRecord,
    @Param('personId', ParseIntPipe) personId: number,
    @Param('stepId', ParseIntPipe) stepId: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.onboarding.setMark(user, personId, stepId, body ?? {});
  }

  @Post('people')
  @Screen('recruitment', 'edit')
  addPerson(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.onboarding.addPerson(user, body ?? {});
  }

  @Put('people/:personId')
  @Screen('recruitment', 'edit')
  updatePerson(@Param('personId', ParseIntPipe) personId: number, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.onboarding.updatePerson(personId, body ?? {});
  }

  @Delete('people/:personId')
  @Screen('recruitment', 'edit')
  removePerson(@CurrentUser() user: AuthUserRecord, @Param('personId', ParseIntPipe) personId: number): Promise<Record<string, unknown>> {
    return this.onboarding.removePerson(user, personId);
  }

  @Post('steps')
  @Screen('recruitment', 'edit')
  addStep(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.onboarding.addStep(user, body ?? {});
  }

  @Put('steps/:stepId')
  @Screen('recruitment', 'edit')
  updateStep(
    @CurrentUser() user: AuthUserRecord,
    @Param('stepId', ParseIntPipe) stepId: number,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.onboarding.updateStep(user, stepId, body ?? {});
  }

  @Post('import/preview')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Screen('recruitment', 'edit')
  importPreview(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.onboarding.importPreview(user, body ?? {});
  }

  @Post('import')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Screen('recruitment', 'edit')
  importSheet(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.onboarding.importSheet(user, body ?? {});
  }
}
