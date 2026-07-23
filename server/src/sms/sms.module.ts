import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TwilioService } from './twilio.service';
import { SmsInboundService } from './sms-inbound.service';
import { SmsController } from './sms.controller';
import { SmsPublicController } from './sms-public.controller';

/**
 * SMS gateway. Exports TwilioService so the Leads module can send through it without depending
 * on Twilio directly — a different provider would be swapped in here alone.
 *
 * The public controller is listed first so `sms/twilio/*` is matched by the unguarded webhook
 * routes rather than falling into the guarded one. Express matches in registration order.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SmsPublicController, SmsController],
  providers: [TwilioService, SmsInboundService],
  exports: [TwilioService],
})
export class SmsModule {}
