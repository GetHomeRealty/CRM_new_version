import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { TwilioVoiceService } from './twilio-voice.service';

/**
 * Browser Voice SDK support for the leads dialer. Authenticated: any signed-in user may mint a
 * token for their own browser to place a call. The token identity is scoped to the user.
 */
@Controller('twilio/voice')
@UseGuards(AuthGuard)
export class TwilioVoiceController {
  constructor(private readonly voice: TwilioVoiceService) {}

  /** Whether in-browser calling is wired up (drives the "not set up" state in the dialer). */
  @Get('status')
  status(): { configured: boolean } {
    return { configured: this.voice.configured() };
  }

  /** A short-lived Twilio Voice access token for this agent's browser. 503 if unconfigured. */
  @Get('token')
  token(@CurrentUser() user: AuthUserRecord): { token: string; identity: string; ttl: number } {
    return this.voice.mintToken(`agent-${user.id ?? 'x'}`);
  }
}
