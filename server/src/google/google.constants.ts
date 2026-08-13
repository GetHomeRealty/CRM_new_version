/**
 * Google Calendar OAuth configuration.
 *
 * Env-driven, exactly like the Meta integration: nothing is hard-coded, and until the OAuth
 * client credentials are present the feature reports itself unconfigured rather than pretending to
 * work. The consent screen the user sees is Google's own — this app only ever redirects to it.
 */

import { areaPath } from '../common/domain';

const env = (name: string): string => (process.env[name] ?? '').trim();

export const clientId = (): string => env('GOOGLE_CLIENT_ID');
export const clientSecret = (): string => env('GOOGLE_CLIENT_SECRET');

/**
 * A SECOND Google client, used by the Gmail connect only.
 *
 * WHY THIS EXISTS AT ALL. The name on Google's screens — "Choose an account to continue to X",
 * "X wants to access your Google Account" — is the OAuth consent screen's App name, which belongs
 * to the Google Cloud PROJECT. It is not sent by this application and cannot be: no request
 * parameter carries it. So one project means one name on both flows, and an agent connecting a
 * mailbox was being asked to let "Calendar-integration" read, compose, send and permanently delete
 * all their email — which is what a phishing screen looks like, and which people rightly refuse.
 * The only way to say "Mail-integration" on the mail flow is a second project with its own consent
 * screen, and a project's clients are its own; hence a second id and secret rather than a setting.
 *
 * FALLS BACK TO THE MAIN PAIR when unset, so this changes nothing until the second project exists.
 *
 * BOTH VALUES OR NEITHER. A half-configured pair — an id from the new project with the old secret
 * — fails at the token exchange with `invalid_client`, after the user has already picked an account
 * and granted consent. `isMailConfigured` refuses to start a flow that cannot finish.
 *
 * THE SECOND PROJECT MUST REGISTER THE SAME REDIRECT URI (`OAUTH_CALLBACK_PATH`). One callback
 * serves both flows and tells them apart by the signed state's purpose, not by the URL.
 */
export const mailClientId = (): string => env('GOOGLE_MAIL_CLIENT_ID') || clientId();
export const mailClientSecret = (): string => env('GOOGLE_MAIL_CLIENT_SECRET') || clientSecret();

/** Enough configuration to start an OAuth connect at all. */
export const isConfigured = (): boolean => clientId() !== '' && clientSecret() !== '';

/**
 * Whether a Gmail connect can be started AND finished.
 *
 * Separate from `isConfigured` because the mail flow can be configured independently, and because
 * a mismatched pair is worse than an absent one: the failure lands after consent rather than on the
 * button.
 */
export const isMailConfigured = (): boolean => {
  const id = env('GOOGLE_MAIL_CLIENT_ID');
  const secret = env('GOOGLE_MAIL_CLIENT_SECRET');
  // Only one of the two set: refuse rather than silently pairing it with the calendar project's
  // other half, which would exchange a code issued to one client using another's credentials.
  if ((id === '') !== (secret === '')) return false;
  return mailClientId() !== '' && mailClientSecret() !== '';
};

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
  return `${base}${areaPath('desk', 'account')}?${outcome}`;
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

/**
 * Scopes for connecting a Gmail account to SEND and RECEIVE mail over SMTP/IMAP with XOAUTH2.
 * `https://mail.google.com/` is the scope Google requires for SMTP/IMAP access — it is a
 * "restricted" scope, so the OAuth consent screen must be verified for use beyond test users.
 */
export const MAIL_OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://mail.google.com/',
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

/**
 * What `created_by` says on an event that ARRIVED FROM Google, and the only reliable way to tell
 * one from an event of the agent's own.
 *
 * `google_calendar_id` cannot answer this. It is set on both directions of the sync: on an event
 * pulled from Google, and equally on an agent's own appointment once it has been mirrored out —
 * `pushEvent` writes the id Google hands back. There are events in this database created by a named
 * agent that carry one. Treating "has a Google id" as "came from Google" would therefore delete an
 * agent's own appointments when they disconnected, which is the one outcome a disconnect must never
 * produce.
 *
 * `applyGoogleEvent` writes this on create and deliberately never on update, so an agent's own event
 * that Google later echoes back keeps their name and is not mistaken for Google's.
 */
export const GOOGLE_ORIGIN_CREATED_BY = 'Google Calendar';
