import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AUTH_LIMIT } from '../../config/rate-limits';
import { AuthGuard } from '../guards/auth.guard';
import { ScreenGuard } from '../guards/screen.guard';
import { CurrentUser, Screen } from '../decorators';
import type { AuthUserRecord } from '../auth.types';
import { MfaService } from './mfa.service';
import { MfaPolicyService, type MfaPolicyView } from './mfa-policy.service';
import { RecoveryCodeService } from './recovery-code.service';
import { TrustedDeviceService } from './trusted-device.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { mfaStorageAvailable } from './mfa-crypto';
import {
  BeginOtpEnrolmentDto,
  ConfirmEnrolmentDto,
  PasswordOnlyDto,
  RemoveMethodDto,
  SetPolicyDto,
} from './mfa.dto';

/**
 * Self-service two-factor management, for the person signed in.
 *
 * EVERYTHING HERE IS BEHIND `AuthGuard`. These are settings for an account that is already
 * authenticated — the endpoints used DURING a sign-in, before there is a session, live on
 * `AuthController` instead, where the partial-session state is.
 *
 * The write endpoints take the strict `AUTH_LIMIT` rather than the generous global one, for the same
 * reason sign-in does: repetition is the attack. Confirming enrolment and removing a method both
 * check a secret, and both are worth bounding.
 */
@Controller('mfa')
@UseGuards(AuthGuard)
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly policy: MfaPolicyService,
    private readonly recovery: RecoveryCodeService,
    private readonly devices: TrustedDeviceService,
    private readonly delivery: OtpDeliveryService,
    private readonly config: ConfigService,
  ) {}

  private issuer(): string {
    // What the authenticator app shows above the code. The brokerage name if configured, so somebody
    // with several accounts can tell them apart.
    return this.config.get<string>('app.name') || 'Get Home Realty';
  }

  private me(user: AuthUserRecord | undefined): AuthUserRecord {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    return user;
  }

  /** The security screen's whole state in one call. */
  @Get()
  async status(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    const me = this.me(user);
    const methods = await this.mfa.methodsFor(me.id);
    const enrolled = methods.some((m) => m.confirmed);
    return {
      enabled: enrolled,
      methods,
      recovery_codes_remaining: await this.recovery.remaining(me.id),
      trusted_devices: await this.devices.list(me.id),
      /** Channels this deployment can actually deliver on — an unconfigured one is not offered. */
      available_channels: this.delivery.availableChannels(),
      /** False when APP_KEY is missing, which is why the authenticator option would be refused. */
      storage_available: mfaStorageAvailable(),
      obligation: await this.policy.obligationFor(me, enrolled),
    };
  }

  // ---------------------------------------------------------------- enrolment

  @Post('totp/begin')
  @HttpCode(200)
  @Throttle({ default: AUTH_LIMIT })
  async beginTotp(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    return this.mfa.beginTotpEnrolment(this.me(user), this.issuer());
  }

  @Post('otp/begin')
  @HttpCode(200)
  @Throttle({ default: AUTH_LIMIT })
  async beginOtp(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: BeginOtpEnrolmentDto,
  ): Promise<Record<string, unknown>> {
    return this.mfa.beginOtpEnrolment(this.me(user), dto.channel, dto.destination);
  }

  /**
   * Confirm enrolment and receive the recovery codes.
   *
   * The codes are in this response and nowhere else, ever. They are stored hashed, so this
   * application genuinely cannot show them a second time — which is the property that makes the
   * stored copy useless to anyone who reads the database.
   */
  @Post('confirm')
  @HttpCode(200)
  @Throttle({ default: AUTH_LIMIT })
  async confirm(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: ConfirmEnrolmentDto,
  ): Promise<{ recovery_codes: string[] }> {
    const me = this.me(user);
    return dto.type === 'totp'
      ? this.mfa.confirmTotpEnrolment(me, dto.code)
      : this.mfa.confirmOtpEnrolment(me, dto.type, dto.code);
  }

  @Post('remove')
  @HttpCode(200)
  @Throttle({ default: AUTH_LIMIT })
  async remove(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: RemoveMethodDto,
  ): Promise<{ message: string }> {
    await this.mfa.removeMethod(this.me(user), dto.type, dto.password);
    return { message: 'That method has been removed.' };
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @Throttle({ default: AUTH_LIMIT })
  async regenerate(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: PasswordOnlyDto,
  ): Promise<{ recovery_codes: string[] }> {
    return { recovery_codes: await this.mfa.regenerateRecoveryCodes(this.me(user), dto.password) };
  }

  // ---------------------------------------------------------------- trusted devices

  @Delete('devices/:id')
  @HttpCode(200)
  async revokeDevice(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    const removed = await this.devices.revoke(this.me(user).id, id);
    return { message: removed ? 'That device will be asked for a code next time.' : 'Nothing to revoke.' };
  }

  @Post('devices/revoke-all')
  @HttpCode(200)
  async revokeAllDevices(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; revoked: number }> {
    const count = await this.devices.revokeAll(this.me(user).id);
    // Including the browser making this request, so the effect is visible immediately rather than
    // at the next sign-in.
    this.devices.clearCookie(res);
    return { message: 'Every device will be asked for a code next time.', revoked: count };
  }

  /** Whether THIS browser is currently trusted — so the screen can say so. */
  @Get('devices/current')
  async currentDevice(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Req() req: Request,
  ): Promise<{ trusted: boolean }> {
    return { trusted: await this.mfa.deviceIsTrusted(req, this.me(user).id) };
  }
}

/**
 * Administration: the policy, and clearing somebody's two-factor when they are locked out.
 *
 * `AuthGuard, ScreenGuard` — BOTH, and the second one matters. `ScreenGuard` is not registered
 * globally in this application; a controller that omits it turns every `@Screen` decorator into a
 * comment. An earlier version of this class carried the decorators without the guard, which would
 * have let any signed-in agent clear an administrator's second factor and rewrite the brokerage's
 * policy. Checked against `app.module.ts` rather than assumed.
 *
 * `users` is the right screen: it is the authority that already covers creating an account and
 * resetting a password. Anyone who can reset a password can already take over an account, so
 * demanding more here would be theatre — and demanding less would not.
 */
@Controller('mfa/admin')
@UseGuards(AuthGuard, ScreenGuard)
export class MfaAdminController {
  constructor(
    private readonly mfa: MfaService,
    private readonly policy: MfaPolicyService,
  ) {}

  @Get('policies')
  @Screen('users', 'view')
  async policies(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, unknown>> {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    return { policies: await this.policy.list(user.company_id) };
  }

  @Post('policies')
  @HttpCode(200)
  @Screen('users', 'edit')
  async setPolicy(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Body() dto: SetPolicyDto,
  ): Promise<MfaPolicyView> {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    return this.policy.set(user.company_id, dto.role, dto.required, dto.grace_days ?? 7);
  }

  /**
   * Clear somebody's two-factor entirely — the way back for a lost phone and spent recovery codes.
   *
   * Audited by name, revokes every trusted device, and destroys the recovery codes. It does not
   * re-enrol anything: the person is returned to having no second factor and must set one up again,
   * which is the only state this can be certain about.
   */
  @Post('reset/:userId')
  @HttpCode(200)
  @Screen('users', 'edit')
  @Throttle({ default: AUTH_LIMIT })
  async reset(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<{ message: string }> {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    await this.mfa.adminReset(user, userId);
    return { message: 'Two-factor authentication has been cleared for that user.' };
  }
}
