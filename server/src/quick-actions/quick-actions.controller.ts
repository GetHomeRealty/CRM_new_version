import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { NoticeOfSaleService } from './notice-of-sale.service';
import { QuickSendService } from './quick-send.service';

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
export class QuickActionsController {
  constructor(
    private readonly notice: NoticeOfSaleService,
    private readonly quick: QuickSendService,
  ) {}

  /*
   * TD-012 — THE PER-RECORD CHECK NOW LIVES IN THE SERVICES, FOR EVERY ROUTE ON THIS CONTROLLER.
   *
   * It used to be here, on this one route, and nowhere else: the four write and send routes below
   * had no ownership check at all, so an agent could email another deal's financials to an address
   * of their choosing and persist edits to its Notice of Sale. A guard that one handler remembers
   * and its four neighbours forget is the failure this defect actually describes, and adding four
   * more copies of the same line would leave the fifth omission just as easy.
   *
   * Both services now assert access inside the loader every one of their methods already calls, so
   * a route cannot reach a deal unchecked — including a route added after this comment. The call
   * that used to be on this line is gone rather than duplicated, so there is one place to look.
   *
   * The class-level `@Screen` above is a SCREEN permission and answers a different question:
   * whether this person may open Transaction Management at all. Every agent holds it.
   */
  @Get('transactions/:transaction/notice-of-sale')
  showNotice(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number): Promise<Res> {
    return this.notice.show(u(user), txnId);
  }

  @Put('transactions/:transaction/notice-of-sale')
  @Screen('transactions', 'edit')
  saveNotice(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.notice.save(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/notice-of-sale/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  sendNotice(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.notice.send(u(user), txnId, body ?? {});
  }

  /*
   * TD-037 — the Cc the Deposit Receipt editor offers before Send, resolved the same way the
   * send itself resolves it. A `view` route, like `showNotice` above: it discloses nothing the
   * send would not already mail, and gating it any tighter than the form that calls it would
   * make the pre-fill unable to show what the button beside it is about to do.
   */
  @Get('transactions/:transaction/deposit-receipt/cc-suggestions')
  depositCcSuggestions(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number): Promise<string[]> {
    return this.quick.ccSuggestions(u(user), txnId);
  }

  @Post('transactions/:transaction/deposit-receipt/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  sendDeposit(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.quick.depositReceipt(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/trade-sheet/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  sendTradeSheet(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.quick.tradeSheet(u(user), txnId, body ?? {});
  }
}
