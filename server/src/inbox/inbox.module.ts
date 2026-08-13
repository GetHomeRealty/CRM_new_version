import { Module } from '@nestjs/common';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { GoogleModule } from '../google/google.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';
import { MailRetentionService } from './mail-retention.service';

/**
 * Inbound email: the IMAP poller (ImapSyncService) and the per-user reader (InboxService),
 * exposed under /api/account/inbox. Kept in its own module so the poller's lifecycle hooks and
 * the crypto dependency stay contained.
 */
@Module({
  imports: [NotificationDispatcherModule, AuthModule, PrismaModule, GoogleModule],
  controllers: [InboxController],
  providers: [InboxService, ImapSyncService, MailRetentionService, LaravelCryptService],
  exports: [ImapSyncService, MailRetentionService],
})
export class InboxModule {}
