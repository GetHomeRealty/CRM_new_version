import { Injectable, Logger } from '@nestjs/common';
import {
  AUTH_URL, CALENDAR_API, MAIL_OAUTH_SCOPES, OAUTH_SCOPES, REVOKE_URL, TOKEN_URL, USERINFO_URL,
  clientId, clientSecret, mailClientId, mailClientSecret,
} from './google.constants';

/**
 * WHICH Google client a call belongs to.
 *
 * The Gmail connect may run against its own Google Cloud project so that its consent screen can be
 * named for mail rather than for the calendar (see `mailClientId`). A token is bound to the client
 * that issued it, so this choice has to be made identically at every step of a mailbox's life —
 * authorize, exchange, and every later refresh from IMAP and SMTP. Getting it right at authorize
 * and wrong at refresh produces a mailbox that connects and then stops working an hour later, which
 * is the failure this type exists to make hard to write.
 *
 * Defaults to `calendar` everywhere, so callers that predate the split keep their exact behaviour.
 */
export type GoogleClientKind = 'calendar' | 'mail';

const credentials = (kind: GoogleClientKind): { id: string; secret: string } =>
  kind === 'mail'
    ? { id: mailClientId(), secret: mailClientSecret() }
    : { id: clientId(), secret: clientSecret() };

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
}

/**
 * Talks to Google's OAuth and Calendar endpoints directly over `fetch` — no SDK, since each call
 * is a single request and a dependency here would only add a supply-chain surface to code holding
 * credentials.
 */
/**
 * A token request Google refused, with its `error` code intact.
 *
 * See `isPermanentAuthFailure` for why the code matters more than the sentence beside it.
 */
export class GoogleAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/**
 * What Google is asked to SHOW, shared by the Calendar and the Gmail flows.
 *
 * `select_account` is the account picker — the screen listing the Google accounts already signed in
 * on this browser, with "Use another account" underneath. Without it, Google skips straight past the
 * chooser to whichever account the browser is currently signed in as, and someone with a personal
 * and a work Google account has no way to say which one they meant. That is the whole complaint, and
 * it is not a regression: every commit in this repository's history has sent `prompt=consent` alone,
 * so the picker has never been requested. It costs nothing to ask for and Google does the rest — no
 * account list, no login screen and no password ever reaches this application.
 *
 * `consent` STAYS, and dropping it would be the expensive mistake here. With `access_type=offline`,
 * Google returns a refresh token only on an authorization that actually shows the consent screen;
 * a silent re-authorization returns an access token alone. `GoogleConnectionService.save` and
 * `GmailConnectService.upsert` both keep an existing refresh token when Google omits one, so the
 * damage would not appear on a reconnect — it would appear when the SAME Google account is
 * connected to the OTHER area, where there is no prior row to inherit from, and that connection
 * would have no way to refresh once its first hour expired.
 *
 * Order is not significant to Google, and both values are standard OIDC `prompt` values passed as a
 * space-delimited list.
 */
export const AUTH_PROMPT = 'select_account consent';

/**
 * The OAuth error codes that mean RECONNECTING is the only fix.
 *
 * `invalid_grant` is the one that matters: Google returns it when the user has revoked access in
 * their Google account, when the refresh token has expired through six months of disuse, or when the
 * password behind it changed. None of those recover on their own.
 *
 * `invalid_client` and `unauthorized_client` are ours rather than theirs — the app's credentials are
 * wrong or its grant was withdrawn — but they are equally permanent from the connection's point of
 * view, and leaving a connection "active" against them means retrying for ever.
 *
 * EVERYTHING ELSE IS TREATED AS TEMPORARY, deliberately. A 500, a 503, a rate limit and a socket
 * timeout all fix themselves, and deactivating a working integration because Google had a bad
 * minute would be a worse bug than the one this exists to fix: the agent would have to notice, and
 * then re-consent, for nothing.
 */
const PERMANENT_AUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export function isPermanentAuthFailure(err: unknown): boolean {
  if (err instanceof GoogleAuthError) return PERMANENT_AUTH_CODES.has(err.code);
  // A non-Google failure — DNS, a socket, our own bug — is never a reason to make somebody reconnect.
  return false;
}

@Injectable()
export class GoogleService {
  private readonly log = new Logger(GoogleService.name);

  /** The consent URL to send the user to. Google renders the account picker and consent itself. */
  authUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(' '),
      access_type: 'offline',
      prompt: AUTH_PROMPT,
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Consent URL for connecting a Gmail account to send/receive mail (SMTP/IMAP XOAUTH2 scope). */
  mailAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      // The mail project's client, so Google names its own consent screen for mail.
      client_id: mailClientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: MAIL_OAUTH_SCOPES.join(' '),
      access_type: 'offline',
      prompt: AUTH_PROMPT,
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** `kind` must match the client the authorization URL was built with, or Google answers
   *  `invalid_client` after the user has already consented. */
  async exchangeCode(code: string, redirectUri: string, kind: GoogleClientKind = 'calendar'): Promise<TokenResponse> {
    const { id, secret } = credentials(kind);
    return this.tokenRequest({
      code, client_id: id, client_secret: secret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    });
  }

