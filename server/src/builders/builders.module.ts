import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { BuildersController } from './builders.controller';
import { BuildersService } from './builders.service';
import { BuilderAgreementReminderService } from './builder-agreement-reminder.service';
import { BuilderProjectsController } from './builder-projects.controller';
import { BuilderProjectsService } from './builder-projects.service';

/** India builder database (stage 3, 17 Oct 2026): builders, their agreements and their projects. */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [BuildersController, BuilderProjectsController],
  providers: [BuildersService, BuilderProjectsService, BuilderAgreementReminderService],
  exports: [BuilderProjectsService],
})
export class BuildersModule {}
