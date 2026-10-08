import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService, GraphError, isAuthFailure, type GraphAd, type GraphAdAccount } from './meta-graph.service';
import { MetaApiBudgetService } from './meta-api-budget.service';

/**
 * IS ANY AD ENABLED FOR THIS LEAD FORM? — read from Meta's ads, never inferred.
 *
 * A lead form's own status ("Meta form: Active") stays Active long after every ad using it has been
 * paused, and the CRM's sync switch says nothing about ads at all. Neither may stand in for this.
 * The only source here is Meta's ads API, read with GET requests and nothing else:
 *
 *   1. the ad accounts this person's Meta login can read (`/me/adaccounts`, needs `ads_read`);
 *   2. every ad in each of them (`/{account}/ads`), with the ad's `effective_status` — Meta's own
 *      verdict, which already folds in a paused campaign (CAMPAIGN_PAUSED) or ad set (ADSET_PAUSED) —
 *      plus the parents' schedules and the account's own status;
 *   3. matched to forms by the `lead_gen_form_id` inside each ad's creative. IDs only; a form's or
 *      campaign's NAME is never compared with anything.
 *
 * Anything this cannot see — no permission, no ad accounts, an account that failed, a list cut short,
 * a lead ad whose creative does not name its form — makes the answer UNKNOWN WITH THE REASON rather
 * than "not enabled". "No ads found" is only said when every readable account was read in full.
 *
 * "ENABLED" IS NOT "DELIVERING". It means Meta reports the ad as ACTIVE (which already requires its
 * campaign and ad set to be active), its schedule is current and its ad account is active. Whether it
 * is actually getting impressions — budget, bid, audience size, learning, review — is not something
 * these fields say, and the screen says so rather than claiming it.
 */

export type AdState = 'enabled' | 'not_enabled' | 'no_ads' | 'unknown';

export interface AdRow {
  ad_id: string; ad_name: string;
  adset_id: string | null; adset_name: string | null;
  campaign_id: string | null; campaign_name: string | null;
  account_id: string; account_name: string;
  /** Meta's value, verbatim. */
  effective_status: string | null;
  /** Meta's status and the schedule checks, in words — "Enabled", "Paused (campaign)", "Ended (ad set schedule)"… */
  label: string;
  /** Enabled by status and schedule. NOT a statement that the ad is delivering. */
  enabled: boolean;
}

export interface FormAdStatus { state: AdState; summary: string; reason: string | null; ads: AdRow[] }

export interface AdScan {
  checked_at: string;
  /** Set when nothing could be read at all; every form is then Unknown with this reason. */
  blocked: { code: string; message: string } | null;
  accounts_checked: number;
  accounts_failed: { id: string; name: string; reason: string }[];
  /** Fewer accounts or ads than exist were read (caps), or archived ads could not be requested — any of which
   *  stops "No ads found" or "Not enabled" from being said. */
  incomplete: string[];
  /** Ads in lead campaigns whose creative did not name a form, so they could not be matched. */
  unmatched_lead_ads: number;
  ads: AdRow[];
  /** form id -> indexes into `ads`. */
  by_form: Record<string, number[]>;
}

const MAX_ACCOUNTS = 25;
const MAX_ADS_PER_ACCOUNT = 1000;
const CACHE_MS = 15 * 60_000;
const LEAD_OBJECTIVES = new Set(['OUTCOME_LEADS', 'LEAD_GENERATION']);

/** Every `lead_gen_form_id` anywhere in a creative — the spec nests it differently per ad format. */
export function formIdsInCreative(creative: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'lead_gen_form_id' && (typeof x === 'string' || typeof x === 'number') && String(x)) found.add(String(x));
      else visit(x, depth + 1);
    }
  };
  visit(creative, 0);
  return [...found];
}

