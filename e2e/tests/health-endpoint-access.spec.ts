import { test, expect } from '@playwright/test';
import { signIn, apiGet } from './helpers';

/**
 * THE DIAGNOSTIC ENDPOINTS ARE NOT PUBLIC, AND THE PROBES STILL ARE.
 *
 * ================================================================================================
 * WHAT WAS WRONG. `/api/health/metrics` and `/api/health/workers` answered anybody, with no session
 * at all. Between them they return the ten busiest route patterns, the last twenty-five 5xx messages
 * at up to 300 characters each, this process's memory and event-loop profile, and every background
 * worker's `last_error`. The error strings are the part that cannot be predicted — they are whatever
 * threw, which in practice means Prisma errors naming tables and columns, filesystem paths, and the
 * hosts out of failed connection strings.
 *
 * The reasoning for leaving them open was written into the controller and it is a good argument for
 * the WRONG endpoints: "a monitor that needs credentials is a monitor that stops working when
 * authentication breaks". That holds for liveness and readiness. It does not justify handing the
 * error log to anyone who asks.
 * ================================================================================================
 *
 * BOTH HALVES ARE ASSERTED HERE, because a fix to one is a plausible way to break the other. Locking
 * down the diagnostics is worth nothing if it also takes readiness away from the load balancer, and
 * that failure would not show up as a test failure anywhere else — it would show up as a deployment
 * that never comes back into rotation.
 *
 * The server-side unit tests in `server/src/observability/health-access.spec.ts` cover the guard's
 * decisions and the monitoring-token path. This covers the same rules through a real browser and a
 * real session, which is the part those cannot reach.
 */

test.describe('the detailed diagnostics are restricted', () => {
  test('an anonymous visitor is refused both of them', async ({ page, context }) => {
    await context.clearCookies();
    // A page is still needed to make a same-origin fetch; nothing signs in.
    await page.goto('/login');

    for (const path of ['/api/health/metrics', '/api/health/workers']) {
      const res = await apiGet(page, path);
      expect(res.status, `${path} must not answer an anonymous caller`).toBe(401);
      // And the refusal itself gives nothing away about what is behind it.
      expect(JSON.stringify(res.body)).not.toContain('slowest_routes');
    }
  });

  test('a signed-in agent is refused, being signed in is not enough', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent');

    for (const path of ['/api/health/metrics', '/api/health/workers']) {
      const res = await apiGet(page, path);
      expect(res.status, `${path} must refuse an agent`).toBe(403);
    }
  });

  test('a Manager is refused too — this is not the ordinary admin boundary', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'admin');

    const res = await apiGet(page, '/api/health/metrics');
    expect(res.status).toBe(403);
  });

  test('a Super Admin reads them', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'superAdmin');

    const metrics = await apiGet(page, '/api/health/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body).toHaveProperty('slowest_routes');

    const workers = await apiGet(page, '/api/health/workers');
    expect(workers.status).toBe(200);
    expect(workers.body).toHaveProperty('schedulers');
  });
});

test.describe('the probes a monitor needs are still open', () => {
  test('liveness and readiness answer with no credentials at all', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');

    const live = await apiGet(page, '/api/health');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'ok' });

    const ready = await apiGet(page, '/api/health/ready');
    expect(ready.status).toBe(200);
    // A load balancer needs the verdict and the per-dependency flags. That is all it needs.
    const body = ready.body as { status: string; checks: Record<string, Record<string, unknown>> };
    expect(['ready', 'degraded']).toContain(body.status);
    expect(Object.keys(body.checks).length).toBeGreaterThan(0);
  });

  test('readiness tells an anonymous caller WHICH dependency is unhealthy, never why', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');

    const ready = await apiGet(page, '/api/health/ready');
    const body = ready.body as { checks: Record<string, Record<string, unknown>> };

    /*
     * `detail` carried up to 160 characters of the raw exception — a Prisma error naming a table, a
     * path, the host from a connection string. Every check keeps its `ok` flag and loses its reason.
     */
    for (const [name, check] of Object.entries(body.checks)) {
      expect(check, `${name} must keep its verdict`).toHaveProperty('ok');
      expect(check, `${name} must not explain itself to an anonymous caller`).not.toHaveProperty('detail');
    }
  });
});
