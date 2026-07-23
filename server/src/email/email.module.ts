import { Module } from '@nestjs/common';
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
  exports: [MailerService, MailAccountService],
})
export class EmailModule {}
