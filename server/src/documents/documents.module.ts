import { Module } from '@nestjs/common';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { DocumentReminderController } from './document-reminder.controller';
import { DocumentReminderService } from './document-reminder.service';
import { DocumentsController } from './documents.controller';
import { ValidFileReplacementService } from './valid-file-replacement.service';
import { ChecklistActionsService } from './checklist-actions.service';
import { DocumentLifecycleService } from './document-lifecycle.service';
import { ValidationAttachmentService } from './validation-attachment.service';
import { DocumentReviewService } from './document-review.service';
import { DocumentsService } from './documents.service';
import { DocumentDefaultsService } from './document-defaults.service';
import { DocsValidationService } from './docs-validation.service';
import { DocumentMailService } from './document-mail.service';

@Module({
  imports: [NotificationDispatcherModule, AuthModule, EmailModule, SettingsModule],
  controllers: [DocumentReminderController, DocumentsController],
  providers: [DocumentReminderService, ValidFileReplacementService, ChecklistActionsService, DocumentLifecycleService, ValidationAttachmentService, DocumentReviewService, DocumentsService, DocumentDefaultsService, DocsValidationService, DocumentMailService],
})
export class DocumentsModule {}
