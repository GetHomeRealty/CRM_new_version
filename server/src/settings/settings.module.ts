import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompanySettingsController } from './company-settings.controller';
import { CompanySettingsService } from './company-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [CompanySettingsController],
  providers: [CompanySettingsService],
  exports: [CompanySettingsService],
})
export class SettingsModule {}
