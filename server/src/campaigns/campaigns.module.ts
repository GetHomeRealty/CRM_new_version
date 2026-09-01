import { Module } from '@nestjs/common';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { NotificationDispatcherModule } from '../notifications/notification-dispatcher.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignTrackingController } from './campaign-tracking.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignAuditService } from './campaign-audit.service';
import { CampaignResumeService } from './campaign-resume.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesController } from './campaign-templates.controller';
import { CampaignTemplatesService } from './campaign-templates.service';
import { MailDeliverabilityService } from './mail-deliverability.service';
import { LeadsModule } from '../leads/leads.module';
import { BounceIngestService } from './bounce-ingest.service';

/**
 * Controller order matters: Express matches in registration order, and CampaignsController owns
 * the greedy `campaigns/:id` route. Both the tracking controller (`campaigns/track/open`,
 * `campaigns/unsubscribe`) and the templates controller (`campaigns/templates`) must come first,
 * or their literal paths would be captured as an id — the tracking ones behind auth, which would
 * silently break every pixel in every sent email.
 */
@Module({
  // LeadsModule for the shared import engine and queue — Campaigns imports leads through the
  // same path as the Leads screen so the two cannot drift apart again.
  // CrmSettingsModule for the CRM email log: a campaign test send is a real email leaving the
  // brokerage and has to be recorded where every other one is.
  imports: [NotificationDispatcherModule, AuthModule, EmailModule, LeadsModule, CrmSettingsModule],
  controllers: [CampaignTrackingController, CampaignTemplatesController, CampaignsController],
  providers: [CampaignAuditService, CampaignResumeService, CampaignsService, CampaignAudienceService, CampaignTemplatesService, MailDeliverabilityService, BounceIngestService],
})
export class CampaignsModule {}
