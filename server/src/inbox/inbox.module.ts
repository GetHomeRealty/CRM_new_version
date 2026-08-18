import { Module } from '@nestjs/common';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { GoogleModule } from '../google/google.module';
import { EmailModule } from '../email/email.module';
import { InboxController } from './inbox.controller';
import { MailboxController } from './mailbox.controller';
import { MailboxService } from './mailbox.service';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';
import { ImapIdleService } from './imap-idle.service';
import { InboxEventsService } from './inbox-events.service';
import { MailRetentionService } from './mail-retention.service';

/**
 * Mail for one person: the IMAP poller (`ImapSyncService`), the read-only list (`InboxService`,
 * under /api/account/inbox) and the writable mailbox (`MailboxService`, under
 * /api/account/mailbox) — compose, reply, forward, drafts, sent, search, archive and trash.
 *
 * Kept in its own module so the poller's lifecycle hooks and the crypto dependency stay contained.
 * Both read paths and the write path scope by user id and by the AREA's accounts, which is what
 * keeps the CRM and Transaction Desk mailboxes separate.
 */
@Module({
  // EmailModule exports MailerService — the writable inbox sends through the SAME single dispatch
  // point every other outgoing message uses, so MAIL_REDIRECT_TO and the retry policy apply here too.
  imports: [NotificationDispatcherModule, AuthModule, PrismaModule, GoogleModule, EmailModule],
  controllers: [InboxController, MailboxController],
  providers: [InboxService, MailboxService, ImapSyncService, ImapIdleService, InboxEventsService, MailRetentionService, LaravelCryptService],
  exports: [ImapSyncService, ImapIdleService, InboxEventsService, MailRetentionService],
})
export class InboxModule {}