  /** `kind` must match the client that issued the refresh token — a refresh token is not portable
   *  between Google clients, and presenting one to the wrong client fails permanently. */
  async refresh(refreshToken: string, kind: GoogleClientKind = 'calendar'): Promise<TokenResponse> {
    const { id, secret } = credentials(kind);
    return this.tokenRequest({
      refresh_token: refreshToken, client_id: id, client_secret: secret,
      grant_type: 'refresh_token',
    });
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const json = await res.json().catch(() => ({})) as TokenResponse & { error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      /*
       * THE CODE IS CARRIED, NOT JUST THE PROSE.
       *
       * This threw `error_description || error`, and `error_description` wins whenever Google sends
       * one — so the caller received "Token has been expired or revoked." with the machine-readable
       * `invalid_grant` discarded. Deciding whether a failure is permanent by pattern-matching
       * Google's English is the kind of check that breaks silently when they reword it.
       *
       * `GoogleAuthError` keeps both: `code` for the decision, `message` for the person reading it.
       */
      throw new GoogleAuthError(
        json.error || `http_${res.status}`,
        json.error_description || json.error || `Google token request failed (HTTP ${res.status}).`,
      );
    }
    return json;
  }

  /** Which Google account was connected. */
  async email(accessToken: string): Promise<string | null> {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({})) as { email?: string };
    return json.email ?? null;
  }

  /**
   * Events in the sync window. Returns the events plus Google's `nextSyncToken` for the next
   * incremental pull. Passing a stored `syncToken` returns only what changed.
   */
  async listEvents(accessToken: string, calendarId: string, opts: { timeMin?: string; timeMax?: string; syncToken?: string; maxResults: number }): Promise<{ events: GoogleEvent[]; nextSyncToken: string | null; expiredSyncToken: boolean }> {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: String(opts.maxResults) });
    if (opts.syncToken) params.set('syncToken', opts.syncToken);
    else {
      params.set('orderBy', 'startTime');
      if (opts.timeMin) params.set('timeMin', opts.timeMin);
      if (opts.timeMax) params.set('timeMax', opts.timeMax);
    }
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 410) return { events: [], nextSyncToken: null, expiredSyncToken: true }; // sync token stale → full resync
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar list failed (HTTP ${res.status}). ${body.slice(0, 160)}`);
    }
    const json = await res.json().catch(() => ({})) as { items?: GoogleEvent[]; nextSyncToken?: string };
    return { events: json.items ?? [], nextSyncToken: json.nextSyncToken ?? null, expiredSyncToken: false };
  }

  /** Create an event on the user's Google Calendar; returns the new Google event id. */
  async insertEvent(accessToken: string, calendarId: string, event: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar insert failed (HTTP ${res.status}). ${body.slice(0, 160)}`);
    }
    const json = await res.json().catch(() => ({})) as { id?: string };
    return json.id ?? null;
  }

  /**
   * Update an event already on the user's Google Calendar.
   *
   * PATCH rather than PUT, so fields this application does not model — attendees, conferencing,
   * recurrence, colour — are left as the user set them in Google rather than being erased by an
   * update that only knows about five columns.
   */
  async patchEvent(accessToken: string, calendarId: string, eventId: string, event: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      },
    );
    // Already gone from Google: nothing to update and nothing wrong. Treated as success so the
    // caller does not retry an event that no longer exists.
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar update failed (HTTP ${res.status}). ${body.slice(0, 160)}`);
    }
    return true;
  }

  /** Remove an event from the user's Google Calendar. Already-deleted counts as done. */
  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<boolean> {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar delete failed (HTTP ${res.status}). ${body.slice(0, 160)}`);
    }
    return true;
  }

  /**
   * Does this calendar hold this event? Read-only, and the only way to answer it for an event
   * outside the sync window.
   *
   * `listEvents` reaches 30 days back and 120 forward, so it cannot see the events that predate the
   * CRM/Desk split — which is exactly the population that still has no `domain` and shows on both
   * calendars. Fetching by id has no time bound, so asking each connected calendar in turn is what
   * settles which one an old event came from. Used only by
   * `scripts/relabel-legacy-google-events.cjs`; nothing on a request path calls it.
   *
   * Returns null for 404/410 — "this calendar does not have it" is an answer, not a failure. Any
   * other non-OK status throws, because a 401 or a 403 means the caller cannot conclude ABSENCE
   * from it, and treating that as "not here" would relabel events on the strength of an auth error.
   */
  async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEvent | null> {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Calendar lookup failed (HTTP ${res.status}). ${body.slice(0, 160)}`);
    }
    return (await res.json()) as GoogleEvent;
  }

  /** Best-effort revoke on disconnect; failure is logged, not surfaced. */
  async revoke(token: string): Promise<void> {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (ex) {
      this.log.warn(`Google token revoke failed: ${(ex as Error).message}`);
    }
  }
}
