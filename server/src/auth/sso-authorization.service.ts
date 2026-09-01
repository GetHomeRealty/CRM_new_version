import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from './auth.types';

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

interface CodeExchange {
  clientId: string;
  redirectUri: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
}

export interface SsoIdentity {
  sub: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
}

/**
 * The server-side half of the shared sign-in handoff.
 *
 * This does not create a second kind of CRM session and never receives a password. A user first
 * completes the existing CRM sign-in (including MFA), then this service issues a random one-time
 * code to an exact, configured callback. The external application's server proves possession of
 * both its client secret and the browser's PKCE verifier before receiving the identity.
 */
@Injectable()
export class SsoAuthorizationService {
  static readonly MIN_SECRET_BYTES = 32;
  static readonly DEFAULT_CODE_LIFETIME_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async issue(user: AuthUserRecord, request: AuthorizationRequest): Promise<{ code: string; expiresIn: number }> {
    this.assertActive(user.status);
    const client = this.assertClient(request.clientId, request.redirectUri);
    this.assertPkceValue(request.codeChallenge, 'code_challenge');

    const code = randomBytes(32).toString('base64url');
    const lifetime = this.codeLifetimeSeconds();
    const now = new Date();
    await this.prisma.sso_authorization_codes.create({
      data: {
        code_hash: this.hash(code),
        user_id: user.id,
        client_id: client.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        expires_at: new Date(now.getTime() + lifetime * 1000),
        created_at: now,
      },
    });
    await this.sweepExpired();
    return { code, expiresIn: lifetime };
  }

  async exchange(request: CodeExchange): Promise<SsoIdentity> {
    const client = this.assertClient(request.clientId, request.redirectUri);
    this.assertClientSecret(request.clientSecret, client.clientSecret);
    this.assertPkceValue(request.codeVerifier, 'code_verifier');

    const now = new Date();
    const codeHash = this.hash(request.code);
    const challenge = createHash('sha256').update(request.codeVerifier).digest('base64url');

    // The conditional update is the redemption. Two exchanges racing with the same code cannot
    // both change a row whose consumed_at is null, so only one receives the identity.
    const redeemed = await this.prisma.sso_authorization_codes.updateMany({
      where: {
        code_hash: codeHash,
        client_id: client.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: challenge,
        consumed_at: null,
        expires_at: { gt: now },
      },
      data: { consumed_at: now },
    });
    if (redeemed.count !== 1) {
      throw new UnauthorizedException({ message: 'The authorization code is invalid, expired, or already used.' });
    }

    const record = await this.prisma.sso_authorization_codes.findUnique({
      where: { code_hash: codeHash },
      include: { users: true },
    });
    if (!record) throw new UnauthorizedException({ message: 'The authorization code is invalid.' });
    this.assertActive(record.users.status);

    return {
      sub: String(record.users.id),
      name: record.users.name,
      email: record.users.email,
      username: record.users.username,
      role: record.users.role,
    };
  }

  private assertClient(clientId: string, redirectUri: string): { clientId: string; clientSecret: string } {
    const cfg = this.config.get<AppConfig['sso']>('sso');
    if (!cfg?.clientSecret || cfg.clientSecret.length < SsoAuthorizationService.MIN_SECRET_BYTES || !cfg.redirectUris.length) {
      throw new ServiceUnavailableException({ message: 'Shared sign-in is not configured.' });
    }
    if (clientId !== cfg.clientId || !cfg.redirectUris.includes(redirectUri)) {
      throw new BadRequestException({ message: 'Unknown SSO client or redirect URI.' });
    }
    const callback = new URL(redirectUri);
    const localHttp = callback.protocol === 'http:' && (callback.hostname === 'localhost' || callback.hostname === '127.0.0.1');
    if (callback.protocol !== 'https:' && !localHttp) {
      throw new BadRequestException({ message: 'SSO redirect URIs must use HTTPS except on localhost.' });
    }
    return { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
  }

  private assertClientSecret(given: string, expected: string): void {
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException({ message: 'Invalid client credentials.' });
    }
  }

  private assertPkceValue(value: string, field: string): void {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
      throw new BadRequestException({ message: `${field} must be a valid PKCE value.` });
    }
  }

  private assertActive(status: string | null): void {
    if ((status ?? 'Active') !== 'Active') {
      throw new ForbiddenException({ message: 'This account is inactive.' });
    }
  }

  private codeLifetimeSeconds(): number {
    const configured = this.config.get<AppConfig['sso']>('sso')?.codeLifetimeSeconds;
    return Math.min(300, Math.max(30, configured ?? SsoAuthorizationService.DEFAULT_CODE_LIFETIME_SECONDS));
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async sweepExpired(): Promise<void> {
    try {
      await this.prisma.sso_authorization_codes.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch {
      // Housekeeping only. A code already issued remains short-lived and single-use.
    }
  }
}
