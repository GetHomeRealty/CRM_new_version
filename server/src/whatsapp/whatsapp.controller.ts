import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { WhatsAppRotationService } from './whatsapp-rotation.service';

/**
 * CRM → Settings → WhatsApp Rotation. Behind the `lead` screen, because the rota decides who
 * receives leads; beyond that the service admits administrators only, like Settings → Teams.
 */
@Controller('whatsapp/rotation')
@UseGuards(AuthGuard, ScreenGuard)
export class WhatsAppController {
  constructor(private readonly rotation: WhatsAppRotationService) {}

  @Get()
  @Screen('lead', 'view')
  view(@CurrentUser() user: AuthUserRecord): Promise<unknown> {
    return this.rotation.view(user);
  }

  @Put()
  @Screen('lead', 'edit')
  save(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.rotation.save(body ?? {}, user);
  }
}
