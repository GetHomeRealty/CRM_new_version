import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CrmTeamsService } from './crm-teams.service';

/**
 * CRM Teams — CRM → Settings → Teams, and the team views behind the Leads screen and dashboard.
 *
 * Every route needs the `lead` screen, because teams are a way of owning leads. Beyond that the
 * service decides by role: administrators manage teams, team leads read their own team's report
 * and activity, and everybody else reaches only `lookup` — the teams they are in.
 *
 * Literal paths are declared BEFORE `:id`, for the same reason as in LeadsController.
 */
@Controller('crm-teams')
@UseGuards(AuthGuard, ScreenGuard)
export class CrmTeamsController {
  constructor(private readonly teams: CrmTeamsService) {}

  /** Teams, members and flags for the lead filters, the lead form and the Team & Assignment card. */
  @Get('lookup')
  @Screen('lead', 'view')
  lookup(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.teams.lookup(user);
  }

  /** The team cards on the CRM dashboard. */
  @Get('dashboard')
  @Screen('lead', 'view')
  dashboard(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.teams.dashboard(user);
  }

  /** Team report: owner, handler, totals and conversion by team and by agent. */
  @Get('report')
  @Screen('lead', 'view')
  report(@CurrentUser() user: AuthUserRecord, @Query('teamId') teamId?: string): Promise<unknown> {
    return this.teams.report(user, teamId);
  }

  @Get()
  @Screen('lead', 'view')
  list(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.teams.list(user);
  }

  @Post()
  @HttpCode(201)
  @Screen('lead', 'edit')
  create(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.teams.create(body ?? {}, user);
  }

  @Get(':id/activity')
  @Screen('lead', 'view')
  activity(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Query('limit') limit?: string): Promise<unknown> {
    return this.teams.activity(id, user, limit);
  }

  @Put(':id')
  @Screen('lead', 'edit')
  update(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.teams.update(id, body ?? {}, user);
  }

  @Delete(':id')
  @Screen('lead', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.teams.remove(id, user);
  }

  @Post(':id/members')
  @HttpCode(200)
  @Screen('lead', 'edit')
  addMember(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: { user_id?: unknown }): Promise<unknown> {
    return this.teams.addMember(id, Number(body?.user_id), user);
  }

  @Delete(':id/members/:userId')
  @Screen('lead', 'edit')
  removeMember(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<unknown> {
    return this.teams.removeMember(id, userId, user);
  }
}
