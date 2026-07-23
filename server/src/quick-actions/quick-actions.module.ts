import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { QuickActionsController } from './quick-actions.controller';
import { NoticeOfSaleService } from './notice-of-sale.service';
import { QuickSendService } from './quick-send.service';

@Module({
  imports: [AuthModule, EmailModule, SettingsModule],
  controllers: [QuickActionsController],
  providers: [NoticeOfSaleService, QuickSendService],
})
export class QuickActionsModule {}
