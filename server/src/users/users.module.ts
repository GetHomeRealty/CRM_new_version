import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoController } from './user-photo.controller';
import { UserPhotoService } from './user-photo.service';
import { UserOnboardingService } from './user-onboarding.service';
import { OffboardingService } from './offboarding.service';
import { UserRenameService } from './user-rename.service';
import { CommissionModule } from '../transactions/commission.module';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { MetaModule } from '../meta/meta.module';
import { LeadsModule } from '../leads/leads.module';
import { RolesController } from '../core/roles.controller';

@Module({
  // CommissionModule for the report refresh after a rename (TD-190); it imports nothing from here.
  imports: [AuthModule, EmailModule, SettingsModule, MetaModule, LeadsModule, CommissionModule],
  // UsersController is administrators-only; UserPhotoController is not, because every user
  // manages their own picture. It applies the self-or-admin rule per request instead.
  // RolesController lives here rather than in CoreModule: it needs AuthGuard, which needs
  // AuthService, and AuthModule already depends on CoreModule — importing it back would be a
  // cycle. Roles also belong beside the users they are assigned to.
  controllers: [UsersController, UserPhotoController, RolesController],
  providers: [UsersService, UserPhotoService, UserOnboardingService, OffboardingService, UserRenameService],
})
export class UsersModule {}
