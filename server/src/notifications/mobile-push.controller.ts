import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MobilePushService } from './mobile-push.service';

@Controller('api/mobile/push')
@UseGuards(AuthGuard)
export class MobilePushController {
  constructor(private readonly push: MobilePushService) {}
  @Get() status(@CurrentUser() user: AuthUserRecord, @Req() req: Request) { return this.push.status(user.id, req.mobileSessionSid); }
  @Post() register(@CurrentUser() user: AuthUserRecord, @Req() req: Request, @Body() body: Record<string, unknown>) { return this.push.register(user.id, req.mobileSessionSid, body ?? {}); }
  @Delete() remove(@CurrentUser() user: AuthUserRecord, @Req() req: Request) { return this.push.remove(user.id, req.mobileSessionSid); }
}
