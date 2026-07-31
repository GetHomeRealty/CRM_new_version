import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { currentRequest, log } from './log';
import { metrics } from './metrics';

/**
 * Catch every unhandled error, record it, and then hand it straight back to Nest.
 *
 * THIS FILTER DOES NOT SHAPE RESPONSES, on purpose. The API answers in Laravel's vocabulary — 422
 * with a `errors` map, 403 with `{ message }`, 404 with "No query results for model [...]" — and
 * the client reads those shapes. A filter that "helpfully" standardised them would be an API change
 * wearing an observability costume, and would break the frontend. So it extends
 * `BaseExceptionFilter` and delegates: the bytes on the wire are exactly what they were before.
 *
 * What it adds is that nothing fails silently. Before this, an unhandled exception produced Nest's
 * default 500 and a stack trace on stdout with no request id, no user and no route — which is to
 * say, an incident with no evidence.
 *
 * The distinction that matters: an HttpException is the application deciding to refuse (a 403 is a
 * guard working correctly, not an incident). Anything else is a bug, and is logged as an error with
 * its stack.
 */
@Catch()
export class ErrorLogFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request>();
      const ctx = currentRequest();
      const route = `${req?.method ?? '?'} ${req?.originalUrl?.split('?')[0] ?? '?'}`;

      if (exception instanceof HttpException) {
        const status = exception.getStatus();
        if (status >= 500) {
          log.error(exception.message, 'HttpException', { status, route, stack: exception.stack?.split('\n').slice(0, 8).join('\n') });
          metrics.recordError(route, status, exception.message, ctx?.id);
        }
        // 4xx is a decision, not a failure. The interceptor has already logged the request line.
      } else {
        const err = exception as Error;
        log.error(err?.message ?? String(exception), 'Unhandled', {
          route,
          name: err?.name,
          stack: err?.stack?.split('\n').slice(0, 12).join('\n'),
        });
        metrics.recordError(route, 500, err?.message ?? String(exception), ctx?.id);
      }
    }

    // Nest's own handling, unchanged.
    super.catch(exception, host);
  }
}
