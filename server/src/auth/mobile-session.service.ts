import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

interface StoredMobileSession {
  userId?: unknown;
  mobile?: unknown;
}

@Injectable()
export class MobileSessionService {
  static readonly TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async issue(userId: number): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = randomBytes(32).toString('base64url');
    const expiresIn = this.lifetimeSeconds();
    await this.prisma.user_sessions.create({
      data: {
        sid: this.sid(accessToken),
        sess: { userId, mobile: true },
        expire: new Date(Date.now() + expiresIn * 1000),
      },
    });
    return { accessToken, expiresIn };
  }

  async authenticate(header: string | undefined): Promise<{ sid: string; userId: number } | null> {
    const token = this.bearerToken(header);
    if (!token) return null;
    const sid = this.sid(token);
    const record = await this.prisma.user_sessions.findUnique({ where: { sid } });
    if (!record || record.expire <= new Date()) return null;
    const payload = record.sess as StoredMobileSession;
    if (payload.mobile !== true || !Number.isInteger(payload.userId) || Number(payload.userId) <= 0) return null;
    return { sid, userId: Number(payload.userId) };
  }

  async revoke(sid: string): Promise<void> {
    await this.prisma.user_sessions.deleteMany({ where: { sid } });
  }

  private bearerToken(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    return MobileSessionService.TOKEN_PATTERN.test(token) ? token : null;
  }

  private sid(token: string): string {
    return `mobile:${createHash('sha256').update(token).digest('hex')}`;
  }

  private lifetimeSeconds(): number {
    const days = this.config.get<AppConfig['sso']>('sso')?.mobileSessionLifetimeDays ?? 30;
    return Math.min(90, Math.max(1, days)) * 24 * 60 * 60;
  }
}
