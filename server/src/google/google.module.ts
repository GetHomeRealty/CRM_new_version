import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GoogleService } from './google.service';
import { GoogleStateService } from './google-state.service';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { GoogleController } from './google.controller';
import { GooglePublicController } from './google-public.controller';
import { GoogleMailController } from './google-mail.controller';
import { GmailConnectService } from './gmail-connect.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { IcalFeedService } from './ical-feed.service';
import { IcalController } from './ical.controller';

/**
 * Google Calendar OAuth + two-way sync. The public callback controller is listed first so
 * `/api/google/callback` is matched by the unguarded route, not the guarded one. Exports the sync
 * service so the Calendar module can push newly created events to Google.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [GooglePublicController, GoogleController, GoogleMailController, IcalController],
  providers: [GoogleService, GoogleStateService, GoogleConnectionService, GoogleCalendarSyncService, GmailConnectService, LaravelCryptService, IcalFeedService],
  // `GoogleConnectionService` is exported so the CRM Settings summary can ASK whether Calendar is
  // connected instead of asserting it. It used to answer from a hard-coded string.
  exports: [GoogleCalendarSyncService, GoogleService, GoogleConnectionService],
})
export class GoogleModule {}
