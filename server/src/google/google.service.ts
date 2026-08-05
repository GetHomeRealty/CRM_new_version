import { Injectable, Logger } from '@nestjs/common';
import {
  AUTH_URL, CALENDAR_API, MAIL_OAUTH_SCOPES, OAUTH_SCOPES, REVOKE_URL, TOKEN_URL, USERINFO_URL,
  clientId, clientSecret,
} from './google.constants';

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
      // offline + consent so Google returns a refresh token we can keep syncing with.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Consent URL for connecting a Gmail account to send/receive mail (SMTP/IMAP XOAUTH2 scope). */
  mailAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: MAIL_OAUTH_SCOPES.join(' '),
      // offline + consent so Google returns a refresh token we can keep sending/receiving with.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    return this.tokenRequest({
      code, client_id: clientId(), client_secret: clientSecret(),
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      refresh_token: refreshToken, client_id: clientId(), client_secret: clientSecret(),
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

  /** Best-effort revoke on disconnect; failure is logged, not surfaced. */
  async revoke(token: string): Promise<void> {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (ex) {
      this.log.warn(`Google token revoke failed: ${(ex as Error).message}`);
    }
  }
}
