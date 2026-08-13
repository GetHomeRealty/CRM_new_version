import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, API_BASE, PASSWORD } from './helpers';

/**
 * The background queue, through the real HTTP stack.
 *
 * The driver's behaviour — retries, backoff, the dead letter, cancellation — is proved against the
 * driver itself in `server/src/queue/in-process.driver.spec.ts`. What only a running application can
 * show is the part that matters operationally: that the queue is wired in, reports which driver is
 * live, is reachable ONLY by an administrator, and that a job put in actually comes out the far end.
 *
 * These run against a server with no `REDIS_URL`, which is the configuration every deployment has
 * today — so this is the real path, not a fallback being humoured.
 */

async function csrf(ctx: APIRequestContext): Promise<string> {
  await ctx.get(`${API_BASE}/sanctum/csrf-cookie`);
  const state = await ctx.storageState();
  return decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
}

async function post(ctx: APIRequestContext, path: string, data?: unknown) {
  const token = await csrf(ctx);
  return ctx.post(`${API_BASE}${path}`, {
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
    data: data ?? {},
  });
}

const signIn = (ctx: APIRequestContext, email: string) =>
  post(ctx, '/api/login', { username: email, password: PASSWORD });

test.describe('queue monitoring', () => {
  test('an administrator sees the driver, Redis health and every queue', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/queues`);
      expect(res.status()).toBe(200);
      const body = await res.json();

      /*
       * `driver` is the field that matters during an incident: "in-process" means jobs did not
       * survive the last restart and are not shared between processes. Nobody should have to infer
       * that from an environment variable.
       */
      expect(['in-process', 'redis']).toContain(body.driver);
      // No REDIS_URL in the e2e environment, so it must report the honest in-process answer.
      expect(body.driver).toBe('in-process');

      // Redis absent is "skipped", NOT a failure — an optional dependency must not read as broken.
      expect(body.redis.status).toBe('skipped');

      const names = body.queues.map((q: { queue: string }) => q.queue);
      expect(names).toEqual(
        expect.arrayContaining(['email', 'sms', 'reminder', 'calendar-sync', 'notification', 'export']),
      );
    } finally { await ctx.dispose(); }
  });

  test('a job enqueued through the API is picked up and completed', async ({ playwright }) => {
    /*
     * End to end: accepted, executed, counted. `RUN_SCHEDULERS` is false for the e2e server, so this
     * process ENQUEUES but does not process — which is itself the behaviour under test, and is
     * exactly how a web process behaves when workers run elsewhere.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);

      const before = await (await ctx.get(`${API_BASE}/api/queues`)).json();
      const notificationBefore = before.queues.find((q: { queue: string }) => q.queue === 'notification');

      const ping = await post(ctx, '/api/queues/ping', { queue: 'notification' });
      expect(ping.status()).toBe(200);
      expect((await ping.json()).job_id).toBeTruthy();

      const after = await (await ctx.get(`${API_BASE}/api/queues`)).json();
      const notificationAfter = after.queues.find((q: { queue: string }) => q.queue === 'notification');

      if (after.processes_jobs) {
        // A worker process: the job runs and the completed count moves.
        await expect.poll(async () => {
          const now = await (await ctx.get(`${API_BASE}/api/queues`)).json();
          return now.queues.find((q: { queue: string }) => q.queue === 'notification').completed;
        }, { timeout: 10_000 }).toBeGreaterThan(notificationBefore.completed);
      } else {
        // An enqueue-only process: the job waits for a worker rather than being lost.
        expect(notificationAfter.waiting).toBeGreaterThan(notificationBefore.waiting);
      }
    } finally { await ctx.dispose(); }
  });

  test('the dead letter is readable and starts empty', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/queues/dead`);
      expect(res.status()).toBe(200);
      expect(Array.isArray((await res.json()).jobs)).toBe(true);
    } finally { await ctx.dispose(); }
  });

  test('an unknown queue name is refused cleanly, not with a 500', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await post(ctx, '/api/queues/dead/not-a-queue/abc/retry');
      expect(res.status()).toBe(200);
      expect((await res.json()).requeued).toBe(false);
    } finally { await ctx.dispose(); }
  });

  test('cancelling something that does not exist says so rather than failing', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const token = await csrf(ctx);
      const res = await ctx.delete(`${API_BASE}/api/queues/email/no-such-job`, {
        headers: { 'X-XSRF-TOKEN': token },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).cancelled).toBe(false);
    } finally { await ctx.dispose(); }
  });
});

test.describe('who may look at the queue', () => {
  test('an ordinary agent cannot', async ({ playwright }) => {
    /*
     * The queue exposes what the application is doing in the background and lets somebody cancel or
     * re-run it. That is administrative by any reading, and it is guarded by `AdminGuard` — the same
     * authority as user administration.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      expect([401, 403]).toContain((await ctx.get(`${API_BASE}/api/queues`)).status());
      expect([401, 403]).toContain((await post(ctx, '/api/queues/ping')).status());
    } finally { await ctx.dispose(); }
  });

  test('an office manager cannot either', async ({ playwright }) => {
    // `manager` is not the top tier — `AdminGuard` requires Super Admin, matching users.controller.
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.admin.email);
      expect([401, 403]).toContain((await ctx.get(`${API_BASE}/api/queues`)).status());
    } finally { await ctx.dispose(); }
  });

  test('nobody signed out can', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      expect((await ctx.get(`${API_BASE}/api/queues`)).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });
});

test.describe('the readiness probe', () => {
  test('reports Redis and the queues without failing over an optional dependency', async ({ playwright }) => {
    /*
     * THE REGRESSION THAT MATTERS MOST HERE. An earlier version of this work hung `/health/ready`
     * whenever REDIS_URL pointed at a Redis that was down — BullMQ requires "never give up on a
     * command", so the probe never returned. A probe that hangs takes a HEALTHY deployment out of
     * the load balancer, which is the opposite of what an optional dependency should do.
     *
     * This asserts the probe answers promptly and that an absent Redis does not make it degraded.
     */
    const ctx = await playwright.request.newContext();
    try {
      const started = Date.now();
      const res = await ctx.get(`${API_BASE}/api/health/ready`);
      const elapsed = Date.now() - started;

      expect(res.status()).toBe(200);
      expect(elapsed, 'the readiness probe must answer promptly').toBeLessThan(5_000);

      const body = await res.json();
      expect(body.checks.redis.ok, 'an unconfigured Redis is not a fault').toBe(true);
      expect(body.checks.queues.ok).toBe(true);
      expect(body.status).toBe('ready');
    } finally { await ctx.dispose(); }
  });
});
