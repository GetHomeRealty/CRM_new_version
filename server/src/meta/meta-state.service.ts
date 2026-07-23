import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signs and verifies the OAuth `state` parameter.
 *
 * The value travels to Meta and back through the user's browser, so it must be tamper-proof:
 * without a signature anyone could craft a callback carrying someone else's user id and bind a
 * Facebook account to that user. It is also single-use and short-lived, which blocks replay.
 */
@Injectable()
export class MetaStateService {
  /** Nonces already redeemed, so a captured callback URL can't be replayed. */
  private readonly used = new Set<string>();

  static readonly TTL_MS = 10 * 60 * 1000;

  private secret(): string {
    return (process.env.APP_KEY ?? process.env.SESSION_SECRET ?? 'meta-state').trim();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret()).update(payload).digest('base64url');
  }

  /** `userId.issuedAt.nonce.signature` */
  issue(userId: number): string {
    const payload = `${userId}.${Date.now()}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  /** The user id this state was issued to, or null if it is forged, expired or already used. */
  verify(state: string): number | null {
    const parts = String(state ?? '').split('.');
    if (parts.length !== 4) return null;
    const [userIdRaw, issuedRaw, nonce, signature] = parts;

    const expected = this.sign(`${userIdRaw}.${issuedRaw}.${nonce}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    // Compare in constant time, and only when the lengths match — timingSafeEqual throws otherwise.
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const issued = Number(issuedRaw);
    if (!Number.isFinite(issued) || Date.now() - issued > MetaStateService.TTL_MS) return null;

    if (this.used.has(nonce)) return null;
    this.used.add(nonce);
    this.prune();

    const userId = Number(userIdRaw);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  }

  /** Keep the replay set from growing without bound in a long-running process. */
  private prune(): void {
    if (this.used.size > 5000) this.used.clear();
  }
}
