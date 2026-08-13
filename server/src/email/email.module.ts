import { Module, type OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailController } from './email.controller';
import { MailAccountService } from './mail-account.service';
import { EmailTemplateService } from './email-template.service';
import { MailerService } from './mailer.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [EmailController],
  providers: [MailAccountService, EmailTemplateService, MailerService, LaravelCryptService],
  // `EmailTemplateService` is exported so CRM → Settings → Communications can edit and preview CRM
  // templates through the SAME service the Transaction Desk screen uses, rather than growing a
  // second implementation of template editing that would be free to drift from this one. Purely
  // additive: nothing about what this module provides to Desk changes.
  exports: [MailerService, MailAccountService, EmailTemplateService],
})
export class EmailModule implements OnModuleInit {
  constructor(private readonly mailer: MailerService) {}

  /**
   * Say where mail is going, once, at boot.
   *
   * Outside production it is diverted to a sink by default, and a safety default nobody can see is
   * how somebody loses an afternoon to an email that was never going to arrive.
   */
  onModuleInit(): void {
    this.mailer.announceRedirect();
  }
}
