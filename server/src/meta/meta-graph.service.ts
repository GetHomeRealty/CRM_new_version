import { Injectable, Logger } from '@nestjs/common';
import {
  AUTH_FAILURE_CODES,
  FORM_FIELDS, GRAPH_TIMEOUT_MS, LEADS_PAGE_SIZE, LEAD_FIELDS, LEAD_FIELDS_WITH_ADS, PAGE_FIELDS,
  appId, appSecret, graphOrigin, loginConfigId,
  oauthDialogUrl, oauthStrategy, OAUTH_SCOPES, systemUserOverride,
} from './meta.constants';

export interface GraphPage { id: string; name: string; access_token: string }
export interface GraphForm { id: string; name: string; status?: string; leads_count?: number; created_time?: string }
export interface GraphLead { id: string; created_time?: string; field_data?: { name?: string; values?: string[] }[] }

/** A Graph call that failed, carrying Meta's own message so the UI can show the real cause. */
export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly subcode?: number) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * Thin wrapper over the Facebook Graph API. Everything that talks to Meta goes through here, so
 * token handling and error shaping live in one place.
 */
@Injectable()
export class MetaGraphService {
  private readonly log = new Logger(MetaGraphService.name);

  /**
   * The OAuth dialog URL. Business-type apps must use `config_id`; sending `scope` alone gets
   * "This app needs at least one supported permission", which is why the strategy is explicit.
   */
  buildAuthUrl(redirectUri: string, state: string): string {
    const url = new URL(oauthDialogUrl());
    url.searchParams.set('client_id', appId());
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    const strategy = oauthStrategy();
    const configId = loginConfigId();

    if (configId && strategy !== 'scope') {
      url.searchParams.set('config_id', configId);
      // Only valid for System-user token configurations — on a User-token config it causes the
      // same "needs at least one supported permission" failure it is meant to avoid.
      if (systemUserOverride()) url.searchParams.set('override_default_response_type', 'true');
      if (strategy === 'hybrid') url.searchParams.set('scope', OAUTH_SCOPES.join(','));
      return url.toString();
    }

    url.searchParams.set('scope', OAUTH_SCOPES.join(','));
    return url.toString();
  }

