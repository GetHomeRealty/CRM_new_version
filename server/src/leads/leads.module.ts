import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadActivityService } from './lead-activity.service';
import { LeadAuditService } from './lead-audit.service';
import { SmsModule } from '../sms/sms.module';
import { EmailModule } from '../email/email.module';

/**
 * Leads. Shares the `leads` table with Campaigns — this module owns the record, Campaigns
 * reads it as an audience — so neither module may change the vocabulary spellings alone.
 */
@Module({
  imports: [AuthModule, SmsModule, EmailModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadActivityService, LeadAuditService],
  exports: [LeadsService],
})
export class LeadsModule {}
