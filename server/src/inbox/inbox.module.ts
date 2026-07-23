import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ImapSyncService } from './imap-sync.service';

/**
 * Inbound email: the IMAP poller (ImapSyncService) and the per-user reader (InboxService),
 * exposed under /api/account/inbox. Kept in its own module so the poller's lifecycle hooks and
 * the crypto dependency stay contained.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [InboxController],
  providers: [InboxService, ImapSyncService, LaravelCryptService],
  exports: [ImapSyncService],
})
export class InboxModule {}
