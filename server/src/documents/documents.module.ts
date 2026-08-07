import { Module } from '@nestjs/common';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentDefaultsService } from './document-defaults.service';
import { DocsValidationService } from './docs-validation.service';
import { DocumentMailService } from './document-mail.service';

@Module({
  imports: [NotificationDispatcherModule, AuthModule, EmailModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentDefaultsService, DocsValidationService, DocumentMailService],
})
export class DocumentsModule {}
