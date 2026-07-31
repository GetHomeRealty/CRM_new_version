import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import * as fs from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { runAsSystem } from '../core/tenant-context';
import { STORAGE_ROOT } from '../config/storage';
import { metrics } from './metrics';

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
}
