import axios from 'axios';

/**
 * Strict-mode makes `catch` variables `unknown`. These helpers narrow an axios
 * error safely so the previous `err.response?.data?.…` reads keep working without
 * leaking `any`.
 */

/** Human message from an axios error's response body, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}

/** Laravel 422 field errors ({ field: [msg, …] }) from an axios error, or null. */
export function apiFieldErrors(err: unknown): Record<string, string[]> | null {
  if (axios.isAxiosError(err)) {
    const errs = err.response?.data?.errors;
    if (errs && typeof errs === 'object') return errs as Record<string, string[]>;
  }
  return null;
}
