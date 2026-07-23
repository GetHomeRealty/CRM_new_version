import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MessagesService, type ChatMessage } from './messages.service';
import { PostMessageDto } from './dto/post-message.dto';
import type { ResourceUser } from './transaction.resource';

const toResourceUser = (u: AuthUserRecord | undefined): ResourceUser | null =>
  u ? { id: u.id, role: u.role, name: u.name } : null;

@Controller('transactions')
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

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
    return this.messages.post(id, toResourceUser(user), dto.body);
  }
}
