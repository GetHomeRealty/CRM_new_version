import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndiaSettingsController } from './india-settings.controller';
import { IndiaSettingsService } from './india-settings.service';

/** India invoicing settings (19 Oct 2026). Global so the invoice code can read them. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [IndiaSettingsController],
  providers: [IndiaSettingsService],
  exports: [IndiaSettingsService],
})
export class IndiaModule {}
