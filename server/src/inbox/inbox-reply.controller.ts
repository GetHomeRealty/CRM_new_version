import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AreaGuard } from '../core/area.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { isArea } from '../common/domain';
import { InboxReplyService } from './inbox-reply.service';
import { InboxService } from './inbox.service';

@Controller('account/inbox-replies')
@UseGuards(AuthGuard, AreaGuard)
export class InboxReplyController {
  constructor(private readonly replies: InboxReplyService, private readonly inbox: InboxService) {}

  @Get('compose-context')
  async composeContext(@CurrentUser() user: AuthUserRecord, @Query('area') area?: string) {
    if (!isArea(area)) throw new BadRequestException('An explicit CRM or Desk area is required.');
    const { account_id: _accountId, ...context } = await this.inbox.composeContext(user.id ?? -1, area);
    return context;
  }

  @Post(':messageId')
  submit(@CurrentUser() user: AuthUserRecord, @Param('messageId', ParseIntPipe) messageId: number, @Body() body: unknown, @Query('area') area?: string) {
    if (!isArea(area)) throw new BadRequestException('An explicit CRM or Desk area is required.');
    return this.replies.submit(user.id ?? -1, area, messageId, body);
  }

  @Get('submissions/:key')
  recover(@CurrentUser() user: AuthUserRecord, @Param('key') key: string, @Query('area') area?: string) {
    if (!isArea(area)) throw new BadRequestException('An explicit CRM or Desk area is required.');
    return this.replies.recover(user.id ?? -1, key);
  }
}
