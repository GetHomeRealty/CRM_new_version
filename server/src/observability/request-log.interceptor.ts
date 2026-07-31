import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
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
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { authUser?: { id: number; role?: string | null; company_id?: number } }>();
    const res = http.getResponse<Response>();

    // Honour an id from a proxy or load balancer so a trace survives the hop.
    const id = String(req.headers['x-request-id'] ?? '') || randomBytes(6).toString('hex');
    const started = Date.now();
    const ctx = { id, method: req.method, path: req.originalUrl?.split('?')[0] };

    res.setHeader('X-Request-Id', id);

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
    req: Request & { authUser?: { id: number; role?: string | null; company_id?: number } },
    res: Response,
    started: number,
    forcedStatus?: number,
  ): void {
    const ms = Date.now() - started;
    const status = forcedStatus ?? res.statusCode;

    // Guards have run, so this is the first point at which the requester is knowable. It mutates the
    // context the whole request shares, which is why this has to happen inside the scope.
    if (req.authUser) describeRequester(req.authUser.id, req.authUser.company_id ?? null, req.authUser.role ?? null);

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
