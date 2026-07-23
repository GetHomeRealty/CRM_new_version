/**
 * Google Calendar OAuth configuration.
 *
 * Env-driven, exactly like the Meta integration: nothing is hard-coded, and until the OAuth
 * client credentials are present the feature reports itself unconfigured rather than pretending to
 * work. The consent screen the user sees is Google's own — this app only ever redirects to it.
 */

const env = (name: string): string => (process.env[name] ?? '').trim();

export const clientId = (): string => env('GOOGLE_CLIENT_ID');
export const clientSecret = (): string => env('GOOGLE_CLIENT_SECRET');

/** Enough configuration to start an OAuth connect at all. */
export const isConfigured = (): boolean => clientId() !== '' && clientSecret() !== '';

/** Path Google redirects back to. Must match an Authorised redirect URI in the Google Cloud client. */
export const OAUTH_CALLBACK_PATH = '/api/google/callback';

/**
 * Public base URL Google redirects back to. `GOOGLE_REDIRECT_URI` wins (set it to the exact value
 * registered in the Cloud console); otherwise it is derived from the request's own origin, which
 * is only internet-reachable in production.
 */
export const redirectUri = (origin: string): string => {
  const explicit = env('GOOGLE_REDIRECT_URI');
  if (explicit) return explicit;
  const base = (env('GOOGLE_PUBLIC_URL') || origin).replace(/\/+$/, '');
  return `${base}${OAUTH_CALLBACK_PATH}`;
};

/** Where the browser lands back in the SPA after the round-trip. */
export const frontendReturn = (outcome: string): string => {
  const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/app/account?${outcome}`;
};

/**
 * Scopes requested.
 *   - openid / email: to know which Google account was connected.
 *   - calendar.events: read AND write events, so the sync is two-way.
 * `calendar.events` is a "sensitive" scope in Google's review; the connection works for the
 * project's own test users immediately and for everyone once the OAuth consent screen is verified.
 */
export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** How far back and forward a pull reaches, and the cap per pull. */
export const SYNC_WINDOW_PAST_DAYS = 30;
export const SYNC_WINDOW_FUTURE_DAYS = 120;
export const MAX_EVENTS_PER_SYNC = 250;
