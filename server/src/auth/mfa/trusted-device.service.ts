import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import type { AppConfig } from '../../config/configuration';
import { hashOneTimeValue } from './mfa-crypto';

/**
 * "Do not ask again on this device."
 *
 * WHAT THIS IS, HONESTLY. It is a deliberate, bounded weakening of the second factor, and it is
 * worth being plain about that rather than presenting it as a convenience with no cost. The cookie
 * this issues lets a browser skip the challenge entirely, so anyone holding it has the second factor
 * for as long as it lasts.
 *
 * WHAT KEEPS THAT ACCEPTABLE:
 *   - the token is 256 bits of randomness, stored HASHED, so a database read yields nothing usable;
 *   - it is HttpOnly, so no script on the origin can read it;
 *   - it expires (30 days by default) and the row expires with it;
 *   - it is bound to ONE user — presenting another person's token proves nothing about you;
 *   - it is revoked wholesale whenever the password changes or two-factor is reconfigured, because
 *     both of those are what somebody does after a device is lost;
 *   - every device is listed on the security screen with its last use, so an unfamiliar one can be
 *     revoked by its owner.
 *
 * The alternative — no such option — is a second factor typed a dozen times a day, which is how
 * people end up choosing weaker second factors or writing codes on a monitor.
 */
@Injectable()
export class TrustedDeviceService {
  private readonly log = new Logger(TrustedDeviceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  static readonly COOKIE = 'mfa_device';
  static readonly DEFAULT_DAYS = 30;

  private days(): number {
    const configured = Number(process.env.MFA_TRUSTED_DEVICE_DAYS);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : TrustedDeviceService.DEFAULT_DAYS;
  }

  /**
   * Is this request coming from a device this person has already trusted?
   *
   * Looked up by HASH, so the raw cookie value is never compared against anything stored. Expiry and
   * revocation are part of the query rather than checked afterwards, which is what stops a stale row
   * from being honoured by a code path that forgot to look.
   */
  async isTrusted(req: Request, userId: number): Promise<boolean> {
    const raw = this.readCookie(req);
    if (!raw) return false;

    const now = new Date();
    const device = await this.prisma.mfa_trusted_devices.findFirst({
      where: {
        token_hash: hashOneTimeValue(raw),
        user_id: userId,          // bound to one account: another person's token is worthless here
        revoked_at: null,
        expires_at: { gt: now },
      },
      select: { id: true },
    });
    if (!device) return false;

    // Last seen is for the owner reading their own device list — "Toronto laptop, 3 minutes ago" is
    // what makes an unfamiliar entry recognisable as unfamiliar.
    await this.prisma.mfa_trusted_devices.update({
      where: { id: device.id },
      data: { last_seen_at: now },
    });
    return true;
  }

  /** Trust this browser, and set the cookie that proves it next time. */
  async trust(
    req: Request,
    res: Response,
    userId: number,
    label?: string | null,
  ): Promise<void> {
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + this.days() * 24 * 60 * 60 * 1000);

    await this.prisma.mfa_trusted_devices.create({
      data: {
        user_id: userId,
        token_hash: hashOneTimeValue(raw),
        label: (label ?? this.describe(req))?.slice(0, 120) ?? null,
        user_agent: String(req.headers['user-agent'] ?? '').slice(0, 255) || null,
        ip: this.ipOf(req),
        last_seen_at: now,
        expires_at: expires,
        created_at: now,
      },
    });

    const session = this.config.get<AppConfig['session']>('session');
    res.cookie(TrustedDeviceService.COOKIE, raw, {
      httpOnly: true,          // nothing on the origin may read a second-factor bypass
      secure: session?.secure ?? false,
      sameSite: session?.sameSite ?? 'lax',
      domain: session?.domain,
      path: '/',
      expires,
    });
    this.log.log(`Trusted a new device for user #${userId} for ${this.days()} days.`);
  }

  /** The list shown on the security screen. */
  async list(userId: number): Promise<Array<{
    id: number; label: string | null; ip: string | null;
    last_seen_at: Date | null; expires_at: Date; created_at: Date;
  }>> {
    return this.prisma.mfa_trusted_devices.findMany({
      where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
      select: { id: true, label: true, ip: true, last_seen_at: true, expires_at: true, created_at: true },
      orderBy: { last_seen_at: 'desc' },
    });
  }

  /** Revoke one device. Scoped by user id, so nobody can revoke somebody else's by guessing an id. */
  async revoke(userId: number, deviceId: number): Promise<boolean> {
    const result = await this.prisma.mfa_trusted_devices.updateMany({
      where: { id: deviceId, user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Revoke every device for a person.
   *
   * Called when the password changes, when a factor is added or removed, and when an administrator
   * resets somebody's two-factor. Each of those is what a person does after losing a device, so
   * leaving the old ones trusted would defeat the action they just took.
   */
  async revokeAll(userId: number): Promise<number> {
    const result = await this.prisma.mfa_trusted_devices.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (result.count) this.log.log(`Revoked ${result.count} trusted device(s) for user #${userId}.`);
    return result.count;
  }

  /** Clear the cookie in the browser making this request. */
  clearCookie(res: Response): void {
    const session = this.config.get<AppConfig['session']>('session');
    res.clearCookie(TrustedDeviceService.COOKIE, {
      httpOnly: true,
      secure: session?.secure ?? false,
      sameSite: session?.sameSite ?? 'lax',
      domain: session?.domain,
      path: '/',
    });
  }

  /**
   * Read the cookie straight off the header.
   *
   * `req.cookies` is NOT available in this application — `cookie-parser` is not registered, and
   * express-session parses the header for its own purposes without exposing the result. Checked,
   * not assumed: an earlier draft here read `req.cookies` and would have found `undefined` every
   * time, which fails in the safe direction (always challenge) and would therefore never have shown
   * up as a bug, only as a feature that silently did nothing.
   *
   * Parsing the one header is a few lines; adding a dependency and a global middleware to the
   * authentication path to avoid them is the worse trade.
   */
  private readCookie(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== TrustedDeviceService.COOKIE) continue;
      const raw = part.slice(eq + 1).trim();
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw; // a value that is not valid percent-encoding simply will not match a hash
      }
    }
    return null;
  }

  private ipOf(req: Request): string | null {
    return String(req.ip ?? '').slice(0, 64) || null;
  }

  /** A human label from the user agent — "Chrome on Windows" rather than 120 characters of tokens. */
  private describe(req: Request): string {
    const ua = String(req.headers['user-agent'] ?? '');
    const browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS'
        : /Android/.test(ua) ? 'Android'
          : /iPhone|iPad/.test(ua) ? 'iOS'
            : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
    return `${browser} on ${os}`;
  }
}
