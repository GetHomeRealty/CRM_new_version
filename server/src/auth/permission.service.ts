import { Injectable } from '@nestjs/common';
import { isSuperAdmin } from '../core/authz';

/**
 * Screen-level access control — a faithful port of Laravel's
 * App\Services\PermissionService. Effective access = role defaults overlaid with
 * per-user overrides. Admin always has full access to everything.
 *
 * Levels are ranked: none(0) < view(1) < edit(2). Key ordering of the emitted
 * permission maps matches Laravel exactly (SCREENS order) so JSON responses are
 * byte-identical.
 */

export const LEVELS = ['none', 'view', 'edit'] as const;
export type Level = (typeof LEVELS)[number];

/** Screen catalog (key => label) — mirrors the sidebar nav. Order is significant. */
export const SCREENS: Record<string, string> = {
  dashboard: 'Dashboard',
  analytics: 'Analytics',
  calendar: 'Calendar',
  reviews: 'Client Reviews',
  favorites: 'Favorites',
  inventory: 'Inventory',
  inbox: 'Inbox',
  lead: 'Lead',
  campaigns: 'Campaigns',
  meta: 'Meta',
  mls: 'MLS',
  transactions: 'Transactions',
  invoice: 'Invoice',
  reports: 'Reports',
  audit: 'Audit Trail',
  users: 'Users',
  settings: 'Settings',
  triggers: 'Triggers',
};

export const ROLES = ['admin', 'manager', 'agent', 'accounting', 'documentation', 'crm'] as const;

/** Display labels (relabel-in-place): stored role => UI tier name. */
export const ROLE_LABELS: Record<string, string> = {
  admin: 'Super Admin',
  manager: 'Admin',
  agent: 'Agent',
  accounting: 'Accounting',
  documentation: 'Documentation',
  crm: 'CRM',
};

/** A per-user override row (from the user_permissions table). */
export interface PermissionOverride {
  screen: string;
  level: string;
}

export type PermissionMap = Record<string, string>;

@Injectable()
export class PermissionService {
  /**
   * The database-backed defaults, when they are available.
   *
   * Optional and injected lazily so this service keeps working — and keeps being constructible in a
   * test — when the store is absent. The compiled `roleDefaults` below stays as the fallback, which
   * is what makes an empty or unreachable table harmless rather than a lockout.
   */
  private store: { defaultsFor(role: string): PermissionMap | null } | null = null;

  /** Called once by the Core Platform layer at start-up. */
  useStore(store: { defaultsFor(role: string): PermissionMap | null }): void {
    this.store = store;
  }

  label(role: string): string {
    return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
  }

  private rank(level: string): number {
    const i = LEVELS.indexOf(level as Level);
    return i < 0 ? 0 : i;
  }

  /** Every screen filled with the same level, in SCREENS order. */
  private fill(level: Level): PermissionMap {
    const out: PermissionMap = {};
    for (const key of Object.keys(SCREENS)) out[key] = level;
    return out;
  }

  /**
   * Default permission map for a role: screen => level.
   *
   * The database is consulted first; the switch below is the fallback and the origin of the seeded
   * data, so the two agree by construction. A test asserts they still do.
   */
  roleDefaults(role: string): PermissionMap {
    const stored = this.store?.defaultsFor(role);
    if (stored) return stored;
    return this.compiledDefaults(role);
  }

