import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

const baseURL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

/**
 * Pre-configured axios instance for talking to the Laravel API.
 *
 * `withCredentials` + `withXSRFToken` make the browser send the Sanctum
 * session cookie and the X-XSRF-TOKEN header on cross-origin requests, which
 * is what powers cookie-based SPA authentication.
 */
const api: AxiosInstance = axios.create({
  baseURL,
  withCredentials: true,
  withXSRFToken: true,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  },
});

/**
 * Fetch the CSRF cookie from Sanctum. Must be called once before the first
 * state-changing request (login / register / logout).
 */
export const getCsrfCookie = (): Promise<AxiosResponse> => api.get('/sanctum/csrf-cookie');

/**
 * Recover from a stale CSRF token.
 *
 * The XSRF-TOKEN cookie and the session that holds its counterpart can fall out of step — the
 * session times out, or the API is restarted — and the next save then fails with 419 and the
 * user loses whatever they had typed. Rather than surfacing that, fetch a fresh token and replay
 * the request once.
 *
 * Retried exactly once per request (`_csrfRetried`), so a genuinely expired login surfaces as
 * the 401 it really is instead of looping.
 */
api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 419) throw error;

    const request = error.config as (typeof error.config & { _csrfRetried?: boolean }) | undefined;
    // A failure on the token endpoint itself can't be fixed by asking it again.
    if (!request || request._csrfRetried || String(request.url ?? '').includes('/sanctum/csrf-cookie')) {
      throw error;
    }

    request._csrfRetried = true;
    try {
      await getCsrfCookie();
    } catch {
      throw error; // still unreachable or truly signed out — report the original failure
    }
    return api.request(request);
  },
);

export default api;