const past = (iso: string | undefined, now: number): boolean => !!iso && Number.isFinite(Date.parse(iso)) && Date.parse(iso) <= now;
const future = (iso: string | undefined, now: number): boolean => !!iso && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > now;

const STATUS_LABEL: Record<string, string> = {
  PAUSED: 'Paused',
  CAMPAIGN_PAUSED: 'Paused (campaign)',
  ADSET_PAUSED: 'Paused (ad set)',
  PENDING_REVIEW: 'In review',
  IN_PROCESS: 'Processing',
  PREAPPROVED: 'Pre-approved, not yet live',
  DISAPPROVED: 'Disapproved',
  WITH_ISSUES: 'Has issues',
  PENDING_BILLING_INFO: 'Billing information needed',
  ARCHIVED: 'Archived',
  DELETED: 'Deleted',
};

/**
 * Whether Meta's data says this ad is enabled, and if not, why. Only ACTIVE can be enabled; even then
 * an ended or not-yet-started schedule, or an ad account that is not active, says otherwise — each a
 * value Meta returned, not a guess. Enabled is NOT delivering: see the note at the top.
 */
export function describeAd(ad: GraphAd, account: GraphAdAccount, now: number): { label: string; enabled: boolean } {
  const s = (ad.effective_status ?? '').toUpperCase();
  if (!s) return { label: 'Status not returned by Meta', enabled: false };
  if (s !== 'ACTIVE') return { label: STATUS_LABEL[s] ?? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' '), enabled: false };
  if (account.account_status !== undefined && account.account_status !== 1) {
    return { label: `Ad account not active (Meta status ${account.account_status})`, enabled: false };
  }
  if (past(ad.campaign?.stop_time, now)) return { label: 'Ended (campaign schedule)', enabled: false };
  if (past(ad.adset?.end_time, now)) return { label: 'Ended (ad set schedule)', enabled: false };
  if (future(ad.adset?.start_time, now)) return { label: 'Scheduled, not started', enabled: false };
  return { label: 'Enabled', enabled: true };
}

/** One form's answer, from a finished scan. */
export function formStatus(scan: AdScan, formId: string): FormAdStatus {
  if (scan.blocked) return { state: 'unknown', summary: 'Unknown', reason: scan.blocked.message, ads: [] };

  const ads = (scan.by_form[formId] ?? []).map((i) => scan.ads[i]);
  const gaps: string[] = [
    ...scan.accounts_failed.map((a) => `ad account ${a.name || a.id} could not be read (${a.reason})`),
    ...scan.incomplete,
    ...(scan.unmatched_lead_ads > 0
      ? [`${scan.unmatched_lead_ads} lead ad${scan.unmatched_lead_ads === 1 ? '' : 's'} did not name a form in their creative (for example ads using an existing post)`]
      : []),
  ];
  const enabled = ads.filter((a) => a.enabled);
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;

  // Data-backed even when coverage is partial: an enabled ad that was read IS enabled.
  if (enabled.length) {
    return { state: 'enabled', summary: `Enabled · ${enabled.length} of ${n(ads.length, 'ad')}`, reason: null, ads };
  }
  if (ads.length) {
    const counts = new Map<string, number>();
    for (const a of ads) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
    const breakdown = [...counts].map(([l, k]) => (k > 1 ? `${l} ×${k}` : l)).join(', ');
    if (gaps.length) {
      return {
        state: 'unknown', summary: 'Unknown',
        reason: `None of the ${n(ads.length, 'ad')} found is enabled (${breakdown}), but not everything could be checked: ${gaps.join('; ')}.`,
        ads,
      };
    }
    return { state: 'not_enabled', summary: `Not enabled · ${n(ads.length, 'ad')}: ${breakdown}`, reason: null, ads };
  }
  if (gaps.length) {
    return { state: 'unknown', summary: 'Unknown', reason: `No ad using this form was found, but not everything could be checked: ${gaps.join('; ')}.`, ads };
  }
  return {
    state: 'no_ads',
    summary: 'No ads found',
    reason: `No ad in the ${n(scan.accounts_checked, 'readable ad account')} uses this form. Deleted ads are not listed by Meta.`,
    ads,
  };
}

