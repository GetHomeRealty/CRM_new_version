import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleModule } from '../google/google.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';
import { EventReminderService } from './event-reminder.service';
import { CalendarAnalyticsService } from './calendar-analytics.service';
import { EventSuggestionsService } from './event-suggestions.service';
import { WebPushService } from './web-push.service';
import { EventReminderSchedulerService } from './event-reminder-scheduler.service';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';

// AuditService comes from the global AuditModule.
// TodosController is registered first so `calendar/todos` is matched before CalendarController's
// routes — its own paths are all under `calendar/events`, but ordering keeps that guaranteed.
@Module({
  imports: [AuthModule, GoogleModule, EmailModule, SettingsModule],
  controllers: [TodosController, CalendarController],
  providers: [CalendarService, TodosService, CalendarAnalyticsService, EventSuggestionsService, WebPushService, EventReminderService, EventReminderSchedulerService],
})
export class CalendarModule {}
