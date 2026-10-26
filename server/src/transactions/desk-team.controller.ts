import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DeskTeamService } from './desk-team.service';

/**
 * Documentation / Accounting teams on the Desk (25 Oct 2026) - see DeskTeamService. Transactions view
 * opens the door; the service decides who may do what. The handler write sits under
 * /api/transactions/:id so the country check refuses a deal of the other country.
 */
@Controller()
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class DeskTeamController {
  constructor(private readonly team: DeskTeamService) {}

  @Get('desk-team/handler-options')
  options(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.team.options(user);
  }

  @Get('desk-team/mine')
  mine(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.team.mine(user);
  }

  @Get('desk-team/history/:user')
  history(@CurrentUser() user: AuthUserRecord, @Param('user', ParseIntPipe) memberId: number): Promise<unknown> {
    return this.team.history(user, memberId);
  }

  @Put('transactions/:id/handlers')
  setHandler(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.team.setHandler(user, id, body ?? {});
  }
}
