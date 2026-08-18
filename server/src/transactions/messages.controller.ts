import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MessagesService, type ChatMessage } from './messages.service';
import { PostMessageDto } from './dto/post-message.dto';
import type { ResourceUser } from './transaction.resource';
import { MentionService, type MentionCandidate } from './mention.service';

const toResourceUser = (u: AuthUserRecord | undefined): ResourceUser | null =>
  u ? { id: u.id, role: u.role, name: u.name } : null;

/*
 * Behind the `transactions` screen permission, declared once on the class — same reasoning as
 * `TransactionsController`: these routes hang off a deal, so a role that may not open the
 * Transactions screen must not reach them either. Reading needs `view`; the services apply their
 * own role and ownership rules on top.
 */
@Controller('transactions')
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly mentions: MentionService,
  ) {}

  /**
   * People the author may mention on this deal — what the autocomplete offers after `@`.
   *
   * Scoped to those who can already open the transaction, so the list cannot be used to discover who
   * else exists in the brokerage. `MentionService` applies the same access rule the chat itself does.
   */
  @Get(':transaction/mention-candidates')
  candidates(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Query('q') q?: string,
  ): Promise<MentionCandidate[]> {
    return this.mentions.candidates(toResourceUser(user), id, q);
  }

  @Get(':transaction/messages')
  list(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
  ): Promise<ChatMessage[]> {
    return this.messages.list(id, toResourceUser(user));
  }

  @Post(':transaction/messages')
  @HttpCode(200)
  post(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) id: number,
    @Body() dto: PostMessageDto,
  ): Promise<ChatMessage[]> {
    return this.messages.post(id, toResourceUser(user), dto.body, dto.mentions ?? []);
  }
}
