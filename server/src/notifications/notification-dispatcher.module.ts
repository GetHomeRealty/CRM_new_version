import { Module } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { CrmEventNotifier } from './crm-events.service';
import { NotificationPreferenceModule } from './notification-preference.module';

/**
 * The dispatcher, in its own module — for exactly the reason `NotificationPreferenceModule` is.
 *
 * Any module that raises an event needs to dispatch: calendar, transactions, inbox, chat. If the
 * dispatcher lived in `NotificationsModule` they would all have to import THAT, which pulls in
 * `TransactionsModule` for the review feed — and `NotificationsModule` already imports
 * `TransactionsModule`, so the graph closes on itself immediately. Measured, not predicted: wiring
 * the reminder sweep produced precisely that failure.
 *
 * This module deliberately depends on nothing but the preference lookup (Prisma is global, and the
 * outbound senders are resolved through `ModuleRef` — see the service for why). That is what makes
 * it safe for anything at all to import.
 */
@Module({
  imports: [NotificationPreferenceModule],
  providers: [NotificationDispatcher, CrmEventNotifier],
  exports: [NotificationDispatcher, CrmEventNotifier],
})
export class NotificationDispatcherModule {}
