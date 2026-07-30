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
      // Accounting: works in Transactions (Legal & Docs) + Invoice; no admin screens.
      case 'accounting':
        return { ...this.fill('view'), transactions: 'edit', invoice: 'edit', users: 'none', settings: 'none' };
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
