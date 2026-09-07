import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-022 — pressing Send Email always ends in a sentence.
 *
 * WHAT WAS MEASURED, and it is sharper than the entry's title. The button read 'Sending...' at every
 * sample from 1.5s to 15s and never changed; both `fetch` and `XMLHttpRequest` were watched for the
 * whole interaction and NO non-GET request was ever made; the DOM was searched for `role=status`,
 * `role=alert`, toast and snackbar nodes and there were none. So the send that would have produced a
 * message was never issued at all.
 *
 * WHY. The handler builds a PDF to attach BEFORE it sends, and that step is commented "attachment is
 * best-effort — never block the send" and guarded with `try/catch`. A `try/catch` catches a
 * REJECTION. This step's failure mode is a STALL: the PDF is rendered by mounting the document
 * offscreen and awaiting two chained `requestAnimationFrame` callbacks, which do not fire in a
 * throttled tab, and the PDF library is fetched on demand. Either leaves the promise pending, the
 * `await` never returns, and the send sits behind it — with `finally { setSending(false) }` never
 * reached, which is exactly the button that stays 'Sending...' for ever.
 *
 * THE ENTRY'S OTHER HALF IS ALREADY RIGHT and is left alone: a send with no recipient is refused by
 * the API with a sentence naming what to do about it ("Add a customer email, or set the
 * co-operating brokerage's invoice email on the transaction."). It never reached the user because of
 * the stall above, not because it was missing.
 *
 * WHY THIS READS SOURCE RATHER THAN CALLING THE HELPER. `withDeadline` lives in the client, which
 * has no unit runner. Importing it here compiles it under `client/tsconfig.json` — `module:
 * "ESNext"` — and emits a bare `export` into this CommonJS runner; pinning ts-jest's tsconfig does
 * not reach a file outside its `rootDir`. Bending the shared jest config for one import was not
 * worth it, so this asserts the shape instead, and says so rather than implying more than it checks.
 */

const read = (...parts: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', ...parts), 'utf8');

/** A file as it RUNS — the comments explain the fault and must not be mistaken for it. */
const stripped = (src: string): string =>
  src.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');

const HELPER = stripped(read('withDeadline.ts'));
const MODAL = stripped(read('InvoiceEditorModal.tsx'));

describe('the best-effort helper cannot wait for ever (TD-022)', () => {
  it('races the work against a timer rather than only catching a rejection', () => {
    // The distinction the defect turns on: `catch` sees a rejection, and this step's failure is a
    // promise that never settles at all.
    expect(HELPER).toContain('Promise.race');
    expect(HELPER).toMatch(/setTimeout\(\(\) => resolve\(fallback\)/);
  });

  it('still falls back on a rejection, which is the ordinary failure', () => {
    expect(HELPER).toMatch(/catch \{[\s\S]*?return fallback;/);
  });

  it('clears the timer however the race ends', () => {
    // A pending timer would hold the runner open and, in the browser, keep a dead render alive.
    expect(HELPER).toMatch(/finally \{[\s\S]*?clearTimeout\(timer\)/);
  });
});

describe('the Invoice editor’s Send Email (TD-022)', () => {
  const handler = MODAL.slice(MODAL.indexOf('const sendMail'), MODAL.indexOf('const sendReminder'));

  it('builds the attachment under a deadline instead of an open-ended await', () => {
    expect(MODAL).toContain('withDeadline<{ pdf?: string; filename?: string }>');
    expect(MODAL).toMatch(/PDF_DEADLINE_MS = 12_000/);
  });

  it('gives the deadline enough room for a slow but working render', () => {
    // Short enough that nobody concludes the button is broken, long enough that a working render
    // still attaches. A one-second deadline would "fix" the hang by losing every attachment.
    const ms = Number(/PDF_DEADLINE_MS = ([\d_]+)/.exec(MODAL)?.[1]?.replace(/_/g, ''));
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it('says something when it stops without sending', () => {
    // The second silence, and a real one: a save that came back without an id fell out of the
    // handler with no message, so the button returned to 'Send Email' as though nothing had been
    // pressed. Asserted on the handler's own early return — a toast elsewhere in a 400-line modal
    // would satisfy a looser check while this path stayed quiet.
    expect(handler).toMatch(/if \(!d\?\.id\) \{[^}]*toast\(/);
  });

  it('reports both outcomes of the send itself, and always releases the button', () => {
    expect(handler).toContain("'ok'");            // sent
    expect(handler).toContain('apiErrorMessage'); // and the server's own refusal, including the 422
    expect(handler).toContain('finally { setSending(false); }');
  });
});
