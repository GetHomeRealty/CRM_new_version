import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CrmSettingsController } from './crm-settings.controller';
import { CrmSettingsService } from './crm-settings.service';
import { CrmAdvancedEmailService } from './crm-advanced-email.service';

/**
 * CRM Settings, migrated from the CRM app.
 *
 * Mounted at `/api/crm-settings` in its own tables so Transaction Desk's existing settings
 * surfaces — company-settings, mail-accounts, email-templates — keep working untouched.
 * Overlap between the two is expected at this stage and will be reconciled later.
 */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [CrmSettingsController],
  providers: [CrmSettingsService, CrmAdvancedEmailService],
  exports: [CrmSettingsService],
})
export class CrmSettingsModule {}