  /** The defaults as written into the application. Seeded into `role_permissions` by migration. */
  private compiledDefaults(role: string): PermissionMap {
    switch (role) {
      case 'admin':
        return this.fill('edit');
      case 'manager':
        return { ...this.fill('edit'), users: 'none', settings: 'view', audit: 'view' };
      /*
       * Accounting: works in Transactions (Legal & Docs) + Invoice; no admin screens.
       *
       * `audit: 'none'` is explicit rather than inherited. It came from `fill('view')` and was
       * never chosen — measured during the CRM audit, `GET /api/audit-logs` answered 200 to
       * accounting while documentation and crm got 403. The audit trail is not a financial record:
       * it carries user administration, permission grants and settings changes, so the role could
       * read the history of actions on screens it cannot open and rights it does not hold.
       *
       * Listed here, next to `users` and `settings`, so the three admin surfaces this role is kept
       * out of read as one decision instead of two decisions and an oversight.
       */
      case 'accounting':
        return { ...this.fill('view'), transactions: 'edit', invoice: 'edit', users: 'none', settings: 'none', audit: 'none' };
      // Documentation: full Legal & Documentation access (other sections view-only,
      // enforced in the UI). Invoice module hidden.
      case 'documentation':
        return {
          ...this.fill('view'),
          transactions: 'edit',
          invoice: 'none',
          users: 'none',
          settings: 'none',
          audit: 'none',
        };
      // CRM: leads / reviews / clients. Transactions AND Invoice hidden entirely.
      case 'crm':
        return {
          ...this.fill('view'),
          lead: 'edit',
          reviews: 'edit',
          /*
           * TD-061 — 'view', because that is what this role can actually do with Triggers.
           *
           * This was 'edit', and the reason above it was "which CRM emails THIS PERSON sends".
           * That is no longer what `triggers` opens: the CRM half moved to CRM → Communications,
           * which is an `open` route needing no permission at all, and `area.ts` now maps
           * `triggers` to the Desk alone. What is left behind this key is the brokerage-wide
           * automation panel — lawyer-reminder cadence and Desk message templates — which writes
           * through the company-settings and email-template endpoints and is therefore gated on
           * `settings: 'edit'` by the server.
           *
           * So the grant had stopped granting anything and only misdescribed the role. Nothing
           * changes in practice: this role holds `settings: 'none'`, so it could never edit that
           * panel. The matrix now says so.
           */
          triggers: 'view',
          /*
           * Marketing IS this role's job — it prepares campaigns for agents, sends mass
           * communications and runs lead nurturing. It held `campaigns: 'view'` inherited from
           * `fill('view')`, so measured during the CRM audit it was refused 403 on campaign create
           * and test-send while an ordinary AGENT was allowed both. The role that exists to run
           * campaigns was the one role that could not.
           *
           * Deliberately paired with `data.read-all`, which this role's rank already grants: a
           * campaign for the brokerage is useless if the audience stops at the sender's own leads.
           */
          campaigns: 'edit',
          transactions: 'none',
          invoice: 'none',
          audit: 'none',
          users: 'none',
          settings: 'none',
        };
      /*
       * Agents see every module except Invoice and Audit Trail (and admin-only Users /
       * Settings). Transactions is editable.
       *
       * Lead and Calendar are editable too: an agent has to be able to book their own
       * appointments and to log the notes, tasks and showings for the leads they are working.
       * Both are owner-scoped in their services — an agent's queries only ever return their own
       * leads and their own events — so `edit` here does not widen what they can see, only what
       * they can do with it.
       */
      default:
        return {
          ...this.fill('view'),
          transactions: 'edit',
          lead: 'edit',
          calendar: 'edit',
          // An agent runs the CRM the way the brokerage does — their own leads, their own
          // campaigns, their own Meta connection — so these are editable. Every one of them is
          // owner-scoped in its service, so `edit` lets an agent act on their own records only,
          // never the brokerage's or another agent's.
          campaigns: 'edit',
          meta: 'edit',
          /*
           * TD-061 — 'view'. The matrix said 'edit' and the screen refused them, so an
           * administrator reading the matrix to answer "can our agents retime the brokerage's
           * reminder emails?" was told yes when the answer is no.
           *
           * THE SCREEN WAS RIGHT AND THE MATRIX WAS WRONG, which is the direction this is fixed
           * in. `DeskTriggersPanel` gates editing on `settings: 'edit'`, and it is correct to:
           * the panel saves through `updateCompanySettings` and `updateEmailTemplate`, so the
           * SERVER enforces `settings` on the write. Re-gating the panel on `triggers` instead
           * would have handed agents a Save button that the API answers with a 403 — the affordance
           * mismatch of TD-017, reintroduced deliberately.
           *
           * The grant's own justification had also moved out from under it. It read "an agent
           * decides which CRM emails they themselves send", and that screen is now CRM →
           * Communications, an `open` route reached with no permission at all. `triggers` today
           * opens the Desk's brokerage-wide automations and nothing else.
           *
           * 'view' rather than 'none' so the sidebar entry and the screen stay exactly where they
           * are — an agent can still read the reminder cadence, which is what they can do today.
           */
          triggers: 'view',
          invoice: 'none',
          audit: 'none',
          users: 'none',
          settings: 'none',
        };
    }
  }

  /** Effective permissions for a user: role defaults + overrides. Admin = all edit. */
  effectiveFor(role: string, overrides: PermissionOverride[] = []): PermissionMap {
    // The one role that is above the permission map rather than described by it. Asked of the
    // engine so this file is not a second place that knows which role that is.
    if (isSuperAdmin({ role })) {
      return this.fill('edit');
    }

    const perms = this.roleDefaults(role || 'agent');
    for (const o of overrides) {
      if (Object.prototype.hasOwnProperty.call(SCREENS, o.screen) && (LEVELS as readonly string[]).includes(o.level)) {
        perms[o.screen] = o.level;
      }
    }
    return perms;
  }

  /** Does the role (+ overrides) have at least `level` on `screen`? */
  can(role: string, overrides: PermissionOverride[], screen: string, level: string = 'view'): boolean {
    const perms = this.effectiveFor(role, overrides);
    const have = perms[screen] ?? 'none';
    return this.rank(have) >= this.rank(level);
  }

  /** Catalog for the permission editor UI (matches Laravel's shape/order). */
  catalog(): {
    screens: { key: string; label: string }[];
    roles: string[];
    role_labels: Record<string, string>;
    levels: string[];
    role_defaults: Record<string, PermissionMap>;
  } {
    const screens = Object.entries(SCREENS).map(([key, label]) => ({ key, label }));
    const role_defaults: Record<string, PermissionMap> = {};
    for (const r of ROLES) role_defaults[r] = this.roleDefaults(r);
    return {
      screens,
      roles: [...ROLES],
      role_labels: ROLE_LABELS,
      levels: [...LEVELS],
      role_defaults,
    };
  }
}
