import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints called by an external service rather than the SPA, so there is no session and no
 * XSRF cookie to echo. Each MUST authenticate the caller some other way — the Meta webhook
 * verifies an `x-hub-signature-256` HMAC over the raw body before it acts on anything.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/meta/webhook',
  // Meta calls this when a user deletes the app from their Facebook account. Authenticated by
  // the app-secret-signed `signed_request` in the body, which is verified before anything runs.
  '/api/meta/data-deletion',
  // Twilio delivery reports and inbound replies. There is no session behind a webhook; both are
  // authenticated by their `X-Twilio-Signature` HMAC, checked before the body is read.
  '/api/sms/twilio/status',
  '/api/sms/twilio/inbound',
  '/api/sms/twilio/call-status',
  // Google redirects the browser here after consent; trusted via the signed OAuth `state`.
  '/api/google/callback',
]);

/**
 * CSRF protection matching the Sanctum SPA contract: the frontend fetches
 * `GET /sanctum/csrf-cookie` (which sets an `XSRF-TOKEN` cookie tied to the
 * session) and echoes it back as the `X-XSRF-TOKEN` header on every state-changing
 * request. This guard verifies that header against the session token. Applied
 * globally; safe (read-only) methods are exempt. On mismatch → HTTP 419.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    // Compare the path only — a query string must not be able to smuggle a match.
    if (CSRF_EXEMPT_PATHS.has(req.path)) return true;

    const headerRaw = req.headers['x-xsrf-token'];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const token = req.session?.csrfToken;

    // No token on the session at all means the session itself expired or was never
    // established — a different problem from a wrong token, and the far more common one.
    // Saying so lets the client refresh and retry instead of showing a cryptic mismatch.
    if (!token) {
      throw new HttpException(
        { message: 'Your session has expired. Refreshing — please try again.', expired: true },
        419,
      );
    }
    if (!header || header !== token) {
      throw new HttpException({ message: 'CSRF token mismatch.' }, 419);
    }
    return true;
  }
}
