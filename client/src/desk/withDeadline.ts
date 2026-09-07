/**
 * TD-022 — run a best-effort step, but never wait on it for ever.
 *
 * `try/catch` catches a REJECTION. A step that simply never settles is not caught by anything, and
 * an `await` on it stops the function it is in — which is how the Invoice editor came to sit on
 * 'Sending...' for fifteen seconds having made no request at all: the PDF attachment it builds
 * before the send stalled, and the send that would have reported something was still queued behind
 * it.
 *
 * Anything described in its own comments as "best-effort" needs this shape rather than a `catch`,
 * because the failure that matters is the one where nothing happens.
 *
 * @param work     the promise to wait on
 * @param ms       how long to give it
 * @param fallback what to return if it stalls or fails — this is the "best-effort" part
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } catch {
    // A rejection is the ordinary failure and means the same thing here as a stall: no result.
    return fallback;
  } finally {
    // Cleared whichever way the race went, so a pending timer cannot hold the process — or, in a
    // test, keep the runner alive after the assertion has passed.
    if (timer) clearTimeout(timer);
  }
}
