import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoController } from './user-photo.controller';
import { UserPhotoService } from './user-photo.service';
import { UserOnboardingService } from './user-onboarding.service';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [AuthModule, EmailModule, SettingsModule],
  // UsersController is administrators-only; UserPhotoController is not, because every user
  // manages their own picture. It applies the self-or-admin rule per request instead.
  controllers: [UsersController, UserPhotoController],
  providers: [UsersService, UserPhotoService, UserOnboardingService],
})
export class UsersModule {}
