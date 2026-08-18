import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { HealthController } from './health.controller';
import { MetricsAccessGuard } from './metrics-access.guard';

/**
 * WHO CAN READ THE DIAGNOSTIC ENDPOINTS.
 *
 * ================================================================================================
 * THE DEFECT THIS PINS DOWN. `/api/health/metrics` and `/api/health/workers` were unauthenticated.
 * They return the ten busiest route patterns, the last twenty-five 5xx messages at up to 300
 * characters each, this process's memory and event-loop profile, and every scheduler's `last_error`.
 * The 5xx strings are the part that cannot be predicted — they are whatever threw, which in practice
 * means Prisma errors naming tables and columns, filesystem paths, and hosts out of failed
 * connection strings. Anyone at all could read them, repeatedly, from the open internet.
 * ================================================================================================
 *
 * THE TWO HALVES ARE TESTED SEPARATELY BECAUSE THEY FAIL SEPARATELY:
 *
 *   THE GUARD'S DECISION      — who it lets through, and what it does with an anonymous caller.
 *   THE ROUTE WIRING          — that the guard is actually mounted on those two routes and NOT on
 *                               liveness or readiness. A perfect guard nobody mounted is the more
 *                               likely regression, and it leaves no trace anywhere else.
 *
 * ORDERING IS PART OF THE CONTRACT, not an implementation detail: the token is checked BEFORE the
 * session, because a monitor must keep working when the session layer is exactly what has broken.
 * An earlier draft of this mounted `@UseGuards(AuthGuard, MetricsAccessGuard)`, and since Nest
 * requires every guard on a route to pass, `AuthGuard` answered 401 to the anonymous monitor before
 * the token was ever looked at — the token path existed and could never be taken. The test named
 * "answers a monitoring token without consulting the session" is what catches that shape.
 */

