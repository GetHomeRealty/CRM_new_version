/**
 * The two areas the application is split into, and which screen belongs where.
 *
 * This is the client's half of the same distinction the server keeps in `src/common/domain.ts`,
 * and it uses the same two words — `crm` and `desk` — because `mail_accounts.scope` and
 * `google_connections.scope` already store exactly that. A different vocabulary on the frontend
 * would mean translating at every boundary.
 *
 * Areas are a matter of navigation, not authority. A screen's permission key is unchanged, and
 * putting a screen in an area neither grants nor removes access to it: `can('lead', 'view')`
 * still decides who may open Leads, whichever URL they arrive by.
 */

export const AREAS = ['crm', 'desk'] as const;
export type Area = (typeof AREAS)[number];

/** The area a URL with no area in it falls back to. Matches the server's `parseArea` default. */
export const DEFAULT_AREA: Area = 'desk';

export const AREA_LABEL: Record<Area, string> = {
  crm: 'Customer Relationship Management',
  desk: 'Transaction Management',
};

/** The short form, for the titlebar and page headings where the full name will not fit. */
export const AREA_SHORT: Record<Area, string> = {
  crm: 'CRM',
  desk: 'Transaction Desk',
};

/**
 * Shorter still, for the switcher.
 *
 * The two buttons share a 235px sidebar, and "Transaction Desk" beside an icon does not fit in
 * half of that — it rendered clipped mid-word. The full name is on the button's tooltip.
 */
export const AREA_TAB: Record<Area, string> = {
  crm: 'CRM',
  desk: 'Transactions',
};


/**
 * Where each screen lives.
 *
 * `both` is not a third area. It marks a screen that exists under both prefixes — either because
 * it is a shared module whose data belongs to neither side (Users, MLS, Inventory, the personal
 * account and inbox screens), or because each area gets its own view of it (Dashboard, Calendar,
 * Audit Trail, Triggers, Settings). The distinction between those two kinds is about what the
 * screen shows, which is Phase 3 onward; for routing they behave identically.
 */
export type ScreenArea = Area | 'both';

export const SCREEN_AREA: Record<string, ScreenArea> = {
  // Customer Relationship Management
  lead: 'crm',
  campaigns: 'crm',
  meta: 'crm',

  // Transaction Management
  transactions: 'desk',
  invoice: 'desk',
  reports: 'desk',
  // Analytics reads the transaction list and nothing else, so it is a Transaction Desk screen
  // despite the general-sounding name.
  analytics: 'desk',
  'recycle-bin': 'desk',

  // Present in both, with each area getting its own view.
  //
  // The Inbox is one of these, not a CRM screen: the CRM Inbox shows mail from accounts connected
  // under CRM Settings and the Transaction Desk Inbox shows mail from accounts connected under
  // Transaction Desk Settings. The server filters by the account's scope, so the two never show
  // each other's mail.
  inbox: 'both',
  dashboard: 'both',
  calendar: 'both',
  audit: 'both',
  triggers: 'both',
  settings: 'both',

  // Present in both, showing the same shared records either way.
  users: 'both',
  mls: 'both',
  favorites: 'both',
  inventory: 'both',
  reviews: 'both',
  account: 'both',
};

export const isArea = (v: unknown): v is Area => AREAS.includes(String(v) as Area);

/** Whether a screen may be reached from an area at all. */
export function screenInArea(screen: string, area: Area): boolean {
  const a = SCREEN_AREA[screen];
  // An unknown screen is allowed through rather than blocked: the stub route handles it, and a
  // hard 'no' here would turn a typo into a dead end instead of the "not built yet" page.
  return a === undefined || a === 'both' || a === area;
}

/**
 * Screens that exist in both areas but whose OLD `/app/…` URL meant one of them specifically.
 *
 * The Inbox is the case that matters. Before the split it read from CRM-scoped accounts only — the
 * filter was hard-coded — so `/app/inbox` has always shown CRM mail. Sending that bookmark to the
 * Transaction Desk's inbox would technically resolve, and would show a different mailbox than the
 * link has ever shown. Overriding it keeps the promise that no existing URL changes what it does.
 */
const LEGACY_AREA: Record<string, Area> = {
  inbox: 'crm',
};

/**
 * Which area an area-less link should resolve to.
 *
 * Used only when translating the old `/app/*` URLs. A screen that lives in one area goes there; one
 * that lives in both keeps the historical meaning if it had one, and otherwise the current default,
 * so an existing bookmark lands where the application used to take it.
 */
export function areaFor(screen: string): Area {
  const a = SCREEN_AREA[screen];
  if (a === 'crm' || a === 'desk') return a;
  return LEGACY_AREA[screen] ?? DEFAULT_AREA;
}

/** Build an in-area path. `screen` may carry sub-segments: `transactions/12`. */
export function areaPath(area: Area, screen = ''): string {
  const clean = screen.replace(/^\/+/, '');
  return clean ? `/${area}/${clean}` : `/${area}`;
}

/**
 * Links to a screen that belongs to one area no matter where the link is.
 *
 * A deal is a Transaction Desk record and a lead is a CRM record, so a link to either goes to that
 * area even from a shared screen — the Calendar's "open this deal" opens it in the Desk, and the
 * Dashboard's "open this lead" opens it in the CRM. Use `useArea().link()` instead for screens that
 * exist in both and should stay where the user already is (MLS, the personal account screens).
 */
export const deskPath = (screen = '') => areaPath('desk', screen);
export const crmPath = (screen = '') => areaPath('crm', screen);
