import { AreaGuard } from '../core/area.guard';
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AREA_LABEL, parseArea } from '../common/domain';

/**
 * A user's own inbox — the mail pulled from their connected accounts. Guarded by authentication
 * only and scoped to the signed-in user; nobody reads anyone else's mail.
 *
 * Each request also names its area, and the service filters by the connected account's scope, so
 * the CRM Inbox and the Transaction Desk Inbox are two views over separate sets of accounts. The
 * area comes from the query string rather than a header so a link can address one inbox directly;
 * an absent or unrecognised value falls back to the Transaction Desk rather than erroring, which
 * keeps older clients working.
 */
@Controller('account/inbox')
@UseGuards(AuthGuard, AreaGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly imap: ImapSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserRecord,
    @Query('area') area?: string,
    @Query('unread') unread?: string,
    @Query('lead') lead?: string,
    @Query('page') page?: string,
  ): Promise<unknown> {
    return this.inbox.list(user.id ?? -1, parseArea(area), {
      unread: unread === '1' || unread === 'true',
      leadId: Number(lead) || undefined,
      page: Number(page) || 1,
    });
  }

  /**
   * Pull new mail now for one of the user's accounts, rather than waiting for the poll.
   *
   * The account must belong to the area the request came from. Without that check the Transaction
   * Desk could trigger a sync on a CRM account — the mail would land where the caller cannot see
   * it, and a failure would be reported on the wrong screen.
   */
  @Post('sync/:accountId')
  async sync(
    @CurrentUser() user: AuthUserRecord,
    @Param('accountId', ParseIntPipe) accountId: number,
    @Query('area') area?: string,
  ): Promise<unknown> {
    const want = parseArea(area);
    const account = await this.prisma.mail_accounts.findUnique({
      where: { id: accountId },
      select: { id: true, user_id: true, scope: true, from_email: true },
    });
    if (!account) throw new NotFoundException({ message: 'That email account no longer exists.' });
    // A null scope pre-dates the split and is reachable from both areas, as everywhere else.
    if (account.scope && account.scope !== want) {
      throw new ForbiddenException({
        message: `${account.from_email} is connected under ${AREA_LABEL[account.scope === 'crm' ? 'crm' : 'desk']} and cannot be synced from here.`,
      });
    }

    const result = await this.imap.syncForUser(user.id ?? -1, accountId);
    return {
      ...result,
      message: result.error
        ? result.error
        : `Synced ${result.fetched} new message${result.fetched === 1 ? '' : 's'}${result.matched ? `, ${result.matched} matched to a lead` : ''}.`,
    };
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.inbox.get(user.id ?? -1, parseArea(area), id);
  }

  @Put(':id/seen')
  markSeen(
    @CurrentUser() user: AuthUserRecord,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Query('area') area?: string,
  ): Promise<unknown> {
    return this.inbox.markSeen(user.id ?? -1, parseArea(area), id, body?.seen !== false);
  }
}
