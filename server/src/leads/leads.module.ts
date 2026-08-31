import { Module } from '@nestjs/common';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadActivityService } from './lead-activity.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadTransferService } from './lead-transfer.service';
import { LeadRetentionService } from './lead-retention.service';
import { LeadTaskReminderService } from './lead-task-reminder.service';
import { LeadNotificationService } from './lead-notification.service';
import { LeadImportEngine } from './lead-import.engine';
import { LeadImportJobService } from './lead-import-job.service';
import { RecordingStorageService } from './recording-storage.service';
import { AiDisclosureService } from '../common/ai-disclosure.service';
import { SmsModule } from '../sms/sms.module';
import { EmailModule } from '../email/email.module';

/**
 * Leads. Shares the `leads` table with Campaigns — this module owns the record, Campaigns
 * reads it as an audience — so neither module may change the vocabulary spellings alone.
 */
@Module({
  // CrmSettingsModule for the import preflight: the import window has to be able to say whether
  // processing the file will email everybody in it, and that answer belongs to the CRM email
  // service rather than to a second copy of the rule here.
  imports: [NotificationDispatcherModule, AuthModule, SmsModule, EmailModule, CrmSettingsModule],
  controllers: [LeadsController],
  providers: [LeadRetentionService, LeadTaskReminderService, LeadsService, LeadActivityService, LeadAuditService, LeadNotificationService, LeadTransferService, LeadImportEngine, LeadImportJobService, RecordingStorageService, AiDisclosureService],
  // Campaigns imports leads through the same engine and the same queue. Exporting them is what
  // stops the two screens drifting apart again — they previously had separate implementations,
  // and only one of them de-duplicated within the uploaded file.
  exports: [LeadsService, LeadTransferService, LeadNotificationService, LeadImportEngine, LeadImportJobService, RecordingStorageService, AiDisclosureService],
})
export class LeadsModule {}
