import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { AccountController } from './account.controller';

/**
 * Per-user Settings, available to everyone. Reuses CrmSettingsService (profile, preferences,
 * integrations) and MailAccountService / MailerService (personal mail accounts) rather than
 * duplicating them — this module only re-exposes them behind an auth-only, self-scoped
 * controller, distinct from the admin `settings` screen.
 */
@Module({
  imports: [AuthModule, EmailModule, CrmSettingsModule],
  controllers: [AccountController],
})
export class AccountModule {}
