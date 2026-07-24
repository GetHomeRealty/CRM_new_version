import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signs and verifies the OAuth `state` parameter for the Google connect flow.
 *
 * The value travels to Google and back through the browser, so it must be tamper-proof: without a
 * signature anyone could craft a callback carrying someone else's user id and bind a Google
 * account to that user. Single-use and short-lived, which blocks replay. Same design as the Meta
 * integration's state service.
 */
@Injectable()
export class GoogleStateService {
  private readonly used = new Set<string>();
  static readonly TTL_MS = 10 * 60 * 1000;

  private secret(): string {
    return (process.env.APP_KEY ?? process.env.SESSION_SECRET ?? 'google-state').trim();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret()).update(payload).digest('base64url');
  }

  /** `purpose` distinguishes what the same callback is finishing — calendar connect vs. mail connect. */
  issue(userId: number, purpose: 'calendar' | 'mail' = 'calendar'): string {
    const payload = `${userId}.${purpose}.${Date.now()}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verify(state: string): { userId: number; purpose: 'calendar' | 'mail' } | null {
    const parts = String(state ?? '').split('.');
    if (parts.length !== 5) return null;
    const [userIdRaw, purposeRaw, issuedRaw, nonce, signature] = parts;

    const expected = this.sign(`${userIdRaw}.${purposeRaw}.${issuedRaw}.${nonce}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const issued = Number(issuedRaw);
    if (!Number.isFinite(issued) || Date.now() - issued > GoogleStateService.TTL_MS) return null;

    if (this.used.has(nonce)) return null;
    this.used.add(nonce);
    if (this.used.size > 5000) this.used.clear();

    const userId = Number(userIdRaw);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const purpose = purposeRaw === 'mail' ? 'mail' : 'calendar';
    return { userId, purpose };
  }
}