/** Meta's error, worded as a reason somebody can act on. */
function reasonFor(err: unknown): { code: string; message: string } {
  if (err instanceof GraphError) {
    if (isAuthFailure(err)) return { code: 'reconnect', message: 'The Meta login has expired or was revoked. Reconnect Meta, then check again.' };
    if (err.code === 10 || err.code === 200 || err.code === 294 || /permission|ads_read|ads_management/i.test(err.message)) {
      return { code: 'missing_permission', message: `Meta refused access to ads: ${err.message} The app's login configuration needs ads_read, and Meta must be reconnected.` };
    }
    if (err.code === 4 || err.code === 17 || err.code === 32 || err.code === 613 || err.code === 80004) {
      return { code: 'rate_limited', message: `Meta is rate-limiting ad requests right now: ${err.message} Try again later.` };
    }
    return { code: 'api_error', message: `Meta did not answer the ads request: ${err.message}` };
  }
  return { code: 'api_error', message: `The ads request failed: ${err instanceof Error ? err.message : String(err)}` };
}

@Injectable()
export class MetaAdStatusService {
  private readonly log = new Logger(MetaAdStatusService.name);
  /**
   * Per person, and only for the Meta connection it was read with: their login decides what they can
   * read. In memory — a lost cache costs one re-read.
   */
  private readonly cache = new Map<number, { key: string; scan: AdScan }>();

  constructor(
    private readonly connections: MetaConnectionService,
    private readonly graph: MetaGraphService,
    private readonly budget: MetaApiBudgetService,
  ) {}

  /**
   * The scan for this person, from the cache unless `refresh`, it is older than CACHE_MS, or the
   * connection it was read with is not the current one.
   *
   * WHY A KEY AND NOT JUST A TIMER. A result read before a disconnect, a reconnect, or a change in
   * what Meta granted would otherwise be served for up to fifteen minutes as if nothing had happened —
   * "Enabled" from a login that no longer exists, or "missing permission" just after it was granted.
   * The key is a hash of the connection row, its token and its granted scopes, recomputed on every
   * request: disconnecting removes the connection (no key, nothing served), reconnecting replaces the
   * token, and a permission change rewrites the scopes — each of which misses the cache.
   */
  async scanFor(userId: number, refresh: boolean): Promise<AdScan> {
    const key = await this.connectionKey(userId);
    if (!key) {
      this.cache.delete(userId);
      return this.empty({ code: 'not_connected', message: 'Meta is not connected.' });
    }
    const cached = this.cache.get(userId);
    if (!refresh && cached && cached.key === key && Date.now() - Date.parse(cached.scan.checked_at) < CACHE_MS) return cached.scan;
    const scan = await this.scan(userId);
    // A scan that could not start because of the shared budget is not remembered: the next view retries.
    if (scan.blocked?.code === 'budget') this.cache.delete(userId);
    else this.cache.set(userId, { key, scan });
    return scan;
  }

  /** Identity of the current Meta connection, or null when there is none. Never stores the token itself. */
  private async connectionKey(userId: number): Promise<string | null> {
    const conn = await this.connections.find(userId);
    if (!conn?.token) return null;
    const meta = await this.connections.meta(userId);
    return createHash('sha256')
      .update([conn.id, conn.connected_at?.toISOString() ?? '', conn.token, meta?.granted_scopes ?? ''].join('|'))
      .digest('hex');
  }

  private empty(blocked: AdScan['blocked']): AdScan {
    return {
      checked_at: new Date().toISOString(), blocked, accounts_checked: 0, accounts_failed: [],
      incomplete: [], unmatched_lead_ads: 0, ads: [], by_form: {},
    };
  }

