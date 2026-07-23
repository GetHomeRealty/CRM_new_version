import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';

/**
 * A user's own inbox — the mail pulled from their connected accounts. Guarded by authentication
 * only and scoped to the signed-in user; nobody reads anyone else's mail.
 */
@Controller('account/inbox')
@UseGuards(AuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService, private readonly imap: ImapSyncService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserRecord,
    @Query('unread') unread?: string,
    @Query('lead') lead?: string,
    @Query('page') page?: string,
  ): Promise<unknown> {
    return this.inbox.list(user.id ?? -1, {
      unread: unread === '1' || unread === 'true',
      leadId: Number(lead) || undefined,
      page: Number(page) || 1,
    });
  }

  /** Pull new mail now for one of the user's accounts, rather than waiting for the poll. */
  @Post('sync/:accountId')
  async sync(@CurrentUser() user: AuthUserRecord, @Param('accountId', ParseIntPipe) accountId: number): Promise<unknown> {
    const result = await this.imap.syncForUser(user.id ?? -1, accountId);
    return {
      ...result,
      message: result.error
        ? result.error
        : `Synced ${result.fetched} new message${result.fetched === 1 ? '' : 's'}${result.matched ? `, ${result.matched} matched to a lead` : ''}.`,
    };
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.inbox.get(user.id ?? -1, id);
  }

  @Put(':id/seen')
  markSeen(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.inbox.markSeen(user.id ?? -1, id, body?.seen !== false);
  }
}
