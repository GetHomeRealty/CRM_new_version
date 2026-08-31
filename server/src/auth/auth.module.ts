import { Module, type OnModuleInit } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { AccountLockoutService } from './account-lockout.service';
import { PasswordHashService } from './password-hash.service';
import { PermissionService } from './permission.service';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { ScreenGuard } from './guards/screen.guard';
import { RolePermissionStore } from '../core/role-permission.store';
import { MfaAdminController, MfaController } from './mfa/mfa.controller';
import { MfaService } from './mfa/mfa.service';
import { MfaPolicyService } from './mfa/mfa-policy.service';
import { RecoveryCodeService } from './mfa/recovery-code.service';
import { TrustedDeviceService } from './mfa/trusted-device.service';
import { EmailOtpProvider, OtpDeliveryService, SmsOtpProvider } from './mfa/otp-delivery.service';
import { AuditModule } from '../audit/audit.module';

/**
 * Authentication + authorization. Provides the Sanctum-contract session auth,
 * the PermissionService, and the reusable guards (Auth/Admin/Screen) that other
 * feature modules apply to their routes.
 */
@Module({
  /*
   * Only the audit module, which depends on nothing here.
   *
   * Mail and SMS are NOT imported, deliberately. Both already import this module for the auth
   * guards, and `EmailModule` reaches `AuthModule` again through `SettingsModule`, so importing
   * them back — with or without `forwardRef` — stops the application booting. `OtpDeliveryService`
   * resolves those two providers through `ModuleRef` instead; the reasoning is written out there,
   * and `e2e/tests/mfa.spec.ts` asserts the resolution really works against a running application.
   */
  imports: [AuditModule],
  controllers: [AuthController, MfaController, MfaAdminController],
  /*
   * `PasswordHashService` is exported because UsersModule needs it: an administrator creating an
   * account or resetting a password must hash at the same cost as every other path. It was the
   * absence of exactly that shared provider that let the two costs drift apart.
   */
  providers: [
    AuthService, AccountLockoutService, PasswordHashService, PermissionService,
    PasswordResetService,
    AuthGuard, AdminGuard, ScreenGuard,
    MfaService, MfaPolicyService, RecoveryCodeService, TrustedDeviceService,
    OtpDeliveryService, EmailOtpProvider, SmsOtpProvider,
  ],
  exports: [
    AuthService, AccountLockoutService, PasswordHashService, PermissionService,
    AuthGuard, AdminGuard, ScreenGuard,
    MfaService, MfaPolicyService,
  ],
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
