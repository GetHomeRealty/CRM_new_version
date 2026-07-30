import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoController } from './user-photo.controller';
import { UserPhotoService } from './user-photo.service';
import { UserOnboardingService } from './user-onboarding.service';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';
import { RolesController } from '../core/roles.controller';

@Module({
  imports: [AuthModule, EmailModule, SettingsModule],
  // UsersController is administrators-only; UserPhotoController is not, because every user
  // manages their own picture. It applies the self-or-admin rule per request instead.
  // RolesController lives here rather than in CoreModule: it needs AuthGuard, which needs
  // AuthService, and AuthModule already depends on CoreModule — importing it back would be a
  // cycle. Roles also belong beside the users they are assigned to.
  controllers: [UsersController, UserPhotoController, RolesController],
  providers: [UsersService, UserPhotoService, UserOnboardingService],
})
export class UsersModule {}
