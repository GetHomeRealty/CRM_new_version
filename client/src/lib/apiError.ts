import axios from 'axios';

/**
 * Strict-mode makes `catch` variables `unknown`. These helpers narrow an axios
 * error safely so the previous `err.response?.data?.…` reads keep working without
 * leaking `any`.
 */

/**
 * What an expired session says, in place of the framework's own word for it.
 *
 * A 401 arrives carrying `"Unauthenticated."` — accurate, and useless to the person reading it. It
 * was measured reaching the screen verbatim during the CRM › Triggers audit: clear the cookies,
 * press Save, and the toast reads "Unauthenticated." while the edits sit there with no route back
 * in. The reply has to say what happened and what to do about it, because there is nothing the user
 * can infer from that word.
 *
 * Matched on the STATUS, not the wording — a server that changes the string must not silently
 * reintroduce the raw version. A 401 whose body carries a genuinely explanatory message keeps it.
 */
const SESSION_EXPIRED = 'Your session has ended. Sign in again in another tab, then come back and press Save — your changes are still on screen.';
/** The framework defaults that mean "no session" and explain nothing. */
const OPAQUE_401 = /^(unauthenticated|unauthorized|unauthorised)\.?$/i;

/** Human message from an axios error's response body, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.message;
    if (err.response?.status === 401 && (typeof msg !== 'string' || !msg || OPAQUE_401.test(msg.trim()))) {
      return SESSION_EXPIRED;
    }
    if (typeof msg === 'string' && msg) return msg;
    // A request that never reached the server has no body to quote, and "Network Error" is the
    // same class of unhelpful. Say which of the two it was.
    if (!err.response) return 'Could not reach the server. Check your connection and try again.';
  }
  return fallback;
}

/**
 * TD-114 — whether a failed read failed because the caller is not allowed to make it.
 *
 * Lives here with the other two narrowings rather than in the screen that needed it, so `axios`
 * stays this module's dependency and a second screen asking the same question asks it the same way.
 * The distinction earns its place: a refusal is settled and retrying achieves nothing, where most
 * other failures are worth offering a Try again for.
 */
export function isForbidden(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 403;
}

/** Laravel 422 field errors ({ field: [msg, …] }) from an axios error, or null. */
export function apiFieldErrors(err: unknown): Record<string, string[]> | null {
  if (axios.isAxiosError(err)) {
    const errs = err.response?.data?.errors;
    if (errs && typeof errs === 'object') return errs as Record<string, string[]>;
  }
  return null;
}
