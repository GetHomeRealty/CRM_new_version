import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { WhatsAppPublicController } from './whatsapp-public.controller';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppIntakeService } from './whatsapp-intake.service';
import { WhatsAppRotationService } from './whatsapp-rotation.service';

/**
 * WhatsApp agent intake: incoming WhatsApp Cloud API messages become CRM leads, assigned
 * automatically to whoever is on duty in the support rotation (CRM → Settings → WhatsApp Rotation).
 *
 * The public controller is listed first so `whatsapp/webhook` is matched by the unguarded webhook
 * route rather than the guarded settings one. Express matches in registration order.
 */
@Module({
  imports: [PrismaModule, AuthModule, NotificationDispatcherModule],
  controllers: [WhatsAppPublicController, WhatsAppController],
  providers: [WhatsAppIntakeService, WhatsAppRotationService],
  exports: [WhatsAppIntakeService, WhatsAppRotationService],
})
export class WhatsAppModule {}
