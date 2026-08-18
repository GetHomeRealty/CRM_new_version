import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { ClientIdentificationService } from './client-identification.service';

type Res = Record<string, unknown>;
const u = (x: AuthUserRecord | undefined): AuthUserRecord | null => x ?? null;

/*
 * EVERY ROUTE HERE IS BEHIND THE `transactions` SCREEN PERMISSION, DECLARED ONCE ON THE CLASS.
 *
 * It was declared per method, and only on the writes — so `GET /api/transactions`, the detail
 * endpoint and everything hanging off them answered to anybody with a session. The `crm` role's
 * permission map says `transactions: 'none'` and it could still read every deal in the brokerage,
 * including the commission breakdown; so could a user whose access had been deliberately revoked.
 * The navigation hid the screen and nothing else did.
 *
 * Declared on the CLASS so the default is closed: a route added later inherits `view` without
 * anybody remembering to decorate it, and a write route overrides it with `edit` — `ScreenGuard`
 * reads the handler's metadata first (`getAllAndOverride`). `ScreenGuard` also enforces module
 * access for the screen's area, so a login without Transaction Management is refused here too.
 */
@Controller()
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class ClientIdentificationController {
  constructor(private readonly ids: ClientIdentificationService) {}

  @Get('transactions/:transaction/identifications')
  show(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Query() query: Res): Promise<Res> {
    return this.ids.show(u(user), txnId, query ?? {});
  }

  @Put('transactions/:transaction/identifications')
  @Screen('transactions', 'edit')
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.ids.update(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/identifications/extract')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  extract(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.ids.extract(u(user), txnId, body ?? {});
  }
}
