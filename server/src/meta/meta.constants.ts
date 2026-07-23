/** Meta (Facebook / Instagram) lead-ads integration constants. */

/** Graph API version. Override with META_GRAPH_API_VERSION=v21.0. */
export function graphVersion(): string {
  const v = (process.env.META_GRAPH_API_VERSION ?? '').trim() || 'v21.0';
  return v.startsWith('v') ? v : `v${v}`;
}

export const graphOrigin = (): string => `https://graph.facebook.com/${graphVersion()}`;
export const oauthDialogUrl = (): string => `https://www.facebook.com/${graphVersion()}/dialog/oauth`;

/** Path Meta redirects back to. Must match a Valid OAuth Redirect URI in the Meta app exactly. */
export const OAUTH_CALLBACK_PATH = '/api/meta/callback';

/**
 * Permissions needed to read lead ads. Only used for the `scope` / `hybrid` strategies —
 * Business-type apps must authenticate with a `config_id` instead, or Meta rejects the
 * dialog with "This app needs at least one supported permission".
 */
export const OAUTH_SCOPES = ['email', 'pages_show_list', 'pages_read_engagement', 'leads_retrieval'] as const;

/** Permissions that must be Live on the Meta app before lead sync works for non-testers. */
export const REQUIRED_LIVE_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'leads_retrieval'] as const;

/**
 * Permissions frequently left in a Login configuration that block the dialog until App Review
 * grants them. Flagged by diagnostics so the cause is visible rather than guessed at.
 */
export const BLOCKING_IF_NOT_LIVE = ['pages_manage_ads'] as const;

export const PAGE_FIELDS = 'id,name,access_token,tasks';
export const FORM_FIELDS = 'id,name,status,leads_count,created_time';
export const LEAD_FIELDS = 'id,created_time,field_data';
/** With campaign / ad-set / ad attribution — needs ads permissions, so requested opportunistically. */
export const LEAD_FIELDS_WITH_ADS = 'id,created_time,field_data,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,platform';

/** Cap on leads pulled per form in one sync, so a huge backlog can't stall the request. */
export const MAX_LEADS_PER_FORM = 500;

export const env = (name: string): string => (process.env[name] ?? '').trim();

export const appId = (): string => env('META_APP_ID') || env('FACEBOOK_APP_ID');
export const appSecret = (): string => env('META_APP_SECRET') || env('FACEBOOK_APP_SECRET');
export const loginConfigId = (): string => env('META_LOGIN_CONFIG_ID') || env('FACEBOOK_LOGIN_CONFIG_ID');
export const webhookVerifyToken = (): string => env('META_WEBHOOK_VERIFY_TOKEN') || env('FACEBOOK_WEBHOOK_VERIFY_TOKEN');
export const webhookSecret = (): string => env('META_WEBHOOK_SECRET') || env('FACEBOOK_WEBHOOK_SECRET') || appSecret();

/** scope = legacy scopes only; config = config_id only (recommended); hybrid = both. */
export function oauthStrategy(): 'scope' | 'config' | 'hybrid' {
  const raw = env('META_OAUTH_STRATEGY') || 'config';
  return raw === 'scope' || raw === 'hybrid' ? raw : 'config';
}

/** Only true for System-user token configurations in Meta — wrong on User-token configs. */
export const systemUserOverride = (): boolean => env('META_OAUTH_SYSTEM_USER') === 'true';

/** Whether the server has enough configuration to attempt an OAuth connect. */
export const isConfigured = (): boolean => appId() !== '' && appSecret() !== '';

/**
 * Public base URL Meta redirects back to. `META_PUBLIC_URL` wins; otherwise the API's own
 * origin, which is only reachable from the internet in production.
 */
export function publicBaseUrl(fallbackOrigin = ''): string {
  const override = env('META_PUBLIC_URL') || env('NEXT_PUBLIC_APP_URL') || env('NEXTAUTH_URL');
  return (override || fallbackOrigin).replace(/\/+$/, '');
}

/**
 * The exact value Meta must have on its Valid OAuth Redirect URIs list. FACEBOOK_REDIRECT_URI
 * overrides everything, for deployments that terminate the callback on a different host.
 */
export const redirectUri = (fallbackOrigin = ''): string =>
  env('FACEBOOK_REDIRECT_URI') || env('META_REDIRECT_URI') || `${publicBaseUrl(fallbackOrigin)}${OAUTH_CALLBACK_PATH}`;

/**
 * Maps a Meta lead-form answer name onto a lead column. Anything unmapped is kept verbatim in
 * `custom_fields`, so no answer the client filled in is ever silently dropped.
 */
export const FIELD_MAP: Record<string, string> = {
  full_name: 'name', first_name: 'name', name: 'name',
  email: 'email', email_address: 'email',
  phone_number: 'phone', phone: 'phone', mobile: 'phone',
  message: 'message', comments: 'message', additional_info: 'message',
  property_type: 'property_type', home_type: 'property_type',
  budget: 'budget', price_range: 'budget',
  timeline: 'timeline', when_are_you_looking: 'timeline',
  location: 'location', city: 'location', area: 'location',
  property: 'property', property_interest: 'property',
};
