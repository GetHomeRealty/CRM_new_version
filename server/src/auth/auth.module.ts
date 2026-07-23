import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { ScreenGuard } from './guards/screen.guard';

/**
 * Authentication + authorization. Provides the Sanctum-contract session auth,
 * the PermissionService, and the reusable guards (Auth/Admin/Screen) that other
 * feature modules apply to their routes.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, PermissionService, AuthGuard, AdminGuard, ScreenGuard],
  exports: [AuthService, PermissionService, AuthGuard, AdminGuard, ScreenGuard],
})
export class AuthModule {}
