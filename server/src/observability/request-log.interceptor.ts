import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { describeRequester, log, withRequestContext } from './log';
import { metrics } from './metrics';

/**
 * One line per request, and a correlation id that every other line inherits.
 *
 * WHY THE SUBSCRIPTION IS WRAPPED, not just the call. The obvious shape —
 *
 *     return withRequestContext(ctx, () => next.handle().pipe(tap(...)))
 *
 * does not work, and fails silently in a way worth recording. `next.handle()` returns a COLD
 * observable: nothing runs until Nest subscribes to it, which happens after this method has already
 * returned and the AsyncLocalStorage scope has closed. The tap callbacks then execute with no
 * context at all — so the user and brokerage never reached the log line, and the request id only
 * appeared because it was also being passed explicitly. It looked like it worked.
 *
 * Subscribing INSIDE the scope is what actually carries the context through the handler and into
 * everything it calls, so a warning logged four layers down in a service carries the same `req` id
 * as the request line. This is the same lazy-evaluation trap as a Prisma promise built inside a
 * scope and awaited outside it.
 *
 * WHAT IS RECORDED FOR METRICS is the route PATTERN (`/api/leads/:id`), never the URL. Recording
 * URLs would grow the route table by one entry per record ever fetched — a memory leak wearing a
 * metrics costume.
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { authUser?: { id: number; role?: string | null } }>();
    const res = http.getResponse<Response>();

    // Honour an id from a proxy or load balancer so a trace survives the hop.
    const id = String(req.headers['x-request-id'] ?? '') || randomBytes(6).toString('hex');
    const started = Date.now();
    // `ip` honours the trust-proxy setting Express is configured with, so behind a load balancer
    // this is the client rather than the balancer. Both are clipped: they end up in a varchar, and
    // a header is attacker-controlled length.
    const ctx = {
      id,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      ip: (req.ip ?? '').slice(0, 45) || null,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 255) || null,
    };

    /*
     * ================================================================================================
     * THIS METHOD RUNS AT SUBSCRIBE TIME, NOT WHEN THE ROUTE IS CALLED — AND FOR A STREAM THAT IS
     * AFTER THE RESPONSE HEADERS HAVE ALREADY GONE OUT.
     *
     * Nest wraps the interceptor chain in rxjs `defer()`, so nothing in here executes until Nest
     * subscribes to the returned observable. For an ordinary route that is immediately, and the
     * difference never shows. For a Server-Sent-Events route Nest does this, in this order:
     *
     *     const stream = new SseStream(req);
     *     stream.pipe(res);        // writeHead(200) + flushHeaders() -- headers are now SENT
     *     result.subscribe(...);   // <- only now does this method run
     *
     * So `res.setHeader(...)` here threw ERR_HTTP_HEADERS_SENT, rxjs delivered it as the
     * observable's error, and Nest wrote it to the client as `event: error / data: Cannot set
     * headers after they are sent to the client` before closing the stream. Every SSE endpoint in
     * the application was dead on arrival, and the message named the symptom rather than the cause.
     *
     * Diagnosed by wrapping `res.setHeader` in a probe that logged a stack whenever it was called
     * with `headersSent` already true; the stack named this line, reached through `defer`.
     * ================================================================================================
     *
     * GUARDED RATHER THAN MOVED. The check is `headersSent`, not "is this SSE", because the deferred
     * execution is general: any future route that writes to the response before this subscribes has
     * the same problem, and a rule that only knows about SSE would not cover it. An SSE response
     * therefore carries no `X-Request-Id` — the header was already on the wire before this code got
     * to run, and a correlation id is not worth failing a request for.
     */
    if (!res.headersSent) res.setHeader('X-Request-Id', id);

    /*
     * A SERVER-SENT-EVENT ROUTE IS ALSO PASSED STRAIGHT THROUGH, which is a separate point from the
     * header guard above and would be worth doing even if headers were never an issue.
     *
     * This logs a request when its observable COMPLETES, which for a stream is when the browser
     * disconnects — minutes or hours later. Every open Inbox would sit unlogged, then record a
     * "request" whose duration is how long somebody had the tab open, and `metrics.record` would
     * carry that into the latency figures. Logging it as it opens is the only honest moment a
     * long-lived stream has.
     *
     * Returning `next.handle()` unwrapped also leaves Nest's own observable intact, which is what
     * the SSE machinery is built to consume.
     */
    if (this.reflector.get<boolean>(SSE_METADATA, context.getHandler())) {
      log.info(`${req.method} ${ctxPath(req)} stream opened`, 'HTTP', { status: 200, ms: 0 });
      return next.handle();
    }

    return new Observable((subscriber) =>
      withRequestContext(ctx, () =>
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (err: unknown) => {
            // The status is not on the response yet — the filter sets it. Read it from the
            // exception so a failure is not recorded as a 200.
            this.finish(req, res, started, (err as { status?: number })?.status ?? 500);
            subscriber.error(err);
          },
          complete: () => {
            this.finish(req, res, started);
            subscriber.complete();
          },
        }),
      ),
    );
  }

  private finish(
    req: Request & { authUser?: { id: number; role?: string | null } },
    res: Response,
    started: number,
    forcedStatus?: number,
  ): void {
    const ms = Date.now() - started;
    const status = forcedStatus ?? res.statusCode;

    // Guards have run, so this is the first point at which the requester is knowable. It mutates the
    // context the whole request shares, which is why this has to happen inside the scope.
    if (req.authUser) describeRequester(req.authUser.id, req.authUser.role ?? null);

    // The route pattern as Express matched it — what keeps metric cardinality bounded.
    const route = (req.route?.path as string | undefined) ?? req.path ?? 'unknown';
    metrics.record(`${req.method} ${req.baseUrl ?? ''}${route}`, status, ms);

    // 4xx is the application telling somebody no — normal traffic. 5xx is the application failing,
    // and is the thing worth alerting on.
    log[status >= 500 ? 'error' : 'info'](`${req.method} ${ctxPath(req)} ${status}`, 'HTTP', { status, ms });
  }
}

function ctxPath(req: Request): string {
  return req.originalUrl?.split('?')[0] ?? req.path ?? '?';
}
