import { ForbiddenException } from '@nestjs/common';

/**
 * The authorization engine — every decision about who may do what comes from here.
 *
 * WHAT THIS REPLACES. `isSuperAdmin` and `isAdminOrAbove` were each written out four separate
 * times, in four services, from the same two role comparisons; `role === 'admin'` appeared inline
 * sixteen more times; `AdminGuard` compared the string itself; and the permission service special-
 * cased the same role again. Six copies of one rule is six places for it to drift, and the drift
 * would be silent — a service that forgot `manager` simply lets fewer people through, which nobody
 * reports as a bug until the wrong person is refused.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE. Every predicate here reproduces exactly what the call sites
 * it replaced already decided. `superAdmin` is `role === 'admin'`, because that is what this
 * application has always meant by it — 'admin' IS the top tier and is labelled "Super Admin" in the
 * interface. Renaming it would be a migration, not a refactor, and this commit is not the place.
 *
 * WHY CAPABILITIES AND NOT ROLE CHECKS AT THE CALL SITE. A service asking "may this person override
 * a document marked Valid?" is asking about an action. Asking "is this person an admin?" is asking
 * about a person, and gets the wrong answer the day a role is added. The capability list below is
 * the vocabulary; Phase 3 moves the mapping into the database without touching a single caller.
 */

/** Roles in descending authority. Order is meaningful: `atLeast` reads it as a ladder. */
export const ROLE_RANK: Record<string, number> = {
  admin: 100,
  manager: 80,
  accounting: 60,
  documentation: 60,
  crm: 40,
  agent: 20,
};

/** The minimum anyone unknown gets. An unrecognised role is the least privileged, never the most. */
const UNKNOWN_RANK = 0;

export interface Principal {
  id?: number;
  role?: string | null;
  name?: string | null;
}

export const rankOf = (u: Principal | null | undefined): number =>
  (u?.role && ROLE_RANK[u.role]) || UNKNOWN_RANK;

/**
 * Named actions, each defined by the least authority that may perform it.
 *
 * Every entry was read off the call site it came from, so the numbers restate decisions the
 * application already made rather than proposing new ones.
 */
export const CAPABILITIES = {
  /** Replace or delete a document already marked Valid. */
  'documents.override-valid': ROLE_RANK.admin,
  /** Administrative document operations — the "Administrator access required." path. */
  'documents.administer': ROLE_RANK.manager,
  /** Approve or reject a request to edit a locked transaction. */
  'transactions.approve-edit': ROLE_RANK.admin,
  /** Decide a deletion request, including forwarding it upward. */
  'transactions.decide-deletion': ROLE_RANK.manager,
  /** Act on a transaction locked by DFT or closure. */
  'transactions.override-lock': ROLE_RANK.admin,
  /** See and clear notifications raised for administrators. */
  'notifications.administer': ROLE_RANK.manager,
  /** Change another user's profile photo. */
  'users.manage-photo': ROLE_RANK.manager,
  /** Create, edit and remove user accounts. */
  'users.administer': ROLE_RANK.admin,
  /** Read data belonging to people other than yourself. */
  'data.read-all': ROLE_RANK.manager,
} as const;

export type Capability = keyof typeof CAPABILITIES;

/** Does this person hold at least the authority of `role`? */
export const atLeast = (u: Principal | null | undefined, role: string): boolean =>
  rankOf(u) >= (ROLE_RANK[role] ?? Number.POSITIVE_INFINITY);

/**
 * The top tier. `role === 'admin'` throughout this application, labelled "Super Admin" in the UI.
 */
export const isSuperAdmin = (u: Principal | null | undefined): boolean => rankOf(u) >= ROLE_RANK.admin;

/** Super Admin or Admin — what four services each spelled out for themselves. */
export const isAdminOrAbove = (u: Principal | null | undefined): boolean => rankOf(u) >= ROLE_RANK.manager;

/** An agent, the least privileged role, who sees their own work and no one else's. */
export const isAgent = (u: Principal | null | undefined): boolean => (u?.role ?? '') === 'agent';

/** May this person perform this action? */
export const can = (u: Principal | null | undefined, capability: Capability): boolean =>
  rankOf(u) >= CAPABILITIES[capability];

/**
 * The same question, answered by refusal.
 *
 * One message shape for the whole application, so a caller cannot distinguish "you are not allowed"
 * from "that does not exist" by the wording — and so nobody has to invent phrasing per endpoint.
 */
export function assertCan(u: Principal | null | undefined, capability: Capability, message?: string): void {
  if (!can(u, capability)) {
    throw new ForbiddenException({ message: message ?? 'Administrator access required.' });
  }
}
