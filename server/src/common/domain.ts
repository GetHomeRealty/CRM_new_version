/**
 * The application-domain identifier that keeps Customer Relationship Management and Transaction
 * Management data apart.
 *
 * The values are `crm` and `desk` rather than `CRM` and `TRANSACTION_MANAGEMENT`, deliberately.
 * Two columns already carry exactly this distinction under those names — `mail_accounts.scope`
 * and `google_connections.scope`, both live and both enforced — and introducing a second
 * vocabulary for the same idea would mean every query, guard and migration had to know which of
 * the two it was reading. One spelling used everywhere is what makes the separation reliable.
 *
 * `common` is the third value, for the modules that belong to neither area — Users, now that MLS
 * and Inventory have moved to the Transaction Desk. Records marked common are visible from both
 * areas, because hiding a user change from one half of the application would lose an
 * administrator's audit history rather than separate it.
 *
 * `null` means not yet classified. It is not a fourth domain — it is the honest state for history
 * that pre-dates the split and cannot be attributed. Unclassified records are shown in BOTH areas,
 * so the separation never makes an existing record disappear from view.
 */

export const DOMAINS = ['crm', 'desk', 'common'] as const;
export type Domain = (typeof DOMAINS)[number];

/** The two operational areas a user chooses between. `common` is not an area, it is a marking. */
export const AREAS = ['crm', 'desk'] as const;
export type Area = (typeof AREAS)[number];

/** Labels as they appear to a user. */
export const AREA_LABEL: Record<Area, string> = {
  crm: 'Customer Relationship Management',
  desk: 'Transaction Management',
};

export const isDomain = (v: unknown): v is Domain => DOMAINS.includes(String(v) as Domain);
export const isArea = (v: unknown): v is Area => AREAS.includes(String(v) as Area);

/**
 * Which area each screen belongs to — the server's copy of the same table the sidebar uses.
 *
 * Needed here because the audit trail's category list is derived from the screen names: the CRM's
 * trail must not offer "Transactions" as a category to filter by, and the Transaction Desk's must
 * not offer "Lead". Keys match `SCREENS` in the permission service.
 *
 * `common` marks a screen whose activity belongs to neither area and is therefore listed in both —
 * a change to a user or to Company Settings is not CRM history or Transaction history, it is both.
 */
export const SCREEN_DOMAIN: Record<string, Domain> = {
  lead: 'crm',
  campaigns: 'crm',
  meta: 'crm',
  // Kept in step with the client's SCREEN_AREA: Client Reviews is a CRM module, so the Transaction
  // Desk's audit filter should not offer a category that can never match anything on its side.
  reviews: 'crm',

  transactions: 'desk',
  invoice: 'desk',
  reports: 'desk',
  analytics: 'desk',
  'recycle-bin': 'desk',

  // Present in both, each with its own view.
  inbox: 'common',
  dashboard: 'common',
  calendar: 'common',
  audit: 'common',
  triggers: 'common',
  settings: 'common',

  // Inventory, MLS and Favorites were shared and are now the Transaction Desk's alone, by request.
  // They live here as 'desk' to match the client's SCREEN_AREA: the two maps decide the same thing
  // on opposite sides of the wire, and once ScreenGuard enforces module access from this one, a
  // screen listed here as shared would be reachable from a CRM that no longer offers it.
  //
  // This also narrows the audit trail's category list — the CRM's filter stops offering three
  // screens that can no longer produce a CRM entry, and 20260730170000 moved the two rows already
  // filed under the old classification so that nothing is left pointing at a category that is gone.
  mls: 'desk',
  favorites: 'desk',
  inventory: 'desk',

  // Genuinely shared.
  users: 'common',
};

/**
 * Which area an audit entry belongs to, from the fields the writer already has.
 *
 * These are the SAME rules the 20260729140000 migration used to classify the existing 108 rows, in
 * the same order, so history and anything written from now on are classified identically. If the two
 * ever diverge the trail becomes a mix of two schemes, and there is no way to tell from a row which
 * one produced it.
 *
 *   a transaction link          → desk   (a link to a deal IS the area)
 *   Lead / Campaigns / Meta     → crm
 *   Settings, by its section    → crm | desk | common
 *   MLS / Inventory / Favorites → desk   (moved there with the screens themselves)
 *   Users                       → common (genuinely shared; shown in both trails)
 *
 * Returns null when nothing applies, which leaves the row unclassified and therefore visible from
 * both areas — the safe direction, since the alternative is hiding it from both.
 */
