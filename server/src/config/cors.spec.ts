import { corsOptions, EXPOSED_HEADERS } from './cors';

/**
 * TD-046 — a downloaded file keeps the name the server gave it.
 *
 * The defect was a download saved as a random `.tmp` with no extension. Every client helper names
 * its file from `Content-Disposition`, but that header is not CORS-safelisted: unless the API names
 * it in `Access-Control-Expose-Headers`, a cross-origin SPA reads `undefined` and falls back — to
 * `download`, with no extension, on the document routes.
 *
 * This is the assertion that guards the return: it is one option on one call, invisible until
 * somebody downloads a file from a separately-hosted SPA, and nothing else in the suite would
 * notice it being dropped.
 */
describe('CORS exposes the headers a download is named from (TD-046)', () => {
  it('exposes Content-Disposition', () => {
    expect(corsOptions(['https://transaction.gethomehub.ca']).exposedHeaders)
      .toEqual(expect.arrayContaining(['Content-Disposition']));
  });

  it('exposes the audit export\'s row headers, which are read the same way', () => {
    expect(EXPOSED_HEADERS).toEqual(expect.arrayContaining(['X-Export-Rows', 'X-Export-Truncated']));
  });

  it('still carries the cookie-auth contract it always had', () => {
    // Widening the exposure must not have loosened anything else: the origins are still exactly the
    // configured list (never `*`, which cannot be combined with credentials anyway).
    const opts = corsOptions(['https://transaction.gethomehub.ca', 'https://gethomehub.ca']);
    expect(opts.credentials).toBe(true);
    expect(opts.origin).toEqual(['https://transaction.gethomehub.ca', 'https://gethomehub.ca']);
  });
});
