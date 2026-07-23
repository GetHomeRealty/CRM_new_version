import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { ClientIdentificationService } from './client-identification.service';

type Res = Record<string, unknown>;
const u = (x: AuthUserRecord | undefined): AuthUserRecord | null => x ?? null;

@Controller()
@UseGuards(AuthGuard)
export class ClientIdentificationController {
  constructor(private readonly ids: ClientIdentificationService) {}

  @Get('transactions/:transaction/identifications')
  show(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Query() query: Res): Promise<Res> {
    return this.ids.show(u(user), txnId, query ?? {});
  }

  @Put('transactions/:transaction/identifications')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.ids.update(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/identifications/extract')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  extract(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.ids.extract(u(user), txnId, body ?? {});
  }
}
