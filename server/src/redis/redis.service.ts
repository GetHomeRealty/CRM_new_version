import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * The Redis connection — and the rule that its absence is a non-event.
 *
 * WHY OPTIONAL IS THE WHOLE DESIGN. This deployment has no Redis in production yet. A cache or a
 * queue that *requires* one would mean this feature cannot ship at all until infrastructure catches
 * up, and — far worse — a Redis that fails at 3 a.m. would take the application down with it. Every
 * read here answers "not cached" when Redis is unreachable, and every write is dropped. Nothing
 * stored in Redis is the only copy of anything: it is a faster path to data Postgres already holds.
 *
 * So there are exactly two states, both correct:
 *   REDIS_URL unset   — `enabled()` is false, nothing connects, the application behaves as it did
 *                       before this module existed.
 *   REDIS_URL set     — a connection is made, and if it drops the application keeps serving from
 *                       Postgres while ioredis reconnects underneath.
 *
 * KEYS ARE NAMESPACED by `REDIS_PREFIX` (default `ghr:`) so a Redis shared with another application
 * — or with a second environment pointed at the same server by mistake — cannot collide. Getting
 * that wrong is silent: staging would read production's cached permissions and nobody would see an
 * error, only wrong answers.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  private client: Redis | null = null;
  private connected = false;
  /** Logged once rather than per operation — a down Redis must not fill the disk with warnings. */
  private warned = false;

  constructor() {
    const url = (process.env.REDIS_URL ?? '').trim();
    if (!url) {
      this.log.log('REDIS_URL is not set — caching and distributed queues are off, everything runs in-process.');
      return;
    }
    this.client = new Redis(url, this.options());
    this.attach(this.client);
  }

  /** The key prefix for this deployment. Public so tests and diagnostics can build real keys. */
  static prefix(): string {
    const raw = (process.env.REDIS_PREFIX ?? 'ghr').trim().replace(/:+$/, '');
    return `${raw || 'ghr'}:`;
  }

  private options(): RedisOptions {
    return {
      /*
       * Commands issued while disconnected FAIL FAST instead of queueing. The default (`true`) holds
       * them in memory until the connection returns, which turns a Redis outage into unbounded
       * memory growth and requests that hang rather than fall back to Postgres — the opposite of
       * what this whole design is for.
       */
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,   // BullMQ requires null; a blocking read must not be given up on
      lazyConnect: false,
      connectTimeout: 5_000,
      /** Capped exponential backoff, so a long outage does not become a reconnect storm. */
      retryStrategy: (times: number) => Math.min(1_000 * 2 ** Math.min(times, 5), 30_000),
    };
  }

  private attach(client: Redis): void {
    client.on('ready', () => {
      this.connected = true;
      this.warned = false;
      this.log.log(`Redis is connected (prefix "${RedisService.prefix()}").`);
    });
    client.on('end', () => { this.connected = false; });
    client.on('close', () => { this.connected = false; });
    client.on('error', (err: Error) => {
      this.connected = false;
      // Once per outage. ioredis emits on every retry, and a Redis that is simply not installed
      // would otherwise print a line every few seconds for the life of the process.
      if (!this.warned) {
        this.warned = true;
        this.log.warn(`Redis is unreachable (${err.message}). Falling back to the database; this is not fatal.`);
      }
    });
  }

  /** Whether Redis is configured AT ALL. False means this deployment simply does not use it. */
  enabled(): boolean {
    return this.client !== null;
  }

  /** Whether it is configured AND currently usable. Every operation checks this. */
  ready(): boolean {
    return this.client !== null && this.connected;
  }

  /**
   * The raw client, for callers that need Redis itself — BullMQ takes a connection, not a wrapper.
   * Null when unconfigured, which is how the queue layer decides which driver to use.
   */
  raw(): Redis | null {
    return this.client;
  }

  /** A namespaced key. Never build one by hand; a stray un-prefixed key is invisible until it collides. */
  key(...parts: Array<string | number>): string {
    return RedisService.prefix() + parts.map((p) => String(p)).join(':');
  }

  /**
   * Give any Redis command a hard deadline.
   *
   * THIS IS NOT BELT AND BRACES — it fixes a hang that was measured, not imagined. `maxRetriesPerRequest`
   * must be `null` for BullMQ's blocking reads, and that setting means "never give up on a command".
   * Against a configured-but-unreachable Redis the promise therefore NEVER SETTLES: the first version
   * of `health()` hung `/api/health/ready` indefinitely, which would have taken a healthy deployment
   * out of the load balancer during a Redis outage — precisely the failure this whole module is
   * designed to avoid.
   *
   * Every command that can be reached from a request goes through here. The fallback value is what
   * the caller gets when Redis is slow or gone, which for a cache is always "no answer".
   */
  async withTimeout<T>(operation: Promise<T>, fallback: T, ms = RedisService.COMMAND_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * How long any single Redis command may take before the caller gives up and uses Postgres.
   *
   * Deliberately short. A cache exists to be faster than the database; one that takes longer than
   * this to answer has stopped being a cache and become a delay.
   */
  static readonly COMMAND_TIMEOUT_MS = 1_000;

  // ------------------------------------------------------------------ health

  /**
   * A real round trip, for the readiness probe.
   *
   * Reports `skipped` rather than a failure when Redis is not configured: a probe that fails because
   * an optional dependency is absent would take a healthy deployment out of the load balancer.
   */
  async health(): Promise<{ status: 'ok' | 'down' | 'skipped'; latency_ms?: number; error?: string }> {
    if (!this.client) return { status: 'skipped' };
    const started = Date.now();
    // Raced against a deadline: an unreachable Redis leaves `ping()` pending for ever (see
    // `withTimeout`), so awaiting it directly is what hung the probe.
    const pong = await this.withTimeout(this.client.ping().then(() => true).catch(() => false), false);
    return pong
      ? { status: 'ok', latency_ms: Date.now() - started }
      : { status: 'down', error: 'no response within the command timeout' };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
