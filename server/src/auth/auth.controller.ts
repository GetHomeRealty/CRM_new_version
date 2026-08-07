import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AUTH_LIMIT } from '../config/rate-limits';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { CurrentUser } from './decorators';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import type { AuthPayload, AuthUserRecord } from './auth.types';
import { throwValidation } from '../common/laravel-exceptions';
import { MfaService, type MfaChallengeView } from './mfa/mfa.service';
import { MfaPolicyService, type MfaObligation } from './mfa/mfa-policy.service';
import { TrustedDeviceService } from './mfa/trusted-device.service';
import { ChallengeDto, SendChallengeCodeDto } from './mfa/mfa.dto';

import { setCompanyId } from '../core/tenant-context';

/**
 * What `POST /api/login` answers with.
 *
 * Two shapes, and the client tells them apart by `mfa_required`. A challenge carries NO user
 * payload — not a name, not a role, not a permission map — because at that point the caller has
 * proved a password and nothing else, and the payload is the thing being protected.
 */
export type LoginOutcome =
  | { mfa_required: true; challenge: MfaChallengeView }
  | { user: AuthPayload; mfa: MfaObligation };

@Controller()
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly mfa: MfaService,
    private readonly policy: MfaPolicyService,
    private readonly devices: TrustedDeviceService,
  ) {}

  /**
   * How long a half-finished sign-in stays answerable.
   *
   * Short on purpose: a pending session is a password already proved. Ten minutes is more than
   * enough to fetch a phone, open an app and type six digits, and short enough that a browser left
   * at the challenge screen is not half-authenticated for the rest of the day.
   */
  static readonly MFA_PENDING_MINUTES = 10;

  private cookieOpts(): AppConfig['session'] {
    return this.config.get<AppConfig['session']>('session') as AppConfig['session'];
  }

  /**
   * Mint a CSRF token, store it on the session and hand the SPA its readable copy.
   *
   * Shared by the Sanctum endpoint and by sign-in, so the two can never drift into issuing a cookie
   * whose counterpart is not on the session.
   */
  private issueCsrfToken(req: Request, res: Response): void {
    const s = this.cookieOpts();
    const token = randomBytes(20).toString('hex');
    req.session.csrfToken = token;
    res.cookie('XSRF-TOKEN', token, {
      httpOnly: false, // readable by the SPA (axios reads it to set the header)
      secure: s.secure,
      sameSite: s.sameSite,
      domain: s.domain,
      path: '/',
      maxAge: s.lifetimeMinutes * 60 * 1000,
    });
  }

  /**
   * Adopt an authenticated identity onto a BRAND NEW session identifier.
   *
   * WHY THE REGENERATION. `GET /sanctum/csrf-cookie` writes to the session, so an anonymous visitor
   * already holds a `laravel_session` cookie before they have typed anything. Sign-in used to set
   * `userId` straight onto that same session — the comment on the line even claimed a regeneration
   * that was never there — which meant the identifier a visitor arrived with became the identifier
   * of an authenticated user.
   *
   * That is session fixation, and it is exploitable without ever learning a password: plant a known
   * session cookie in the victim's browser — from a sibling subdomain, an XSS anywhere on the
   * origin, or a shared machine — then wait for them to sign in. The planted cookie is now theirs.
   * Confirmed against the running API before this was written: the pre-login cookie answered 200 on
   * `GET /api/user` after the victim authenticated.
   *
   * `regenerate()` destroys the old record and starts a new one, so the planted identifier is left
   * pointing at nothing.
   *
   * WHY THE CSRF TOKEN IS RE-ISSUED RATHER THAN CARRIED ACROSS. Regeneration empties the session,
   * and the CSRF guard reads its counterpart from there — carrying the old token over would work,
   * but it would also keep a token minted for an anonymous session alive across a privilege change.
   * A fresh one costs nothing here and rotates both halves of the pair at the same boundary. The
   * browser stores the new cookie from this very response, and axios reads it per request, so the
   * next write carries the new value with no extra round trip.
   */
  private async startAuthenticatedSession(
    req: Request,
    res: Response,
    userId: number,
    remember = false,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.userId = userId;
    if (remember) {
      // Keep the "remember me" session alive for 60 days. Set after regeneration — a new session
      // starts from the configured default, so setting it earlier would be discarded.
      req.session.cookie.maxAge = 60 * 24 * 60 * 60 * 1000;
    }
    this.issueCsrfToken(req, res);

    // Saved explicitly rather than left to the end of the response: the new record must exist in
    // the store before the caller is told it is signed in.
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Sanctum CSRF-cookie endpoint. Served at the root (outside the /api prefix),
   * matching the frontend's `GET /sanctum/csrf-cookie`. Issues an XSRF-TOKEN
   * cookie tied to the session; the SPA echoes it as X-XSRF-TOKEN.
   */
  @Get('sanctum/csrf-cookie')
  csrfCookie(@Req() req: Request, @Res() res: Response): void {
    this.issueCsrfToken(req, res);
    res.status(204).send();
  }

  /**
   * Registration and sign-in are the endpoints where repetition IS the attack, so both take the
   * strict limit instead of the generous global one. It overrides the single global bucket for
   * these routes only — a second bucket declared in AppModule would apply to the entire API and
   * turn the eleventh request of any kind into a 429.
   */
  @Post('register')
  @Throttle({ default: AUTH_LIMIT })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthPayload }> {
    const user = await this.auth.register(dto.name, dto.email, dto.password, dto.password_confirmation);
    await this.startAuthenticatedSession(req, res, user.id);
    // Bootstrap registration creates the very first account, so there is no guard and no tenant in
    // context — same as login, and the payload reads tenant-owned rows.
    setCompanyId(user.company_id);
    return { user: await this.auth.payloadFor(user) };
  }

  @Post('login')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginOutcome> {
    const user = await this.auth.login(dto.username, dto.password);

    /*
     * THE PASSWORD IS NOT THE END OF SIGN-IN ANY MORE.
     *
     * If this person holds a confirmed second factor, and this browser is not one they have already
     * trusted, no session is established here. Instead the session carries only `mfaPendingUserId` —
     * a marker that the password was right and nothing else. `AuthGuard` reads `userId`, which is
     * still absent, so a pending session reaches no endpoint in the application.
     *
     * The pending marker is deliberately NOT a session the way a signed-in one is: it expires on its
     * own (`mfaPendingUntil`), and answering the challenge regenerates the identifier again, so the
     * half-authenticated cookie cannot become the authenticated one.
     */
    if (await this.mfa.isEnabled(user.id) && !(await this.mfa.deviceIsTrusted(req, user.id))) {
      await this.startPendingSession(req, user.id);
      setCompanyId(user.company_id);
      const view = await this.mfa.challengeView(user.id);
      // A code is sent straight away only when there is nothing else to try — somebody holding an
      // authenticator app should not also be texted every time they sign in.
      if (view.preferred === 'email' || view.preferred === 'sms') {
        await this.mfa.sendChallengeCode(user.id, view.preferred);
      }
      return { mfa_required: true, challenge: view };
    }

    await this.startAuthenticatedSession(req, res, user.id, dto.remember === true);
    // Sign-in is the one authenticated action AuthGuard never sees, so nothing has named the tenant
    // yet — and the payload below reads the subscription and this person's module assignments, both
    // of which are tenant-owned. Naming it here is what every other request gets from the guard.
    setCompanyId(user.company_id);
    return { user: await this.auth.payloadFor(user), mfa: await this.obligationFor(user) };
  }

  /**
   * Answer the second-factor challenge and finish signing in.
   *
   * Rate-limited like sign-in itself: this endpoint checks a secret, and a six-digit code is a
   * million possibilities. The per-code attempt ceiling in `MfaService` bounds one issued code; this
   * bounds how fast codes can be thrown at the endpoint at all.
   */
  @Post('login/mfa')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  async loginMfa(
    @Body() dto: ChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginOutcome> {
    const pendingId = this.pendingUserId(req);

    const ok = await this.mfa.verifyChallenge(pendingId, dto.method, dto.code, req.ip ?? null);
    if (!ok) {
      this.log.warn(`A failed two-factor attempt for user #${pendingId} from ${req.ip}.`);
      throwValidation({ code: ['That code is not right, or it has expired.'] });
    }

    const user = await this.auth.loadUser(pendingId);
    // The account could have been deactivated between the password and the code.
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });

    await this.startAuthenticatedSession(req, res, user.id, false);
    setCompanyId(user.company_id);

    // Trusting the device is a choice, never a default — see TrustedDeviceService for what it costs.
    if (dto.trust_device === true) {
      await this.devices.trust(req, res, user.id, user.company_id);
    }

    this.log.log(`User #${user.id} completed two-factor sign-in by ${dto.method}.`);
    return { user: await this.auth.payloadFor(user), mfa: await this.obligationFor(user) };
  }

  /** Send (or resend) an emailed/texted code for a challenge already in progress. */
  @Post('login/mfa/send')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  async sendMfaCode(
    @Body() dto: SendChallengeCodeDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.mfa.sendChallengeCode(this.pendingUserId(req), dto.channel);
    /*
     * The same answer whether or not anything was sent. Whether that channel is set up, whether the
     * address is reachable, and whether delivery succeeded are all facts about an account, and the
     * caller has proved a password but not an identity — so telling them would turn this into an
     * oracle. Somebody who genuinely receives nothing has the other methods and the recovery codes.
     */
    return { message: 'If that method is set up, a code is on its way.' };
  }

  /**
   * The user id of a challenge in progress, or 401.
   *
   * The expiry is enforced here rather than left to the session cookie. A pending session is a
   * password already proved and a second factor not yet proved — leaving that alive for the full
   * session lifetime would mean a browser walked away from at the challenge screen stays half
   * authenticated for hours.
   */
  private pendingUserId(req: Request): number {
    const id = req.session?.mfaPendingUserId;
    const until = req.session?.mfaPendingUntil;
    if (!id || !until || Date.now() > until) {
      throw new UnauthorizedException({ message: 'That sign-in has expired. Please start again.' });
    }
    return id;
  }

  /** Mark the session as "password proved, factor outstanding" — and nothing more. */
  private async startPendingSession(req: Request, userId: number): Promise<void> {
    // Regenerated here too, so the identifier a visitor arrived with is discarded at the FIRST step
    // rather than only at the second.
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.mfaPendingUserId = userId;
    req.session.mfaPendingUntil = Date.now() + AuthController.MFA_PENDING_MINUTES * 60 * 1000;
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  }

  /** What, if anything, this person still owes the brokerage's policy. */
  private async obligationFor(user: AuthUserRecord): Promise<MfaObligation> {
    return this.policy.obligationFor(user, await this.mfa.isEnabled(user.id));
  }

  @Get('user')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUserRecord | undefined): Promise<AuthPayload> {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    return this.auth.payloadFor(user);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async logout(@Req() req: Request): Promise<{ message: string }> {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    return { message: 'Logged out' };
  }

  // Changing a password requires the current one, so this is a guessing surface too.
  @Post('user/password')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthUserRecord | undefined,
  ): Promise<{ message: string }> {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    await this.auth.changePassword(user, dto.current_password, dto.password, dto.password_confirmation);
    return { message: 'Password updated' };
  }

  @Get('registration-open')
  async registrationOpen(): Promise<{ open: boolean }> {
    return { open: !(await this.auth.usersExist()) };
  }
}
