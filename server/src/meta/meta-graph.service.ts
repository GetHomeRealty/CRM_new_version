import { Injectable, Logger } from '@nestjs/common';
import {
  FORM_FIELDS, LEAD_FIELDS, LEAD_FIELDS_WITH_ADS, PAGE_FIELDS, appId, appSecret, graphOrigin, loginConfigId,
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
    const res = await fetch(`${graphOrigin()}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId(), client_secret: appSecret(), redirect_uri: redirectUri, code,
      }),
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
      const res = await fetch(`${graphOrigin()}/oauth/access_token?${q}`);
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
   * Leads for a form. Campaign/ad-set/ad attribution is requested first and, if Meta rejects
   * those fields (they need ads permissions the app may not hold), the call is retried with the
   * base fields — so a missing permission costs attribution, not the leads themselves.
   */
  async formLeads(formId: string, pageToken: string, limit: number): Promise<GraphLead[]> {
    try {
      const data = await this.get<{ data?: GraphLead[] }>(`/${formId}/leads`, pageToken, {
        fields: LEAD_FIELDS_WITH_ADS, limit: String(limit),
      });
      return data.data ?? [];
    } catch (err) {
      if (!this.isFieldPermissionError(err)) throw err;
      this.log.warn(`Ad attribution unavailable for form ${formId}; falling back to base lead fields.`);
      const data = await this.get<{ data?: GraphLead[] }>(`/${formId}/leads`, pageToken, {
        fields: LEAD_FIELDS, limit: String(limit),
      });
      return data.data ?? [];
    }
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
    const appToken = `${appId()}|${appSecret()}`;
    const url = new URL(`${graphOrigin()}/debug_token`);
    url.searchParams.set('input_token', userToken);
    url.searchParams.set('access_token', appToken);
    try {
      const res = await fetch(url);
      const body = this.parse(await res.text());
      const data = (body?.data ?? {}) as { scopes?: string[]; expires_at?: number; is_valid?: boolean };
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
    const token = `${appId()}|${appSecret()}`;
    const [appRes, permRes] = await Promise.all([
      fetch(`${graphOrigin()}/${appId()}?fields=name,link&access_token=${encodeURIComponent(token)}`),
      fetch(`${graphOrigin()}/${appId()}/permissions?access_token=${encodeURIComponent(token)}`),
    ]);
    const app = appRes.ok ? this.parse(await appRes.text()) ?? {} : {};
    const perms = permRes.ok ? this.parse(await permRes.text()) ?? {} : {};
    const live = ((perms.data ?? []) as { permission: string; status: string }[])
      .filter((p) => p.status === 'live')
      .map((p) => p.permission);
    const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return { name: text(app.name), link: text(app.link), live };
  }

  // ---------------------------------------------------------------- internal
  private async get<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(graphOrigin() + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Sent as a header, not a query parameter: tokens contain characters that need encoding and
    // query strings end up in proxy and access logs.
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.text();
    if (!res.ok) throw this.toError(body, res.status, `Graph request failed: ${path}`);
    return (this.parse(body) ?? {}) as T;
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
