import { Module, type OnModuleInit } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountLockoutService } from './account-lockout.service';
import { PermissionService } from './permission.service';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { ScreenGuard } from './guards/screen.guard';
import { RolePermissionStore } from '../core/role-permission.store';

/**
 * Authentication + authorization. Provides the Sanctum-contract session auth,
 * the PermissionService, and the reusable guards (Auth/Admin/Screen) that other
 * feature modules apply to their routes.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AccountLockoutService, PermissionService, AuthGuard, AdminGuard, ScreenGuard],
  exports: [AuthService, AccountLockoutService, PermissionService, AuthGuard, AdminGuard, ScreenGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(
    private readonly permissions: PermissionService,
    private readonly store: RolePermissionStore,
  ) {}

  /**
   * Point PermissionService at the database-backed role defaults.
   *
   * Done here rather than in the Core Platform module because PermissionService is provided by THIS
   * module — Core cannot inject it without importing Auth, and Auth already depends on Core through
   * the global store, which is a cycle. The store is global, so it is visible here; PermissionService
   * is local, so it is visible here too. This is the one place both are.
   *
   * PermissionService keeps its compiled defaults as the fallback, so it remains constructible and
   * correct on its own — in a test, or if this wiring is ever removed.
   */
  onModuleInit(): void {
    this.permissions.useStore(this.store);
  }
}