  private async scan(userId: number): Promise<AdScan> {
    const conn = await this.connections.find(userId);
    if (!conn?.token) return this.empty({ code: 'not_connected', message: 'Meta is not connected.' });

    // Meta said which permissions this login holds. If it holds neither ads permission, asking is pointless.
    const granted = String((await this.connections.meta(userId))?.granted_scopes ?? '').split(',').filter(Boolean);
    if (granted.length && !granted.includes('ads_read') && !granted.includes('ads_management')) {
      return this.empty({
        code: 'missing_permission',
        message: 'This Meta connection was not granted ads_read, so ads cannot be read. Add ads_read to the app\'s Facebook Login '
          + 'for Business configuration, then disconnect and reconnect Meta and allow access to the ad accounts.',
      });
    }

    const spend = await this.budget.consume(1);
    if (!spend.allowed) {
      return this.empty({ code: 'budget', message: `The CRM's shared Meta request allowance is used up. Try again in about ${Math.ceil(spend.resetInSeconds / 60)} min.` });
    }

    let accounts: GraphAdAccount[];
    const scan = this.empty(null);
    try {
      const res = await this.graph.readableAdAccounts(conn.token, MAX_ACCOUNTS);
      accounts = res.accounts;
      if (res.truncated) scan.incomplete.push(`only the first ${MAX_ACCOUNTS} ad accounts were checked`);
    } catch (err) {
      this.log.warn(`Ad accounts unreadable for user ${userId}: ${(err as Error).message}`);
      return this.empty(reasonFor(err));
    }
    if (!accounts.length) {
      return this.empty({
        code: 'no_ad_accounts',
        message: 'This Meta login cannot see any ad accounts. The ads may run from an ad account it was not given access to '
          + '(choose it when reconnecting Meta), or ads_read may not be granted.',
      });
    }

    // Two reads per account: live ads, then archived ones.
    if (!(await this.budget.consume(accounts.length * 2)).allowed) {
      return this.empty({ code: 'budget', message: 'The CRM\'s shared Meta request allowance is used up. Try again later.' });
    }

    const now = Date.now();
    for (const account of accounts) {
      try {
        const { ads, truncated, archivedIncluded } = await this.graph.adsInAccount(account.id, conn.token, MAX_ADS_PER_ACCOUNT);
        scan.accounts_checked += 1;
        if (truncated) scan.incomplete.push(`ad account ${account.name || account.id} has more than ${MAX_ADS_PER_ACCOUNT} ads; only the first ${MAX_ADS_PER_ACCOUNT} were checked`);
        if (!archivedIncluded) scan.incomplete.push(`Meta refused the request for archived ads in ${account.name || account.id}`);
        for (const ad of ads) {
          const forms = formIdsInCreative(ad.creative);
          if (!forms.length) {
            if (LEAD_OBJECTIVES.has(String(ad.campaign?.objective ?? '').toUpperCase())) scan.unmatched_lead_ads += 1;
            continue;
          }
          const { label, enabled } = describeAd(ad, account, now);
          const idx = scan.ads.push({
            ad_id: ad.id, ad_name: ad.name ?? ad.id,
            adset_id: ad.adset?.id ?? null, adset_name: ad.adset?.name ?? null,
            campaign_id: ad.campaign?.id ?? null, campaign_name: ad.campaign?.name ?? null,
            account_id: account.id, account_name: account.name ?? account.id,
            effective_status: ad.effective_status ?? null, label, enabled,
          }) - 1;
          for (const f of forms) (scan.by_form[f] ??= []).push(idx);
        }
      } catch (err) {
        const r = reasonFor(err);
        // An expired login fails every account the same way: say so once, for everything.
        if (r.code === 'reconnect') return this.empty(r);
        scan.accounts_failed.push({ id: account.id, name: account.name ?? '', reason: r.message });
      }
    }
    scan.checked_at = new Date().toISOString();
    return scan;
  }
}
