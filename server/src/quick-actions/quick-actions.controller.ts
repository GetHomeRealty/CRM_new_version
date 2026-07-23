import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { NoticeOfSaleService } from './notice-of-sale.service';
import { QuickSendService } from './quick-send.service';

type Res = Record<string, unknown>;
const u = (x: AuthUserRecord | undefined): AuthUserRecord | null => x ?? null;

@Controller()
@UseGuards(AuthGuard)
export class QuickActionsController {
  constructor(private readonly notice: NoticeOfSaleService, private readonly quick: QuickSendService) {}

  @Get('transactions/:transaction/notice-of-sale')
  showNotice(@Param('transaction', ParseIntPipe) txnId: number): Promise<Res> {
    return this.notice.show(txnId);
  }

  @Put('transactions/:transaction/notice-of-sale')
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  saveNotice(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.notice.save(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/notice-of-sale/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  sendNotice(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.notice.send(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/deposit-receipt/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  sendDeposit(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.quick.depositReceipt(u(user), txnId, body ?? {});
  }

  @Post('transactions/:transaction/trade-sheet/send')
  @HttpCode(200)
  @Screen('transactions', 'edit')
  @UseGuards(AuthGuard, ScreenGuard)
  sendTradeSheet(@CurrentUser() user: AuthUserRecord | undefined, @Param('transaction', ParseIntPipe) txnId: number, @Body() body: Res): Promise<Res> {
    return this.quick.tradeSheet(u(user), txnId, body ?? {});
  }
}
