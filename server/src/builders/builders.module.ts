import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { BuildersController } from './builders.controller';
import { BuildersService } from './builders.service';
import { BuilderAgreementReminderService } from './builder-agreement-reminder.service';

/** India builder database (stage 3, 17 Oct 2026). */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [BuildersController],
  providers: [BuildersService, BuilderAgreementReminderService],
})
export class BuildersModule {}
