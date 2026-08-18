import { AreaGuard } from '../core/area.guard';
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, Sse, UseGuards } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';
import { InboxEventsService } from './inbox-events.service';
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
    private readonly events: InboxEventsService,
  ) {}

  /**
   * A live stream of "your Inbox changed", as Server-Sent Events.
   *
   * WHAT IT IS FOR. The Inbox refreshed on a browser timer, on top of the server's own IMAP poll —
   * so a message could wait for the sum of the two before appearing. `ImapIdleService` removes the
   * first delay; this removes the second, by telling the browser instead of waiting to be asked.
   *
   * IT CARRIES NO MAIL. An event says only that an account of YOURS stored new messages, and the
   * browser then refetches through `GET /api/account/inbox`, which applies every ownership and area
   * rule it already applies. So this cannot become a second way to read a message, and it does not
   * need its own authorization beyond knowing who is asking.
   *
   * SCOPED TO THE CALLER BY SHAPE. `stream()` takes the user id from the session and filters on it;
   * there is no parameter naming a user, so one cannot be pointed at somebody else's mailbox.
   *
   * NO AREA PARAMETER, deliberately. An event names the account, and the client refetches the area
   * it is showing — so a CRM tab and a Desk tab both learn that something arrived and each refreshes
   * its own view. Filtering by area here would mean this endpoint deciding which mailbox belongs to
   * which side of the product, which `InboxService` already decides and should keep deciding alone.
   */
  @Sse('stream')
  stream(@CurrentUser() user: AuthUserRecord): Observable<{ type: string; data: string }> {
    return this.events.stream(user.id ?? -1);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUserRecord,
    @Query('area') area?: string,
    @Query('unread') unread?: string,
    @Query('lead') lead?: string,
    @Query('page') page?: string,
  ): Promise<unknown> {
    /*
     * A FILTER THAT CANNOT BE HONOURED IS REFUSED, NOT DROPPED.
     *
     * `Number(lead) || undefined` turned `?lead=abc` into "no lead filter at all", so a request for
     * one lead's correspondence answered with the WHOLE mailbox — more than was asked for, reported
     * as though it were the answer. The Audit Trail had the same shape and the same fix.
     *
     * `page` is left as-is here and clamped in the service, where the offset is actually built.
     */
    if (lead !== undefined && lead !== '') {
      const n = Number(lead);
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new BadRequestException({ message: `"${lead}" is not a lead id.`, errors: { lead: ['Must be a whole number.'] } });
      }
    }
    return this.inbox.list(user.id ?? -1, parseArea(area), {
      unread: unread === '1' || unread === 'true',
      leadId: lead ? Number(lead) : undefined,
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
    /*
     * SCOPED TO THE CALLER, AND THAT IS WHAT THIS LOOKUP WAS MISSING.
     *
     * It was `findUnique({ where: { id: accountId } })` — any account, anyone's — read only to
     * decide the area. The sync itself was safe, because `ImapSyncService.syncForUser` filters
     * `{ id, user_id }`. The refusal was not: the wrong-area branch below interpolates
     * `account.from_email`, so ANY signed-in user could walk account ids from the other area and be
     * told, one at a time, which addresses colleagues have connected.
     *
     * Measured 2026-08-05 with an account belonging to somebody else:
     *   {"message":"zz-secret-…@private.test is connected under Customer Relationship Management
     *    and cannot be synced from here."}
     *
     * Filtering by `user_id` here means the only address this endpoint can ever name is the
     * caller's own — which is the whole point of that message, and costs nothing.
     */
    const account = await this.prisma.mail_accounts.findFirst({
      where: { id: accountId, user_id: user.id ?? -1 },
      select: { id: true, user_id: true, scope: true, from_email: true },
    });
    /*
     * ONE ANSWER FOR "does not exist" AND "not yours", so the reply cannot be used to tell them
     * apart — the same rule the Calendar and the Inbox's own message reads already follow. It also
     * replaces a 500: `syncForUser` signals this with a bare `throw new Error('Mail account not
     * found.')`, which Nest renders as an Internal Server Error, and that both reads as a bug to
     * whoever hits it legitimately and separates ids that reached the service from ids that did not.
     */
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
