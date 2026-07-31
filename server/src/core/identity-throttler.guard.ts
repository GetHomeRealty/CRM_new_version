import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import type { Request } from 'express';
import { ANON_LIMIT, GLOBAL_LIMIT } from '../config/rate-limits';

/** What express-session puts on the request once somebody has signed in. */
const userIdOf = (req: Record<string, unknown>): number | undefined => {
  const session = req.session as { userId?: number } | undefined;
  return typeof session?.userId === 'number' ? session.userId : undefined;
};

/**
 * Rate limiting keyed by WHO is asking, not by where they are asking from.
 *
 * The stock guard keys on client IP. That is right for an anonymous API and wrong for this one: a
 * brokerage office shares a single NAT address, so an IP bucket is really an office bucket, and its
 * ceiling depends on how many colleagues happen to be working rather than on anything the person
 * did. Measured, one agent editing a transaction produces about 50 requests a minute (the detail
 * screen auto-saves on a 1.2 s debounce), so roughly twelve people in one office exhausted the
 * previous 600/minute bucket and their auto-saves began returning 429 mid-edit — which surfaces as
 * "it randomly stops saving", the sort of fault nobody reports accurately.
 *
 * Signed-in traffic is therefore keyed by user id, which makes the limit mean "what one person may
 * do". That number no longer has to be inflated to fit the size of the office, and it is STRICTER
 * than before in the case that matters: a client stuck in a request loop now hits its own ceiling
 * instead of consuming everybody else's.
 *
 * WHY `req.session.userId` AND NOT `req.authUser`: `authUser` is attached by AuthGuard, so whether
 * it exists yet would depend on guard execution order — an invisible dependency that would quietly
 * revert this to IP keying the day somebody reorders the providers in AppModule. The session is
 * populated by express-session MIDDLEWARE, which always runs before every guard.
 */
@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = userIdOf(req);
    if (userId !== undefined) return `u:${userId}`;
    const r = req as unknown as Request;
    return `ip:${r.ip ?? r.socket?.remoteAddress ?? 'unknown'}`;
  }

  /**
   * Anonymous traffic is measured against ANON_LIMIT rather than the per-user limit, because before
   * anyone signs in a whole office genuinely does share one address. Both buckets cannot simply be
   * declared in `ThrottlerModule.forRoot` — everything listed there applies to every route, which
   * is the trap `config/rate-limits.ts` documents — so the swap happens here, where the identity is
   * already known.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const req = requestProps.context.switchToHttp().getRequest<Record<string, unknown>>();
    if (userIdOf(req) !== undefined) return super.handleRequest(requestProps);

    // Only widen the DEFAULT bucket. A route carrying its own @Throttle (sign-in, registration,
    // password change) has deliberately chosen its numbers and must keep them, or raising the
    // anonymous ceiling would quietly raise the sign-in ceiling with it — which is the one place
    // that must stay tight.
    //
    // Identified by comparing the resolved bucket to the configured default rather than by reading
    // the decorator's metadata key, because that key is not part of this package's public API and
    // an internal import would break silently on upgrade. Both numbers are compared, so an
    // override only escapes this if it matches the default exactly in limit AND window, in which
    // case applying the default is the correct outcome anyway.
    const isDefaultBucket = requestProps.limit === GLOBAL_LIMIT.limit && requestProps.ttl === GLOBAL_LIMIT.ttl;
    if (!isDefaultBucket) return super.handleRequest(requestProps);

    return super.handleRequest({ ...requestProps, limit: ANON_LIMIT.limit, ttl: ANON_LIMIT.ttl });
  }
}
