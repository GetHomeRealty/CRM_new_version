import { Controller, Get, Header, HttpCode, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MetricsAccessGuard } from './metrics-access.guard';
import * as fs from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { STORAGE_ROOT } from '../config/storage';
import { metrics } from './metrics';
import { auditHealth } from './audit-health';
import { workerSnapshot } from './worker-health';

/**
 * Health and metrics.
 *
 * `/api/health` was already here and returned `{status:'ok'}` unconditionally — it would answer ok
 * with the database on fire, which makes it useless as anything but a "is the process running"
 * check. That is a real distinction, so both now exist and mean different things:
 *
 *   /api/health         LIVENESS. Is this process alive? Never touches a dependency. A restarter
 *                       watching this should only restart on a process that is genuinely wedged.
 *   /api/health/ready   READINESS. Can it actually serve? Checks the database and that storage is
 *                       writable. A load balancer should use THIS to decide whether to send traffic,
 *                       because a process that is up but cannot reach its database should not
 *                       receive requests.
 *   /api/health/metrics What it has been doing: throughput, latency percentiles, error rate, the
 *                       slowest routes and the last errors seen.
 *
 * WHO MAY READ WHAT, and why it is not the same answer for all of them.
 *
 * LIVENESS and READINESS stay open, because the original reasoning holds for them: a monitor that
 * needs credentials stops working exactly when authentication is what has broken, and a restarter or
 * a load balancer must keep getting an answer then. What they RETURN to an anonymous caller is now
 * trimmed — readiness reports which dependency is unhealthy, never the exception text, because
 * "database: not ok" is everything a load balancer needs and the message beneath it named a host, a
 * table or a path.
 *
 * METRICS and WORKERS are restricted, because "no business data" was true and not sufficient. They
 * carry the ten busiest route patterns, the last twenty-five 5xx messages at up to 300 characters
 * each — whatever happened to throw, including Prisma errors naming tables and columns — the process
 * memory and event-loop profile, and whether the audit trail is failing to write. That is a map and
 * a load profile for anyone probing. They now need a Super Admin session or the monitoring token;
 * see `MetricsAccessGuard`, which keeps the credential-free path available to infrastructure.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
  ) {}

  /** Liveness. Deliberately checks nothing external. */
  @Get()
  @Header('Cache-Control', 'no-store')
  live(): { status: string; uptime_s: number } {
    return { status: 'ok', uptime_s: Math.round((Date.now() - metrics.startedAt) / 1000) };
  }

  /**
   * Readiness. 200 when it can serve, 503 when it cannot.
   *
   * The status code is the point — a monitor should not have to parse the body to find out.
   */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async ready(@Req() req: Request): Promise<Record<string, unknown>> {
    const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};

    // Database: a real round trip, not a connection-pool guess. System context because this asks
    // about the server, not about anybody's data.
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      checks.database = { ok: true, ms: Date.now() - dbStart };
    } catch (e) {
      checks.database = { ok: false, ms: Date.now() - dbStart, detail: (e as Error).message.slice(0, 160) };
    }

    // Storage: writable, not merely present. A read-only mount is the failure that lets every page
    // load and every upload fail.
    const stStart = Date.now();
    const probe = join(STORAGE_ROOT, '.health-probe');
    try {
      await fs.mkdir(STORAGE_ROOT, { recursive: true });
      await fs.writeFile(probe, String(Date.now()));
      await fs.unlink(probe);
      checks.storage = { ok: true, ms: Date.now() - stStart };
    } catch (e) {
      checks.storage = { ok: false, ms: Date.now() - stStart, detail: (e as Error).message.slice(0, 160) };
    }

    // Authorization data. Fail-closed means an empty permission table locks everybody out, so an
    // empty one is an outage even though every process is running.
    try {
      const roles = await this.prisma.roles.count();
      const grants = await this.prisma.role_permissions.count();
      checks.authorization = { ok: roles > 0 && grants > 0, detail: `${roles} roles, ${grants} grants` };
    } catch (e) {
      checks.authorization = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    /*
     * Redis, and the queue that may or may not depend on it.
     *
     * REPORTED, NOT REQUIRED. Redis is optional here — an absent one means caching and distributed
     * queues are off and everything runs from Postgres, which is a supported configuration rather
     * than a fault. Marking it `ok: true` when it is not configured is deliberate: failing the
     * readiness probe over an optional dependency would pull a perfectly healthy deployment out of
     * the load balancer. A CONFIGURED Redis that is unreachable does count as degraded, because
     * then something really is wrong.
     */
    const redis = await this.redis.health();
    checks.redis = {
      ok: redis.status !== 'down',
      ms: redis.latency_ms,
      detail: redis.status === 'skipped' ? 'not configured — caching and distributed queues are off' : redis.status,
    };

    try {
      const stats = await this.queues.stats();
      const dead = stats.reduce((n, q) => n + q.dead, 0);
      checks.queues = {
        // A dead-lettered job is work that silently is not happening, so it is worth surfacing here
        // rather than only on the queue screen somebody has to remember to open.
        ok: dead === 0,
        detail: `${this.queues.driverKind}${this.queues.isWorker ? '' : ' (enqueue only)'}; ${dead} dead`,
      };
    } catch (e) {
      checks.queues = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    const ok = Object.values(checks).every((c) => c.ok);

    /*
     * THE `detail` STRINGS ARE FOR A PRIVILEGED CALLER ONLY.
     *
     * Each is up to 160 characters of an exception — a Prisma error naming a table, a filesystem
     * path, the host in a failed connection string. A load balancer needs to know THAT the database
     * is unhealthy, never why, so an anonymous caller gets the same shape with the reasons removed:
     * same keys, same `ok` flags, same status code, nothing to read.
     *
     * THE MONITORING TOKEN IS THE ONLY WAY TO THE DETAIL HERE, and a Super Admin session is not —
     * which is a consequence of this route being deliberately unguarded, not an oversight. Nothing
     * but `AuthGuard` populates `req.authUser`, and `AuthGuard` does not run on a route a load
     * balancer must reach without credentials; a role test here would read `undefined` on every
     * request that has ever been made and quietly always strip. Rather than leave a branch that
     * cannot be taken, the check is the one that works. The reasons are also in the log, where an
     * operator looking at a degraded deployment is already looking.
     */
    const shown = MetricsAccessGuard.tokenMatches(req)
      ? checks
      : Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, { ok: c.ok, ms: c.ms }]));

    return { status: ok ? 'ready' : 'degraded', checks: shown, uptime_s: Math.round((Date.now() - metrics.startedAt) / 1000) };
  }

  /**
   * Throughput, latency, the slowest routes and the last errors — RESTRICTED. See the class note and
   * `MetricsAccessGuard`: a Super Admin session or the monitoring token.
   */
  @Get('metrics')
  @UseGuards(MetricsAccessGuard)
  @Header('Cache-Control', 'no-store')
  snapshot(): Record<string, unknown> {
    return metrics.snapshot();
  }

  /**
   * The work that happens when nobody is watching: background timers, the export queue, mailbox
   * synchronisation, and this process's own resource use.
   *
   * Separate from `/ready` on purpose. None of this should take a server out of the load balancer —
   * an API whose Meta sync is stuck still serves every page correctly — but all of it fails
   * silently, which makes it precisely the category that needs a monitor rather than a user to
   * notice. `/ready` answers "should traffic come here"; this answers "is everything actually
   * getting done".
   *
   * RESTRICTED, for the same reasons as `metrics` — see the class note and `MetricsAccessGuard`. It
   * carries no business data, but the process profile and the scheduler `last_error` strings are
   * the same category of internal detail, and a monitor reaching one reaches the other.
   */
  @Get('workers')
  @UseGuards(MetricsAccessGuard)
  @Header('Cache-Control', 'no-store')
  async workers(): Promise<Record<string, unknown>> {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const uptimeS = Math.max(1, (Date.now() - metrics.startedAt) / 1000);

    const result: Record<string, unknown> = {
      process: {
        uptime_s: Math.round(uptimeS),
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
        // Share of ONE core, averaged over the life of the process — an average, so a spike will
        // not show here. It is the sustained figure that indicates a runaway loop.
        cpu_percent_avg: Math.round(((cpu.user + cpu.system) / 1000 / (uptimeS * 1000)) * 100),
        event_loop_lag_ms: await eventLoopLag(),
      },
      /**
       * Audit writes that failed.
       *
       * Surfaced here because audit writes are best-effort by design: they never fail a user's
       * action, so nothing else in the system would ever report that the compliance trail has
       * gaps. `failures` above zero means the audit log cannot be relied on as a complete record
       * until it is reconciled.
       */
      audit: auditHealth(),
      schedulers: workerSnapshot().map((w) => ({
        name: w.name,
        healthy: w.healthy,
        stale: w.stale,
        interval_s: Math.round(w.intervalMs / 1000),
        last_run_age_s: w.ageMs === null ? null : Math.round(w.ageMs / 1000),
        runs: w.runs,
        failures: w.failures,
        last_error: w.lastError,
      })),
    };

    // Export queue. "Processing" rows older than an hour are the interesting case: the sweeper
    // reclaims them on restart, so a stuck one means a job that is neither progressing nor failing.
    try {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const [queued, processing, stuck, failed] = await Promise.all([
        this.prisma.export_jobs.count({ where: { status: 'Queued' } }),
        this.prisma.export_jobs.count({ where: { status: 'Processing' } }),
        this.prisma.export_jobs.count({ where: { status: 'Processing', created_at: { lt: hourAgo } } }),
        this.prisma.export_jobs.count({ where: { status: 'Failed', completed_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      ]);
      result.jobs = { queued, processing, stuck_over_1h: stuck, failed_last_24h: failed, ok: stuck === 0 };
    } catch (e) {
      result.jobs = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    // Duplicate agent names.
    //
    // A name is a join key here: transactions record their agent as a name, team members are stored
    // by name, and commission splits, agent loan positions, document/notice email routing and
    // name-scoped visibility all resolve people from those strings. Two ACTIVE accounts sharing one
    // resolves to whichever the query planner offers — observed in this database, and capable of
    // changing after a VACUUM or a restore with no code change.
    //
    // New collisions are now rejected at the point of entry, so this exists to surface any that
    // predate that rule. It reports rather than fails: it is a data problem needing a human
    // decision about which account is which, not a reason to take a server out of rotation.
    try {
      const dupes = await this.prisma.users.groupBy({
        by: ['name'],
        where: { status: 'Active' },
        _count: { name: true },
        having: { name: { _count: { gt: 1 } } },
      });
      result.duplicate_agent_names = {
        ok: dupes.length === 0,
        count: dupes.length,
        names: dupes.map((d) => d.name).slice(0, 10),
        detail: dupes.length === 0
          ? 'every active user has a distinct name'
          : `${dupes.length} name(s) shared by more than one active user — commission splits and agent visibility resolve by name and cannot tell them apart`,
      };
    } catch (e) {
      result.duplicate_agent_names = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    // Mailbox synchronisation. Reported per enabled account, because one broken mailbox among five
    // is invisible in any aggregate — and it is somebody's whole inbox.
    try {
      const accounts = await this.prisma.mail_accounts.findMany({
        where: { inbound_enabled: true, is_active: true },
        select: { id: true, name: true, last_synced_at: true },
      });
      const now = Date.now();
      const stale = accounts.filter((a) => !a.last_synced_at || now - a.last_synced_at.getTime() > 30 * 60 * 1000);
      result.mail_sync = {
        ok: stale.length === 0,
        accounts: accounts.length,
        stale: stale.length,
        // Named, so an alert says which mailbox rather than just "one of them".
        stale_accounts: stale.slice(0, 10).map((a) => ({
          name: a.name,
          last_sync_age_s: a.last_synced_at ? Math.round((now - a.last_synced_at.getTime()) / 1000) : null,
        })),
      };
    } catch (e) {
      result.mail_sync = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    // Outgoing mail.
    //
    // WHY THIS IS SEPARATE FROM `mail_sync`. That block reports INBOUND freshness — whether IMAP is
    // still pulling. Sending fails independently of it: a revoked Google refresh token stops every
    // outbound message while the same mailbox keeps polling perfectly, so `mail_sync` stays green
    // throughout.
    //
    // WHY THE SCHEDULERS ABOVE DO NOT COVER IT EITHER. A sweep that records a failed send has done
    // its job and returns normally, so its `failures` counter stays at zero. On 2026-08-20 that
    // combination hid 43 sends that were both failing and being diverted, for 36 minutes, while
    // every indicator on this endpoint read healthy. Nothing here reported it because nothing here
    // looked at what the sweeps actually produced.
    //
    // `redirected` deserves its own number rather than being folded into failures. A diverted send
    // SUCCEEDS — the provider accepts it and the log records success — so it can never appear in a
    // failure count. In production a non-zero value has one meaning: MAIL_REDIRECT_TO reached a
    // live server and client mail is going to a sink instead of to clients.
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await this.prisma.crm_email_log.findMany({
        where: { created_at: { gte: dayAgo } },
        select: { success: true, error: true, redirected: true, sent_by: true },
      });

      const failed = recent.filter((r) => !r.success);
      const diverted = recent.filter((r) => !!r.redirected);
      // Auth failures are called out on their own because they are the recurring one, they take the
      // whole mailbox down rather than one message, and a reconnect is the fix. Anything else here
      // is usually a single bad recipient.
      const auth = failed.filter((r) => /invalid_grant|expired or revoked|invalid_client|unauthoriz/i.test(r.error ?? ''));

      // Which sending identity is failing. Each mailbox holds its own refresh token, so one agent's
      // automated mail can be dead while everyone else's is fine — invisible in any total.
      const bySender = new Map<string, number>();
      for (const r of auth) bySender.set(r.sent_by ?? '(unknown)', (bySender.get(r.sent_by ?? '(unknown)') ?? 0) + 1);

      // Age of the last send that actually left. The most useful single number when volume is low:
      // zero failures in 24 h means nothing if nothing was attempted.
      const lastOk = await this.prisma.crm_email_log.findFirst({
        where: { success: true },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
      });

      result.mail_send = {
        ok: failed.length === 0 && diverted.length === 0,
        sent_24h: recent.length - failed.length,
        failed_24h: failed.length,
        auth_failures_24h: auth.length,
        // Never legitimate on a production host.
        redirected_24h: diverted.length,
        redirected_to: diverted.length ? diverted[0].redirected : null,
        senders_failing_auth: [...bySender].slice(0, 10).map(([name, count]) => ({ name, count })),
        // `created_at` is nullable in the schema, so a row can exist without one. Treat that as
        // "unknown age" rather than reporting a nonsense figure derived from the epoch.
        last_success_age_s: lastOk?.created_at
          ? Math.round((Date.now() - lastOk.created_at.getTime()) / 1000)
          : null,
        detail: diverted.length
          ? `${diverted.length} send(s) diverted to ${diverted[0].redirected} — MAIL_REDIRECT_TO is set on this server and client mail is not being delivered`
          : auth.length
            ? `${auth.length} send(s) refused by the mail provider — reconnect the affected mailbox`
            : failed.length
              ? `${failed.length} send(s) failed in the last 24 h`
              : 'no outgoing mail failed in the last 24 h',
      };
    } catch (e) {
      result.mail_send = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    return result;
  }
}

/**
 * How long a zero-delay timer actually took to fire. A blocked event loop is what a "the whole app
 * went slow for everyone at once" report looks like from the inside, and it is invisible in request
 * latency until it is already severe.
 */
function eventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint();
    setImmediate(() => resolve(Math.round(Number(process.hrtime.bigint() - t) / 1e6)));
  });
}