export function auditDomain(input: { category?: string | null; section?: string | null; transactionId?: number | null }): Domain | null {
  if (input.transactionId != null) return 'desk';

  const category = String(input.category ?? '').trim();
  const section = String(input.section ?? '').trim().toLowerCase();

  if (category === 'Settings') {
    if (section.includes('crm')) return 'crm';
    if (section.includes('transaction desk') || section.includes('desk')) return 'desk';
    // Company Settings, and any other settings section, belongs to neither area.
    return 'common';
  }

  const byCategory: Record<string, Domain> = {
    Lead: 'crm', Leads: 'crm', Campaigns: 'crm', Meta: 'crm', 'Client Reviews': 'crm',
    Transactions: 'desk', Invoice: 'desk', Invoices: 'desk', Reports: 'desk', Analytics: 'desk',
    'Recycle Bin': 'desk',
    // These follow SCREEN_DOMAIN, which moved them to the Transaction Desk. The two rows already
    // filed as common were moved with them by 20260730170000, so this function still explains every
    // stored domain — the property that makes the trail checkable at all.
    'Marketing Inventory': 'desk', Inventory: 'desk', MLS: 'desk', Favorites: 'desk',
    Users: 'common',
  };
  return byCategory[category] ?? null;
}

/** The screen labels an area's audit filter should offer. */
export function screenLabelsForArea(screens: Record<string, string>, area: Area): string[] {
  return Object.entries(screens)
    .filter(([key]) => {
      const d = SCREEN_DOMAIN[key];
      // Unknown screens are offered rather than hidden: a category that exists in the data but not
      // in this table would otherwise become unfilterable.
      return d === undefined || d === 'common' || d === area;
    })
    .map(([, label]) => label);
}

/** Read an area from a route segment, query value or header. Falls back to Transaction Desk. */
export function parseArea(value: unknown, fallback: Area = 'desk'): Area {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'crm') return 'crm';
  if (v === 'desk' || v === 'transaction' || v === 'transactions') return 'desk';
  return fallback;
}

/**
 * What one area is allowed to read.
 *
 * An area sees its own records, anything marked `common`, and anything still unclassified. The
 * last two are what stop the separation from hiding existing data: a record that pre-dates the
 * split, or one belonging to a shared module, stays visible from both sides rather than falling
 * into a gap between them.
 *
 * The `OR` is not a stylistic choice. Prisma rejects `{ domain: { in: ['desk', 'common', null] } }`
 * outright — `in` takes a list of strings or `null`, not a list containing `null` — so matching
 * "one of these values, or not set" has to be spelled as a union. This is the same shape the
 * mail-account scope filter already uses in the Inbox.
 *
 * Because it owns the `OR` key, prefer `domainWhere()` when the query has conditions of its own;
 * spreading this into a `where` that already carries an `OR` would silently replace it.
 */
export function domainFilter(area: Area): { OR: [{ domain: { in: Domain[] } }, { domain: null }] } {
  return { OR: [{ domain: { in: [area, 'common'] } }, { domain: null }] };
}

/**
 * The domain restriction combined with the rest of a query, without either clobbering the other.
 *
 * `AND` is used rather than a spread so that a caller's own `OR` — a search across several
 * columns, say — keeps its meaning instead of being overwritten by the domain's.
 */
export function domainWhere<T extends object>(area: Area, rest?: T): { AND: [ReturnType<typeof domainFilter>, T] } | ReturnType<typeof domainFilter> {
  const filter = domainFilter(area);
  return rest && Object.keys(rest).length > 0 ? { AND: [filter, rest] } : filter;
}

/**
 * The stricter form, for places that must show one area's own records only — the audit trails,
 * where `common` gets its own view rather than appearing in both.
 */
export function strictDomainFilter(area: Area): { domain: Area } {
  return { domain: area };
}

/**
 * A path into the frontend, inside one area — for the links in notification emails and the
 * redirect at the end of an OAuth round-trip.
 *
 * Declared here, next to the areas themselves, so the server and the client cannot disagree about
 * the URL shape. The frontend still accepts the previous `/app/...` form and forwards it, so an
 * email sent before this change keeps working; new mail points straight at the right area.
 */
export function areaPath(area: Area, screen = ''): string {
  const clean = screen.replace(/^\/+/, '');
  return clean ? `/${area}/${clean}` : `/${area}`;
}
