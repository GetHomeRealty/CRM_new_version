import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Signs and verifies the OAuth `state` parameter.
 *
 * The value travels to Meta and back through the user's browser, so it must be tamper-proof:
 * without a signature anyone could craft a callback carrying someone else's user id and bind a
 * Facebook account to that user. It is also single-use and short-lived, which blocks replay.
 */
@Injectable()
export class MetaStateService {
  private readonly log = new Logger(MetaStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  static readonly TTL_MS = 10 * 60 * 1000;

  /**
   * The signing key. There is deliberately no fallback.
   *
   * It used to fall back to the literal string `'meta-state'` when neither variable was set. A
   * known signing key is the same as no signature at all: anyone can mint a state naming any user
   * id and bind their own Facebook account to that person's CRM account. Production config
   * validation already demands `SESSION_SECRET`, so the fallback only ever applied in development
   * — which is precisely where somebody would be testing an OAuth flow against a real Meta app.
   *
   * Refusing loudly is the honest failure. An OAuth flow that cannot be secured must not run.
   */
  private secret(): string {
    const key = (process.env.APP_KEY ?? process.env.SESSION_SECRET ?? '').trim();
    if (!key) {
      throw new Error(
        'Meta OAuth cannot sign its state parameter: set APP_KEY (or SESSION_SECRET). '
        + 'There is no default — a known signing key would let anyone bind their Facebook account '
        + 'to another user.',
      );
    }
    return key;
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
  async verify(state: string): Promise<number | null> {
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

    if (!(await this.redeem(nonce, new Date(issued + MetaStateService.TTL_MS)))) return null;

    const userId = Number(userIdRaw);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  }

  /**
   * Claim a nonce. True the first time, false for every repeat.
   *
   * THE INSERT IS THE CHECK. Reading first and then writing leaves a gap two simultaneous
   * callbacks can both pass through; a unique violation cannot be raced. This is the same shape as
   * the webhook's `claim()`, for the same reason.
   *
   * A database failure returns false rather than true — a redeem that cannot be recorded is one
   * that cannot be proven single-use, and the safe answer to "is this a replay?" when we do not
   * know is yes. The cost is a failed connect the user can retry; the alternative is an
   * unenforceable guarantee.
   */
  private async redeem(nonce: string, expiresAt: Date): Promise<boolean> {
    try {
      await this.prisma.meta_oauth_nonces.create({ data: { nonce: nonce.slice(0, 64), expires_at: expiresAt } });
    } catch (e) {
      // A unique violation IS the replay — the expected, uninteresting case. Anything else is a
      // database problem, which is worth a line in the log but gets the same refusal.
      const replay = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      if (!replay) {
        this.log.error(`Could not record an OAuth state nonce, so the callback is being refused: ${(e as Error).message}`);
      }
      return false;
    }
    await this.sweep();
    return true;
  }

  /**
   * Drop nonces past their TTL.
   *
   * Only expired rows, never a wholesale clear — that was the original defect. A nonce older than
   * the TTL is already rejected by the timestamp check above, so forgetting it changes nothing.
   *
   * Swallows its own errors: failing to tidy up must not fail a connect that has already been
   * recorded as redeemed.
   */
  private async sweep(): Promise<void> {
    try {
      await this.prisma.meta_oauth_nonces.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch {
      /* housekeeping only */
    }
  }
}
