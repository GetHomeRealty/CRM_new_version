import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOpts(): AppConfig['session'] {
    return this.config.get<AppConfig['session']>('session') as AppConfig['session'];
  }

  /**
   * Sanctum CSRF-cookie endpoint. Served at the root (outside the /api prefix),
   * matching the frontend's `GET /sanctum/csrf-cookie`. Issues an XSRF-TOKEN
   * cookie tied to the session; the SPA echoes it as X-XSRF-TOKEN.
   */
  @Get('sanctum/csrf-cookie')
  csrfCookie(@Req() req: Request, @Res() res: Response): void {
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
    res.status(204).send();
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<{ user: AuthPayload }> {
    const user = await this.auth.register(dto.name, dto.email, dto.password, dto.password_confirmation);
    req.session.userId = user.id; // Auth::login + session regenerate
    return { user: this.auth.buildPayload(user) };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<{ user: AuthPayload }> {
    const user = await this.auth.login(dto.username, dto.password);
    req.session.userId = user.id;
    if (dto.remember) {
      // Keep the "remember me" session alive for 60 days.
      req.session.cookie.maxAge = 60 * 24 * 60 * 60 * 1000;
    }
    return { user: this.auth.buildPayload(user) };
  }

  @Get('user')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUserRecord | undefined): AuthPayload {
    if (!user) throw new UnauthorizedException({ message: 'Unauthenticated.' });
    return this.auth.buildPayload(user);
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

  @Post('user/password')
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
