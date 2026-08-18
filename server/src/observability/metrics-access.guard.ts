import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AuthGuard } from '../auth/guards/auth.guard';

/**
 * Who may read the detailed diagnostics: `/api/health/metrics` and `/api/health/workers`.
 *
 * ================================================================================================
 * WHY THIS EXISTS. Both endpoints were unauthenticated, on the reasoning — written into the
 * controller — that "a monitor that needs credentials is a monitor that stops working when
 * authentication breaks". That argument is sound for LIVENESS and it is wrong for these two, because
 * of what they actually return:
 *
 *   slowest_routes   the ten busiest route PATTERNS, which is a partial map of the API
 *   recent_errors    the last twenty-five 5xx messages, up to 300 characters each — and a 5xx
 *                    message is whatever threw: a Prisma error naming a table and column, a
 *                    filesystem path, a failed connection string's host
 *   process/memory   rss, heap, event-loop lag, cpu — a load profile for anyone deciding when to
 *                    push
 *   audit failures   that the compliance trail is not being written
 *
 * None of it is a customer record, which is why it read as harmless. All of it helps somebody who is
 * probing, and the error strings are the part that cannot be predicted — they carry whatever the
 * next unhandled exception happens to say.
 * ================================================================================================
 *
 * TWO WAYS IN, BECAUSE MONITORING AND PEOPLE ARE DIFFERENT CALLERS:
 *
 *   A SIGNED-IN SUPER ADMIN. `isSuperAdmin` is the same test the rest of the application uses for
 *   "may see everything"; this adds no new notion of privilege.
 *
 *   A MONITORING TOKEN, when `METRICS_TOKEN` is set. This is what keeps the original argument
 *   honoured: an uptime probe presents a header and never touches the session layer, so it keeps
 *   working when authentication is exactly what has broken. Unset by default, so a deployment that
 *   does not want one has no extra door — absence disables the path entirely rather than falling
 *   back to "no token required".
 *
 * COMPARED IN CONSTANT TIME. A token compared with `===` leaks its length and its matching prefix to
 * anyone willing to time the responses; this is a shared secret in a header, which is the classic
 * shape for that mistake.
 *
 * LIVENESS AND READINESS ARE NOT GUARDED BY THIS. `/api/health` stays open because a restarter needs
 * it, and `/api/health/ready` stays open because a load balancer does — see the controller for what
 * each returns to an anonymous caller now.
 *
 * IT IS THE ONLY GUARD ON ITS ROUTES, AND CALLS `AuthGuard` ITSELF RATHER THAN SITTING BESIDE IT.
 * Nest requires EVERY guard on a route to pass, so `@UseGuards(AuthGuard, MetricsAccessGuard)` would
 * have let `AuthGuard` answer 401 to an anonymous monitor before this one ever looked at the token —
 * the token path would have existed and never worked. Delegating means the session is still resolved
 * by the one implementation that knows how, and `authUser` is populated for the role check below.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(private readonly auth: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { authUser?: { role?: string | null } }>();

    // The monitoring path first: it must not depend on the session layer being healthy.
    if (MetricsAccessGuard.tokenMatches(req)) return true;

    /*
     * Otherwise a real session is required. `AuthGuard` throws 401 by itself for an anonymous
     * caller, which is the right answer — "sign in" rather than "forbidden" — and populates
     * `authUser` for the role test below.
     */
    await this.auth.canActivate(context);

    const role = (req.authUser?.role ?? '').toLowerCase();
    if (role === 'admin') return true;

    throw new ForbiddenException({
      message: 'Detailed diagnostics are restricted. Sign in as a Super Admin, or present the monitoring token.',
    });
  }

  /** Whether the request carries the configured monitoring token. False when none is configured. */
  static tokenMatches(req: Request): boolean {
    const expected = (process.env.METRICS_TOKEN ?? '').trim();
    if (!expected) return false;

    const raw = req.headers['x-metrics-token'];
    const given = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!given) return false;

    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    // `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle — so the
    // lengths are compared first and the result is folded in rather than returned early.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
