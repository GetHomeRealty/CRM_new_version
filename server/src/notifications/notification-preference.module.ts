import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationPreferenceController } from './notification-preference.controller';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * Kept as its own module rather than folded into NotificationsModule, which pulls in
 * TransactionsModule for the review feed. Anything that sends push needs to ask about
 * preferences, and making the calendar depend on the transactions graph to do so would be a
 * cycle waiting to happen. This has no imports beyond auth — PrismaModule is global.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationPreferenceController],
  providers: [NotificationPreferenceService],
  exports: [NotificationPreferenceService],
})
export class NotificationPreferenceModule {}
