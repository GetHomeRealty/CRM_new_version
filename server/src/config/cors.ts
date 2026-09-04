import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/*
 * TD-046 — WHAT THE BROWSER IS ALLOWED TO READ IS WHAT A DOWNLOAD IS CALLED.
 *
 * Every export route answers with `Content-Disposition: attachment; filename="…"`, and every
 * download helper on the client reads that header to name the file it saves. But
 * `Content-Disposition` is not a CORS-safelisted response header: cross-origin, the browser hides
 * it from JavaScript unless it is named in `Access-Control-Expose-Headers`. The helpers therefore
 * read `undefined` and fell back — on the document routes, to a bare `download` with no extension
 * at all. The reported symptom is a client one; the cause is here.
 *
 * It only bites where the SPA and the API are different origins. In production they are not —
 * `client/.env.production` leaves `VITE_API_URL` empty, so the SPA calls its own origin through the
 * reverse proxy — which is why this reads as a development-only fault. A deployment that ever
 * served the SPA from a separate host would take the defect with it.
 *
 * `X-Export-Rows` and `X-Export-Truncated` travel with the audit export and are read the same way.
 * That controller had already met this problem and set the header on its own response; that line is
 * left where it is (it is correct, and it documents itself), but it is no longer the only thing
 * holding those three headers open.
 */
export const EXPOSED_HEADERS = ['Content-Disposition', 'X-Export-Rows', 'X-Export-Truncated'];

/** CORS for the React SPA — credentials required for cookie auth. */
export function corsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  };
}
