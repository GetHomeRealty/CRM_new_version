import { AsyncLocalStorage } from 'async_hooks';
import type { LoggerService, LogLevel } from '@nestjs/common';

/**
 * Structured logging.
 *
 * Every line is one JSON object on one line. That is the whole point: `grep`, `jq`, and every log
 * shipper ever written can read it, and nobody has to write a regex to pull a user id out of a
 * sentence. The previous output was Nest's default — coloured, aligned, human-shaped, and unusable
 * the moment you want to answer "which requests failed for this brokerage in the last hour".
 *
 * WHAT EVERY LINE CARRIES. Beyond the message: a request id, and — once authentication has run —
 * who was asking and which brokerage they belong to. Those three are what turn a log file into
 * something you can investigate with. A stack trace with no request id tells you something broke;
 * the same trace with `req`, `user` and `company` tells you what they were doing when it did.
 *
 * NO DEPENDENCY. This is deliberately not pino or winston. It is thirty lines of JSON.stringify
 * against a codebase that just removed twelve high-severity advisories from its dependency tree,
 * and a logger is not where new supply chain should be introduced.
 *
 * Pretty output is kept for local development, because a wall of JSON in a terminal you are
 * actively working in is worse than the thing it replaced.
 */

export interface RequestContext {
  /** Correlates every line emitted while serving one request. */
  id: string;
  method?: string;
  path?: string;
  userId?: number;
  companyId?: number | null;
  role?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Open a logging context for one request. */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The request being served, if any. Background work has none, and that is fine. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** Fill in who is asking, once authentication has worked it out. */
export function describeRequester(userId: number, companyId: number | null, role: string | null): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.userId = userId;
  ctx.companyId = companyId;
  ctx.role = role;
}

const LEVEL_ORDER: Record<string, number> = { debug: 10, verbose: 10, log: 20, info: 20, warn: 30, error: 40, fatal: 50 };
const MIN = LEVEL_ORDER[(process.env.LOG_LEVEL ?? 'log').toLowerCase()] ?? 20;

/** JSON in production, readable in a terminal. `LOG_FORMAT` overrides the guess. */
const FORMAT = (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')).toLowerCase();

/** Anything whose name suggests a secret is replaced rather than printed. */
const SECRET = /(password|secret|token|authorization|cookie|api[-_]?key|client[-_]?secret|refresh)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: string, context: string | undefined, message: unknown, extra?: Record<string, unknown>): void {
  if ((LEVEL_ORDER[level] ?? 20) < MIN) return;

  const req = storage.getStore();
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    ctx: context,
    msg: typeof message === 'string' ? message : scrub(message),
  };
  if (req) {
    line.req = req.id;
    if (req.method) line.method = req.method;
    if (req.path) line.path = req.path;
    if (req.userId !== undefined) line.user = req.userId;
    if (req.companyId !== undefined && req.companyId !== null) line.company = req.companyId;
    if (req.role) line.role = req.role;
  }
  if (extra) Object.assign(line, scrub(extra) as Record<string, unknown>);

  if (FORMAT === 'json') {
    process.stdout.write(JSON.stringify(line) + '\n');
    return;
  }

  const bits = [line.t, level.toUpperCase().padEnd(5), context ? `[${context}]` : '', req ? `(${req.id})` : '', String(line.msg)];
  const rest = extra ? ' ' + JSON.stringify(scrub(extra)) : '';
  process.stdout.write(bits.filter(Boolean).join(' ') + rest + '\n');
}

/** Direct access, for code that is not a Nest provider. */
export const log = {
  debug: (msg: unknown, ctx?: string, extra?: Record<string, unknown>) => emit('debug', ctx, msg, extra),
  info: (msg: unknown, ctx?: string, extra?: Record<string, unknown>) => emit('log', ctx, msg, extra),
  warn: (msg: unknown, ctx?: string, extra?: Record<string, unknown>) => emit('warn', ctx, msg, extra),
  error: (msg: unknown, ctx?: string, extra?: Record<string, unknown>) => emit('error', ctx, msg, extra),
};

/**
 * The LoggerService Nest itself uses.
 *
 * Installed in `main.ts`, so the 27 files already holding a `new Logger(...)` emit structured lines
 * without any of them being edited.
 */
export class StructuredLogger implements LoggerService {
  log(message: unknown, context?: string): void { emit('log', context, message); }
  error(message: unknown, stack?: string, context?: string): void {
    emit('error', context, message, stack ? { stack: String(stack).split('\n').slice(0, 12).join('\n') } : undefined);
  }
  warn(message: unknown, context?: string): void { emit('warn', context, message); }
  debug(message: unknown, context?: string): void { emit('debug', context, message); }
  verbose(message: unknown, context?: string): void { emit('debug', context, message); }
  setLogLevels?(_levels: LogLevel[]): void { /* level comes from LOG_LEVEL */ }
}
