import { ProviderSentService } from './provider-sent.service';
import { ProviderSentController } from './provider-sent.controller';
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
import { EmailModule } from '../email/email.module';
import { InboxReplyController } from './inbox-reply.controller';
import { InboxReplyService } from './inbox-reply.service';
import { MailArchiveController } from './mail-archive.controller';

/**
 * Inbound email: the IMAP poller (ImapSyncService) and the per-user reader (InboxService),
 * exposed under /api/account/inbox. Kept in its own module so the poller's lifecycle hooks and
 * the crypto dependency stay contained.
 */
@Module({
  imports: [NotificationDispatcherModule, AuthModule, PrismaModule, GoogleModule, EmailModule],
  controllers: [InboxController, InboxReplyController, MailArchiveController, ProviderSentController],
  providers: [ProviderSentService, InboxService, InboxReplyService, ImapSyncService, MailRetentionService, LaravelCryptService],
  exports: [ImapSyncService, MailRetentionService],
})
export class InboxModule {}