/** A guard context over a fake request. `authUser` stands in for what `AuthGuard` would have set. */
function contextFor(
  headers: Record<string, string> = {},
  authUser?: { role?: string | null },
): { ctx: ExecutionContext; req: Request & { authUser?: { role?: string | null } } } {
  const req = { headers, authUser } as unknown as Request & { authUser?: { role?: string | null } };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => HealthController,
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/**
 * A stand-in for `AuthGuard` that records whether it was consulted.
 *
 * `signedInAs(null)` reproduces the real one's behaviour for an anonymous caller — it throws 401
 * itself rather than returning false — which is what makes "sign in" the answer to no session and
 * "forbidden" the answer to the wrong role.
 */
function stubAuth(role: string | null) {
  const state = { consulted: 0 };
  const guard = {
    async canActivate(ctx: ExecutionContext) {
      state.consulted += 1;
      if (role === null) throw new UnauthorizedException('Not signed in.');
      (ctx.switchToHttp().getRequest() as { authUser?: unknown }).authUser = { role };
      return true;
    },
  } as unknown as AuthGuard;
  return { guard, state };
}

describe('MetricsAccessGuard decides who reads the detailed diagnostics', () => {
  const savedToken = process.env.METRICS_TOKEN;
  afterEach(() => {
    if (savedToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = savedToken;
  });

  it('refuses an anonymous caller with 401, so the answer is "sign in" rather than "forbidden"', async () => {
    delete process.env.METRICS_TOKEN;
    const { guard: auth } = stubAuth(null);
    const { ctx } = contextFor();
    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(['agent', 'manager', 'user', 'staff', ''])('refuses a signed-in %s with 403', async (role) => {
    delete process.env.METRICS_TOKEN;
    const { guard: auth } = stubAuth(role);
    const { ctx } = contextFor();
    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a signed-in Super Admin', async () => {
    delete process.env.METRICS_TOKEN;
    const { guard: auth } = stubAuth('admin');
    const { ctx } = contextFor();
    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).resolves.toBe(true);
  });

  it('admits a Super Admin whatever the stored role\'s casing', async () => {
    delete process.env.METRICS_TOKEN;
    const { guard: auth } = stubAuth('Admin');
    const { ctx } = contextFor();
    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).resolves.toBe(true);
  });

  it('answers a monitoring token WITHOUT consulting the session', async () => {
    process.env.METRICS_TOKEN = 'a-monitoring-secret';
    // The session layer is broken in the worst way available: it throws for everyone.
    const { guard: auth, state } = stubAuth(null);
    const { ctx } = contextFor({ 'x-metrics-token': 'a-monitoring-secret' });

    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).resolves.toBe(true);
    // This is the assertion that would have failed under `@UseGuards(AuthGuard, MetricsAccessGuard)`.
    expect(state.consulted).toBe(0);
  });

  it('falls back to the session when the token is present but wrong, rather than short-circuiting', async () => {
    process.env.METRICS_TOKEN = 'a-monitoring-secret';
    const { guard: auth, state } = stubAuth('admin');
    const { ctx } = contextFor({ 'x-metrics-token': 'not-the-secret' });

    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).resolves.toBe(true);
    expect(state.consulted).toBe(1);
  });

  it('refuses a wrong token from a caller with no session', async () => {
    process.env.METRICS_TOKEN = 'a-monitoring-secret';
    const { guard: auth } = stubAuth(null);
    const { ctx } = contextFor({ 'x-metrics-token': 'not-the-secret' });
    await expect(new MetricsAccessGuard(auth).canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * The failure mode worth stating out loud: an unset `METRICS_TOKEN` must DISABLE the token path,
   * never degrade to "no token required". Both are one-line implementations and only one is safe.
   */
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('disables the token path entirely when METRICS_TOKEN is %s', (_label, value) => {
    if (value === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = value;

    expect(MetricsAccessGuard.tokenMatches(contextFor({ 'x-metrics-token': 'anything' }).req)).toBe(false);
    expect(MetricsAccessGuard.tokenMatches(contextFor({ 'x-metrics-token': '' }).req)).toBe(false);
    expect(MetricsAccessGuard.tokenMatches(contextFor().req)).toBe(false);
  });

  it('rejects a token of the wrong length without throwing out of timingSafeEqual', () => {
    process.env.METRICS_TOKEN = 'a-monitoring-secret';
    // `timingSafeEqual` throws on unequal buffer lengths; a prefix and a longer string are the two
    // ways in, and neither may become a 500 — a crash here is itself a length oracle.
    expect(MetricsAccessGuard.tokenMatches(contextFor({ 'x-metrics-token': 'a-monitoring' }).req)).toBe(false);
    expect(MetricsAccessGuard.tokenMatches(contextFor({ 'x-metrics-token': 'a-monitoring-secret-plus' }).req)).toBe(false);
    expect(MetricsAccessGuard.tokenMatches(contextFor({ 'x-metrics-token': 'a-monitoring-secret' }).req)).toBe(true);
  });
});

describe('the guard is mounted on the diagnostics and NOT on the probes', () => {
  /** What `@UseGuards()` left on a route method, or an empty list if the decorator is absent. */
  const guardsOn = (method: keyof HealthController): unknown[] =>
    Reflect.getMetadata(GUARDS_METADATA, HealthController.prototype[method] as object) ?? [];

  // The route path and the method name differ — `@Get('metrics')` is `snapshot()` — so both are
  // named here, and the pairing is what a reader needs to check this against the controller.
  it.each([['metrics', 'snapshot'], ['workers', 'workers']] as const)('restricts /%s', (_path, method) => {
    expect(guardsOn(method as keyof HealthController)).toContain(MetricsAccessGuard);
  });

  /**
   * Liveness and readiness stay open ON PURPOSE, and this asserts it so that "lock down the health
   * endpoints" never becomes a change that takes a deployment out of its load balancer. A restarter
   * watching liveness and a balancer watching readiness must both get an answer with no credentials
   * — including when authentication is what has broken, which is when they matter most.
   */
  it.each([['(liveness)', 'live'], ['ready', 'ready']] as const)('leaves /%s reachable with no credentials', (_path, method) => {
    expect(guardsOn(method as keyof HealthController)).toHaveLength(0);
  });
});

describe('readiness reports WHICH dependency is unhealthy, never why', () => {
  /**
   * The controller is driven with stubs rather than a database: the subject is which fields reach
   * the caller, and a real dependency would only make the failing checks harder to arrange.
   *
   * A rejecting `roles.count()` is the realistic leak — that path puts 160 characters of the raw
   * exception into `detail`, and a Prisma error names the table it could not read.
   */
  function controller() {
    const boom = () => Promise.reject(new Error('Cannot reach postgres://crm_admin@10.0.3.14:5432/myapp — relation "roles" does not exist'));
    const prisma = {
      $queryRawUnsafe: boom,
      roles: { count: boom },
      role_permissions: { count: boom },
      export_jobs: { count: () => Promise.resolve(0) },
    };
    const redis = { health: () => Promise.resolve({ status: 'skipped', latency_ms: null }) };
    const queues = { stats: () => Promise.resolve([]), driverKind: 'postgres', isWorker: true };
    return new HealthController(prisma as never, redis as never, queues as never);
  }

  const detailsIn = (body: Record<string, unknown>) =>
    Object.values(body.checks as Record<string, Record<string, unknown>>).filter((c) => 'detail' in c);

  it('strips every detail string for an anonymous caller, keeping the shape and the ok flags', async () => {
    delete process.env.METRICS_TOKEN;
    const body = await controller().ready({ headers: {} } as unknown as Request);
    const checks = body.checks as Record<string, { ok: boolean }>;

    expect(detailsIn(body)).toHaveLength(0);
    // The caller still learns WHICH dependency is down — that is the whole job of the endpoint.
    expect(checks.database.ok).toBe(false);
    expect(checks.authorization.ok).toBe(false);
    expect(body.status).toBe('degraded');

    // And nothing about the connection string survived anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('10.0.3.14');
  });

  it('gives the full detail to the monitoring token', async () => {
    process.env.METRICS_TOKEN = 'a-monitoring-secret';
    try {
      const body = await controller().ready({ headers: { 'x-metrics-token': 'a-monitoring-secret' } } as unknown as Request);
      const checks = body.checks as Record<string, { ok: boolean; detail?: string }>;
      expect(checks.database.detail).toContain('10.0.3.14');
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });
});
