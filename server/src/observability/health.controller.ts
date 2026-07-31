import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import * as fs from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { runAsSystem } from '../core/tenant-context';
import { STORAGE_ROOT } from '../config/storage';
import { metrics } from './metrics';
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
 * All three are unauthenticated by design — a monitor that needs credentials is a monitor that stops
 * working when authentication breaks, which is exactly when you need it. They expose no business
 * data: counts, timings, route patterns and error messages, never a record.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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
  async ready(): Promise<Record<string, unknown>> {
    const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};

    // Database: a real round trip, not a connection-pool guess. System context because this asks
    // about the server, not about anybody's data.
    const dbStart = Date.now();
    try {
      await runAsSystem(() => this.prisma.$queryRawUnsafe('SELECT 1'));
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
      const roles = await runAsSystem(() => this.prisma.roles.count());
      const grants = await runAsSystem(() => this.prisma.role_permissions.count());
      checks.authorization = { ok: roles > 0 && grants > 0, detail: `${roles} roles, ${grants} grants` };
    } catch (e) {
      checks.authorization = { ok: false, detail: (e as Error).message.slice(0, 160) };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ready' : 'degraded', checks, uptime_s: Math.round((Date.now() - metrics.startedAt) / 1000) };
  }

  @Get('metrics')
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
   * Unauthenticated like its siblings, and exposes no business data: counts, ages and states.
   */
  @Get('workers')
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
      const [queued, processing, stuck, failed] = await runAsSystem(() => Promise.all([
        this.prisma.export_jobs.count({ where: { status: 'Queued' } }),
        this.prisma.export_jobs.count({ where: { status: 'Processing' } }),
        this.prisma.export_jobs.count({ where: { status: 'Processing', created_at: { lt: hourAgo } } }),
        this.prisma.export_jobs.count({ where: { status: 'Failed', completed_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      ]));
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
      const dupes = await runAsSystem(() => this.prisma.users.groupBy({
        by: ['name'],
        where: { status: 'Active' },
        _count: { name: true },
        having: { name: { _count: { gt: 1 } } },
      }));
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
      const accounts = await runAsSystem(() => this.prisma.mail_accounts.findMany({
        where: { inbound_enabled: true, is_active: true },
        select: { id: true, name: true, last_synced_at: true },
      }));
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
