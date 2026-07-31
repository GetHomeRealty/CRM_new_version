/**
 * What the process has been doing since it started.
 *
 * Deliberately in-memory and deliberately small: counters, a latency histogram, and the last few
 * errors. It answers the questions you actually ask at three in the morning — is it up, is it
 * slow, is it failing, and what was the last thing that broke — without a metrics backend to stand
 * up first.
 *
 * It is NOT a substitute for real monitoring. Numbers reset when the process restarts, and a second
 * instance would have its own set. What it gives you is a `/api/health/metrics` any uptime checker
 * can poll, and something to point a Prometheus scraper at later without changing the call sites.
 */

/** Latency buckets in milliseconds. Chosen around what this API actually does: 7-48ms warm. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface RouteStat {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

class Metrics {
  readonly startedAt = Date.now();
  private requests = 0;
  private errors = 0;
  private byStatus: Record<string, number> = {};
  private histogram = new Array(BUCKETS.length + 1).fill(0);
  private routes = new Map<string, RouteStat>();
  /** Enough to see a pattern, few enough that a crash loop cannot exhaust memory. */
  private recentErrors: { at: string; status: number; route: string; message: string; req?: string }[] = [];

  record(route: string, status: number, ms: number): void {
    this.requests += 1;
    const bucket = BUCKETS.findIndex((b) => ms <= b);
    this.histogram[bucket === -1 ? BUCKETS.length : bucket] += 1;
    const cls = `${Math.floor(status / 100)}xx`;
    this.byStatus[cls] = (this.byStatus[cls] ?? 0) + 1;
    if (status >= 500) this.errors += 1;

    const r = this.routes.get(route) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    r.count += 1;
    r.totalMs += ms;
    if (ms > r.maxMs) r.maxMs = ms;
    if (status >= 500) r.errors += 1;
    // Bounded: a route table that grows with every distinct id would be a memory leak, which is
    // why the interceptor records the ROUTE PATTERN rather than the URL.
    if (this.routes.size < 500) this.routes.set(route, r);
  }

  recordError(route: string, status: number, message: string, req?: string): void {
    this.recentErrors.unshift({ at: new Date().toISOString(), status, route, message: message.slice(0, 300), req });
    if (this.recentErrors.length > 25) this.recentErrors.pop();
  }

  /** An approximate percentile from the histogram — exact enough to spot a regression. */
  private percentile(p: number): number {
    const target = this.requests * p;
    let seen = 0;
    for (let i = 0; i < this.histogram.length; i++) {
      seen += this.histogram[i];
      if (seen >= target) return BUCKETS[i] ?? Infinity;
    }
    return 0;
  }

  snapshot(): Record<string, unknown> {
    const mem = process.memoryUsage();
    const slowest = [...this.routes.entries()]
      .map(([route, r]) => ({ route, count: r.count, avg_ms: Math.round(r.totalMs / r.count), max_ms: Math.round(r.maxMs), errors: r.errors }))
      .sort((a, b) => b.avg_ms - a.avg_ms)
      .slice(0, 10);

    return {
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      requests: this.requests,
      errors_5xx: this.errors,
      error_rate: this.requests ? Number((this.errors / this.requests).toFixed(4)) : 0,
      by_status: this.byStatus,
      latency_ms: { p50: this.percentile(0.5), p95: this.percentile(0.95), p99: this.percentile(0.99) },
      memory_mb: { rss: Math.round(mem.rss / 1048576), heap_used: Math.round(mem.heapUsed / 1048576) },
      slowest_routes: slowest,
      recent_errors: this.recentErrors,
    };
  }
}

export const metrics = new Metrics();
