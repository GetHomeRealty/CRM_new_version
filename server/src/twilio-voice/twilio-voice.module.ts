import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { TwilioVoiceService } from './twilio-voice.service';
import { TwilioVoiceController } from './twilio-voice.controller';
import { TwilioVoicePublicController } from './twilio-voice-public.controller';

/**
 * In-browser (Voice SDK) calling. Public controller first so `POST twilio/voice` is the unguarded
 * webhook rather than falling into any guarded match — Express matches in registration order.
 */
@Module({
  imports: [AuthModule, SmsModule],
  controllers: [TwilioVoicePublicController, TwilioVoiceController],
  providers: [TwilioVoiceService],
})
export class TwilioVoiceModule {}