  /** Exchange the one-time code for a user access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    // The secret goes in the POST body, which is correct and unchanged. Only the deadline is new.
    const res = await fetch(`${graphOrigin()}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId(), client_secret: appSecret(), redirect_uri: redirectUri, code,
      }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) throw this.toError(body, res.status, 'Token exchange failed');
    const token = this.parse(body)?.access_token;
    if (!token) throw new GraphError('Meta did not return an access token.', 502);
    return String(token);
  }

  /**
   * Upgrade a short-lived token to the ~60-day long-lived one. Best-effort: if the exchange
   * fails the short-lived token still works, it just expires in about an hour.
   */
  async longLivedToken(shortLived: string): Promise<string> {
    try {
      const q = new URLSearchParams({
        grant_type: 'fb_exchange_token', client_id: appId(),
        client_secret: appSecret(), fb_exchange_token: shortLived,
      });
      const res = await fetch(`${graphOrigin()}/oauth/access_token?${q}`, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
      if (!res.ok) {
        this.log.warn(`Long-lived token exchange failed (${res.status}); keeping the short-lived token.`);
        return shortLived;
      }
      return String(this.parse(await res.text())?.access_token ?? shortLived);
    } catch (err) {
      this.log.warn(`Long-lived token exchange errored: ${err instanceof Error ? err.message : String(err)}`);
      return shortLived;
    }
  }

  async me(token: string): Promise<{ id: string; name?: string; email?: string }> {
    const data = await this.get<{ id: string; name?: string; email?: string }>('/me', token, { fields: 'id,name,email' });
    return data;
  }

  /**
   * Pages the user administers. `/me/accounts` is the documented route; some app configurations
   * only return them nested under `/me?fields=accounts{…}`, so both are tried before giving up.
   */
  async pages(token: string): Promise<GraphPage[]> {
    try {
      const direct = await this.get<{ data?: GraphPage[] }>('/me/accounts', token, { fields: PAGE_FIELDS });
      if (Array.isArray(direct.data) && direct.data.length) return direct.data;
    } catch (err) {
      this.log.warn(`/me/accounts failed, falling back to /me?fields=accounts: ${(err as Error).message}`);
    }
    const nested = await this.get<{ accounts?: { data?: GraphPage[] } }>('/me', token, { fields: `accounts{${PAGE_FIELDS}}` });
    return nested.accounts?.data ?? [];
  }

  async forms(pageId: string, pageToken: string): Promise<GraphForm[]> {
    const data = await this.get<{ data?: GraphForm[] }>(`/${pageId}/leadgen_forms`, pageToken, { fields: FORM_FIELDS });
    return data.data ?? [];
  }

  /**
   * Every lead on a form, following Graph's cursor until the form is exhausted or `limit` is
   * reached — and reporting which of the two happened.
   *
   * IT USED TO STOP AT THE FIRST PAGE. `limit` was passed straight to Graph as the page size and
   * no cursor was followed, so a Page connected with an existing backlog imported the newest few
   * hundred submissions and never saw the rest — not on that sync, and not on any later one, because
   * every run asked the same question and got the same first page. Nothing reported the truncation,
   * so a brokerage connecting an account with a year of history would simply never receive most of
   * what it had paid for.
   *
   * `truncated` is returned rather than logged, so the caller can put it on the sync record and the
   * screen can say "there are more". A cap is reasonable; a silent one is not.
   *
   * Campaign/ad-set/ad attribution is requested first and, if Meta rejects those fields (they need
   * ads permissions the app may not hold), the walk restarts with the base fields — so a missing
   * permission costs attribution, not the leads themselves.
   */
  async formLeads(formId: string, pageToken: string, limit: number): Promise<{ leads: GraphLead[]; truncated: boolean }> {
    try {
      return await this.walkLeads(formId, pageToken, limit, LEAD_FIELDS_WITH_ADS);
    } catch (err) {
      if (!this.isFieldPermissionError(err)) throw err;
      this.log.warn(`Ad attribution unavailable for form ${formId}; falling back to base lead fields.`);
      return this.walkLeads(formId, pageToken, limit, LEAD_FIELDS);
    }
  }

  /**
   * Page through `/{form}/leads` until the cursor runs out or the ceiling is hit.
   *
   * The `next` URL Graph returns already carries the cursor, the fields and the token, so it is
   * followed verbatim rather than rebuilt — reconstructing it is how a paginated walk quietly starts
   * re-reading page one for ever. `seen` guards against exactly that: a provider that returns a
   * cursor pointing at itself would otherwise loop until the process died.
   */
  private async walkLeads(formId: string, pageToken: string, limit: number, fields: string): Promise<{ leads: GraphLead[]; truncated: boolean }> {
    const out: GraphLead[] = [];
    const seen = new Set<string>();
    let next: URL | null = new URL(`${graphOrigin()}/${formId}/leads`);
    next.searchParams.set('fields', fields);
    next.searchParams.set('limit', String(Math.min(LEADS_PAGE_SIZE, limit)));

    while (next && out.length < limit) {
      const href = next.toString();
      if (seen.has(href)) {
        this.log.warn(`Meta returned a repeating cursor for form ${formId}; stopping the walk.`);
        break;
      }
      seen.add(href);

      const page: { data?: GraphLead[]; paging?: { next?: string } } =
        await this.fetchJson(next, `Graph request failed: /${formId}/leads`, { Authorization: `Bearer ${pageToken}` });

      const batch = page.data ?? [];
      out.push(...batch);
      // No rows, or no cursor, means the form is exhausted — not an error.
      next = batch.length && page.paging?.next ? new URL(page.paging.next) : null;
    }

    // More to come only if Graph still had a cursor when the ceiling stopped us.
    const truncated = out.length >= limit && next !== null;
    if (out.length > limit) out.length = limit;
    return { leads: out, truncated };
  }

  async lead(leadId: string, pageToken: string): Promise<GraphLead> {
    try {
      return await this.get<GraphLead>(`/${leadId}`, pageToken, { fields: LEAD_FIELDS_WITH_ADS });
    } catch (err) {
      if (!this.isFieldPermissionError(err)) throw err;
      return this.get<GraphLead>(`/${leadId}`, pageToken, { fields: LEAD_FIELDS });
    }
  }

  /** Ad accounts the user can read, for attribution. Empty when ads_read was not granted. */
  async adAccounts(token: string): Promise<{ id: string; name: string; account_status?: number }[]> {
    try {
      const data = await this.get<{ data?: { id: string; name: string; account_status?: number }[] }>(
        '/me/adaccounts', token, { fields: 'id,name,account_status', limit: '100' },
      );
      return data.data ?? [];
    } catch (err) {
      // Not fatal: attribution is optional, and this permission is commonly withheld.
      this.log.warn(`Ad accounts unavailable: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Inspect the user token: which permissions were actually granted, and when it expires.
   * Requires the app access token, so it is a server-side call only.
   */
  async inspectToken(userToken: string): Promise<{ scopes: string[]; expiresAt: Date | null; valid: boolean }> {
    const url = new URL(`${graphOrigin()}/debug_token`);
    url.searchParams.set('input_token', userToken);
    try {
      // App token as a header — see `appAuthHeader`. It used to be `access_token=` in the query.
      const body = await this.fetchJson<{ data?: { scopes?: string[]; expires_at?: number; is_valid?: boolean } }>(
        url, 'Token inspection failed', this.appAuthHeader(),
      );
      const data = body?.data ?? {};
      // `expires_at: 0` means a token that never expires (a System User token).
      const expires = Number(data.expires_at ?? 0);
      return {
        scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
        expiresAt: expires > 0 ? new Date(expires * 1000) : null,
        valid: data.is_valid !== false,
      };
    } catch (err) {
      this.log.warn(`Token inspection failed: ${(err as Error).message}`);
      return { scopes: [], expiresAt: null, valid: true };
    }
  }

  /** Whether a Graph failure is about unavailable fields rather than a broken request. */
  private isFieldPermissionError(err: unknown): boolean {
    if (!(err instanceof GraphError)) return false;
    // 100 = unknown/unsupported field, 10/200 = permission denied for those edges.
    return err.code === 100 || err.code === 10 || err.code === 200
      || /nonexisting field|does not exist|permission/i.test(err.message);
  }

  /** App-level permission status, used by diagnostics to explain a failing connect. */
  async appPermissions(): Promise<{ name?: string; link?: string; live: string[] }> {
    // Both calls carry the app token as a header rather than `?access_token=`, so the app SECRET
    // never appears in a URL that a proxy or request log could capture.
    const headers = this.appAuthHeader();
    const appUrl = new URL(`${graphOrigin()}/${appId()}`);
    appUrl.searchParams.set('fields', 'name,link');
    const permUrl = new URL(`${graphOrigin()}/${appId()}/permissions`);

    // `.catch(() => ({}))` on each: diagnostics is a troubleshooting screen, so one unreadable
    // endpoint should narrow the answer rather than fail the whole report.
    const [app, perms] = await Promise.all([
      this.fetchJson<{ name?: string; link?: string }>(appUrl, 'Could not read the Meta app', headers)
        .catch(() => ({} as { name?: string; link?: string })),
      this.fetchJson<{ data?: { permission: string; status: string }[] }>(permUrl, 'Could not read app permissions', headers)
        .catch(() => ({} as { data?: { permission: string; status: string }[] })),
    ]);
    const live = (perms.data ?? [])
      .filter((p) => p.status === 'live')
      .map((p) => p.permission);
    const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return { name: text(app.name), link: text(app.link), live };
  }

  // ---------------------------------------------------------------- internal
  /**
   * One request to Graph, with a deadline.
   *
   * EVERY call in this file goes through here or `fetchJson` below, and both set a timeout. None of
   * them did. A socket that opened and never answered held the request for ever — and because the
   * scheduler marks itself `running` for the duration of a pass, a single hung call stopped
   * automatic lead sync for every connected account in the brokerage until somebody restarted the
   * API, with nothing logged, because nothing had failed. Every other outbound integration here
   * already set one; this was the exception.
   */
  private async get<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(graphOrigin() + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Sent as a header, not a query parameter: tokens contain characters that need encoding and
    // query strings end up in proxy and access logs.
    return this.fetchJson<T>(url, `Graph request failed: ${path}`, { Authorization: `Bearer ${token}` });
  }

  /**
   * Fetch and decode, applying the timeout and turning Meta's error envelope into a `GraphError`.
   *
   * `AbortSignal.timeout` produces a `TimeoutError`, which would otherwise escape as an opaque
   * DOMException; it is converted to a GraphError with a 504 so callers that already handle Graph
   * failures — `syncUser`'s per-form catch, the controller's `wrap` — handle this too.
   */
  private async fetchJson<T>(url: URL, fallback: string, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new GraphError(
        timedOut
          ? `Facebook did not respond within ${Math.round(GRAPH_TIMEOUT_MS / 1000)}s. It may be slow or unreachable — try again shortly.`
          : `Could not reach Facebook: ${err instanceof Error ? err.message : String(err)}`,
        timedOut ? 504 : 502,
      );
    }
    const body = await res.text();
    if (!res.ok) throw this.toError(body, res.status, fallback);
    return (this.parse(body) ?? {}) as T;
  }

  /**
   * The app access token, as a header rather than a query parameter.
   *
   * `appId|appSecret` IS the app secret. Two methods used to place it in the URL — the exact thing
   * `get()`'s own comment warns against, because query strings are what proxies, TLS-inspecting
   * middleboxes and request logs record. A user token in a log is bad; an app secret in one is a
   * credential for the whole integration.
   */
  private appAuthHeader(): Record<string, string> {
    return { Authorization: `Bearer ${appId()}|${appSecret()}` };
  }

  private parse(body: string): Record<string, unknown> | null {
    try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
  }

  /** Turn Meta's error envelope into a GraphError carrying its message, code and subcode. */
  private toError(body: string, status: number, fallback: string): GraphError {
    const parsed = this.parse(body);
    const e = parsed?.error as { message?: string; code?: number; error_subcode?: number } | undefined;
    this.log.error(`${fallback} (${status}): ${body.slice(0, 800)}`);
    return new GraphError(e?.message || fallback, status, e?.code, e?.error_subcode);
  }
}

/**
 * Whether this Graph failure means the stored token is finished rather than the request being
 * unlucky. Kept beside `GraphError` so the two cannot drift apart.
 */
export function isAuthFailure(err: GraphError): boolean {
  return AUTH_FAILURE_CODES.has(err.code ?? -1) || AUTH_FAILURE_CODES.has(err.subcode ?? -1);
}
