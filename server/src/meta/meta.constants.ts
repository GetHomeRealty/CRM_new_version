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

/**
 * Cap on leads pulled per form in one sync.
 *
 * Now a ceiling on a PAGINATED walk rather than a single page size — `formLeads` follows Graph's
 * `paging.next` cursor until it reaches this many or runs out. It used to be passed as the page
 * limit with no cursor followed at all, so a Page connected with an existing backlog imported the
 * newest 500 and never saw the rest, on that sync or any later one, with nothing reporting the
 * truncation.
 */
export const MAX_LEADS_PER_FORM = Math.max(1, Number(process.env.META_MAX_LEADS_PER_FORM ?? 5000));

/** How many leads to ask for per Graph request while walking the cursor. Meta's own maximum is 100. */
export const LEADS_PAGE_SIZE = 100;

/** How long any single Graph request may take before it is abandoned. */
export const GRAPH_TIMEOUT_MS = Math.max(1000, Number(process.env.META_GRAPH_TIMEOUT_MS ?? 30_000));

/**
 * The longest value each mapped Meta answer may be, matching the column it lands in.
 *
 * Lead-form answers are free text of any length; the columns are not. Without these, an over-long
 * answer made Postgres reject the row, the sync counted the submission as `skipped`, and a paid
 * lead was lost to a log line. Confirmed for email, phone, location and budget.
 *
 * The raw answer is still preserved in full on `meta_raw`, so truncation shortens what is
 * searchable rather than discarding anything.
 */
export const META_FIELD_LIMITS = {
  name: 255,
  first_name: 128,
  last_name: 128,
  email: 255,
  phone: 64,
  phone_normalized: 32,
  location: 255,
  property: 255,
  budget: 128,
  timeline: 128,
  property_type: 128,
  // TEXT columns — capped only so one runaway answer cannot bloat a row.
  message: 20_000,
  custom_fields: 20_000,
} as const;

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

/**
 * How long a connected form may go without a webhook delivery before the health view says so.
 *
 * A webhook stops silently — a lapsed subscription, a redeployed host, an expired tunnel — and the
 * only symptom is leads that never appear, which is indistinguishable from a quiet week. Scheduled
 * polling covers the gap, which is why this is a warning and not an alarm; 24 hours is long enough
 * that an ordinary quiet night never trips it.
 */
export const WEBHOOK_QUIET_ALERT_MS = Math.max(1, Number(process.env.META_WEBHOOK_QUIET_HOURS ?? 24)) * 3_600_000;

/**
 * Cap on the stored raw Graph payload per lead.
 *
 * `meta_raw` exists so an import can be re-examined or re-mapped when a form's questions change,
 * which needs the answers rather than every byte Meta sent. It was stored whole and unbounded, and
 * it duplicates data already sitting in the mapped columns. Truncating keeps the diagnostic value
 * without letting one pathological submission carry an unbounded row.
 *
 * Truncation is marked in the stored value rather than silent, so nobody reads a clipped payload as
 * a complete one.
 */
export const META_RAW_MAX_CHARS = Math.max(1_000, Number(process.env.META_RAW_MAX_CHARS ?? 20_000));

/**
 * How long the raw payload is kept before it is cleared from the lead.
 *
 * The mapped columns are the record; `meta_raw` is a working copy of what arrived, and it holds
 * everything the person typed into somebody's ad — the fullest personal-data footprint the module
 * stores. Keeping it for ever, with no policy, is the part that would be hard to defend under
 * PIPEDA. Ninety days is well past any window in which a mis-mapped import would still be worth
 * re-examining.
 *
 * Set META_RAW_RETENTION_DAYS=0 to keep payloads indefinitely.
 */
export const META_RAW_RETENTION_DAYS = Math.max(0, Number(process.env.META_RAW_RETENTION_DAYS ?? 90));

/**
 * The window the shared Graph budget is counted in, and how much may be spent in it.
 *
 * COLLECTIVE, unlike `META_SYNC_LIMIT`, which is per user. Meta enforces its limits per app, so a
 * per-person ceiling bounds one person and not the brokerage — twenty agents each within their own
 * allowance still add up. See `MetaApiBudgetService`.
 *
 * One unit is one lead form a sync will read. The default of 600 an hour is deliberately generous
 * against normal use — the scheduler polls every fifteen minutes, so a brokerage with forty
 * connected forms spends 160 an hour automatically — while still stopping the case this exists for:
 * a room full of agents pressing Sync at once.
 *
 * Env: META_BUDGET_PER_WINDOW / META_BUDGET_WINDOW_MINUTES
 */
export const META_BUDGET_WINDOW_MS = Math.max(1, Number(process.env.META_BUDGET_WINDOW_MINUTES ?? 60)) * 60_000;
export const META_BUDGET_PER_WINDOW = Math.max(1, Number(process.env.META_BUDGET_PER_WINDOW ?? 600));

/**
 * How often an agent may be told their Meta connection needs reconnecting.
 *
 * The scheduler runs every fifteen minutes and a dead token fails every time, so without this the
 * same alert would arrive ninety-six times a day — which is how a real warning becomes something
 * people filter to a folder and stop reading. One a day is enough to be noticed and not enough to
 * be ignored.
 *
 * Env: META_RECONNECT_NOTICE_HOURS
 */
export const META_RECONNECT_NOTICE_MS = Math.max(1, Number(process.env.META_RECONNECT_NOTICE_HOURS ?? 24)) * 3_600_000;

/**
 * Graph error codes that mean the stored token is finished, as distinct from a transient failure.
 *
 * 190 is the documented "access token has expired, been revoked, or is otherwise invalid". 102 and
 * 463 arrive as subcodes on session problems, and 467 is an invalidated token. Everything else —
 * rate limits (4, 17, 32), permissions (10, 200), bad requests (100) — is either retryable or a
 * different problem, and must NOT pause lead collection.
 */
export const AUTH_FAILURE_CODES = new Set([102, 190, 463, 467]);
