import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { Screen } from '../auth/decorators';
import { TwilioService } from './twilio.service';

/**
 * What the SPA needs to know about the SMS gateway: whether it can send, and from what number.
 *
 * Never the account SID or the auth token. The token signs every webhook, so anything that
 * leaked it would let a stranger forge delivery reports and inbound messages.
 */
@Controller('sms')
@UseGuards(AuthGuard, ScreenGuard)
export class SmsController {
  constructor(private readonly twilio: TwilioService) {}

  @Get('status')
  @Screen('lead', 'view')
  status(): { configured: boolean; from: string | null; callback_url: string | null } {
    return this.twilio.status();
  }
}
