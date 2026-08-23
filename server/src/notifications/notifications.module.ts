import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationCenterService } from './notification-center.service';
import { NotificationDispatcherModule } from './notification-dispatcher.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { NotificationPreferenceModule } from './notification-preference.module';
import { NotificationEventsService } from './notification-events.service';

@Module({
  // TransactionsModule exports TransactionReviewService, which owns the agent's review feed.
  /*
   * NotificationPreferenceModule for the dispatcher: it owns the preference lookup. Deliberately a
   * separate module — it pulls in nothing but auth, so anything that sends can ask about preferences
   * without dragging in the transactions graph. See its own header for why.
   */
  imports: [AuthModule, TransactionsModule, NotificationPreferenceModule, NotificationDispatcherModule],
  controllers: [NotificationsController],
  providers: [NotificationEventsService, NotificationCenterService, NotificationsService],
})
export class NotificationsModule {}
