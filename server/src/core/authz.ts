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
  /**
   * Nullable because callers hold identities from several shapes — `AuthUserRecord` (always has
   * one), the scoped-user shape used by `common/transaction-scope.ts` (may not), and hand-built
   * principals in tests. Widening costs nothing: every predicate here reads `role` and none of them
   * reads `id`, so no existing decision changes.
   */
  id?: number | null;
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
  /**
   * Read the brokerage's own banking details — beneficiary, bank, transit, institution, account
   * and the HST registration.
   *
   * WHY THIS EXISTS. `company-settings` stripped these for `isAgent(user)` — a literal
   * `role === 'agent'` test, the mistake this file opens by warning against. It answered the
   * question "is this person an agent?" when the question is "may this person see the operating
   * account?", so every role invented after it was granted access by default. Measured during the
   * CRM › Settings audit: the `crm` role received all six, while its own permission map is
   * `transactions: 'none'`, `invoice: 'none'` — it cannot open a single screen that displays them.
   *
   * WHY `accounting` IS THE LEVEL, and not something stricter. The six documents that print these
   * numbers — Invoice, Trade Sheet, Notice of Sale, Deposit Receipt, Lawyer Statement — are opened
   * from TransactionDetailPage behind `!isAgent`, which `documentation` reaches on
   * `transactions: 'edit'` and `accounting` reaches for invoicing. Setting this any higher would
   * take the numbers away from the two roles whose job is to produce those documents. `accounting`
   * and `documentation` share rank 60, so one threshold admits both, and `crm` (40) and `agent`
   * (20) fall below it — which is exactly the line the product already draws.
   */
  'company.read-banking': ROLE_RANK.accounting,
  /** Read data belonging to people other than yourself. */
  'data.read-all': ROLE_RANK.manager,
  /**
   * THE CRM'S DATA SCOPE FOR LEADS: may this person work with the leads the BROKERAGE owns?
   *
   * This is a data-scope capability, not an action permission, and the distinction is the whole
   * point. `lead: view/edit` says which lead SCREENS you may open; this says which lead ROWS are
   * yours to open. Both must pass. Before this existed the CRM answered the row question in three
   * different places and got three different answers — see `common/lead-scope.ts`.
   *
   * WHAT A BROKERAGE LEAD IS. `owner_user_id IS NULL`. That is not a new marking invented here: it
   * is what unattributed intake has always looked like in this database, what `LeadTransferService`
   * calls "the brokerage's own pool", and what `leads_owner_email_key` COALESCEs to book 0. A lead
   * with an owner belongs to that person; a lead without one belongs to the brokerage.
   *
   * WHAT IT DOES NOT GRANT, and this is the reason it is a separate capability rather than a rank:
   * it never reaches a lead somebody OWNS. An agent's private book is invisible to every holder of
   * this capability, at every rank, on every screen. Widening to the brokerage's own leads and
   * widening to everybody's leads are different changes, and only the first is wanted.
   *
   * WHO HOLDS IT: EVERY ROLE EXCEPT `agent`. That is the business rule in one line — an agent has a
   * personal book, and everybody else is brokerage staff working the brokerage's leads. It is the
   * same line that decides OWNERSHIP at intake (`LeadsService.create`, the CSV importer and the
   * Meta sync all ask `isAgent`), and the two must agree: a role that creates brokerage leads and
   * cannot then see them would be a trap, which is exactly what happens if these two lists drift.
   *
   * WRITTEN OUT RATHER THAN AS `role !== 'agent'`, deliberately. A negative predicate hands the
   * brokerage's whole lead book to any role invented later, before anyone has decided that it
   * should. Listing today's five keeps the rule reviewable and makes a new role opt IN.
   *
   * `admin` is listed rather than special-cased. Super Admin already reached unattributed intake
   * through `isSuperAdmin`, which is what this replaces, so their scope is unchanged by this entry —
   * and CRM data visibility now comes from a capability the business can reason about rather than
   * from being the top of the ladder. See the comment on `leadScopeWhere`.
   *
   * Still reaches NO agent's private book, at any rank. `leadScopeWhere` has no branch that drops
   * the owner clause.
   */
  'leads.brokerage-scope': ['admin', 'manager', 'accounting', 'documentation', 'crm'],
  /**
   * Work with the brokerage's whole marketing audience: select leads across the brokerage rather
   * than only your own, and see the whole opt-out list.
   *
   * NAMED ROLES, NOT A RANK — the one capability here that is not a threshold, and deliberately so.
   * Marketing responsibility does not run along the seniority ladder. `crm` sits at rank 40 and
   * needs this; `accounting` and `documentation` sit ABOVE it at 60 and do not, because neither runs
   * campaigns or manages unsubscribes. Any threshold that admitted `crm` would also admit those two,
   * handing a brokerage-wide list of client email addresses to roles with no reason to hold one.
   *
   * `agent` is absent and keeps their own leads only — which is exactly the set they could otherwise
   * have mailed.
   *
   * THIS GOVERNS SELECTION, NOT PERMISSION TO SEND. Every existing control still applies to whoever
   * holds it: suppression and unsubscribe state, the campaign's own filters, lead status, duplicate
   * prevention and malformed-address exclusion all run afterwards in `resolveRecipients`. Widening
   * the pool is not the same as bypassing the rules that narrow it.
   */
  'campaigns.brokerage-audience': ['admin', 'manager', 'crm'],
  /**
   * Open the Invoice module at all — read or write, list or detail, and every financial route
   * hanging off it.
   *
   * A NAMED SET, NOT A THRESHOLD, and this is the case that shows why the two forms both have to
   * exist. Invoices are brokerage financial records. The three roles that need them are Super Admin,
   * Admin and Accounting; `documentation` shares Accounting's rank of 60 and must NOT have them, so
   * no threshold can express the answer — `ROLE_RANK.accounting` would admit `documentation` by
   * arithmetic, and anything higher would lock Accounting out of the module it exists to run.
   *
   * WHY THIS IS A CAPABILITY AND NOT JUST THE `invoice` SCREEN PERMISSION. The screen permission is
   * an administrator's per-user dial, and dials get turned by mistake: granting `invoice: view` to
   * an agent through Roles & Permissions used to hand them the brokerage's whole invoice ledger,
   * because `InvoicesService.index()` filters on nothing but `deleted_at`. The role is not a dial.
   * Both are now required — the permission says which screens you may open, this says whether the
   * money is any of your business — so a mistaken override grants nothing.
   *
   * Deliberately NOT scoped per record. Invoices are the brokerage's billing, not an agent's own
   * work, so "an agent sees their own invoices" is the wrong model and is not offered: an agent sees
   * none.
   */
  'invoices.access': ['admin', 'manager', 'accounting'],
  /**
   * Change the identity of a lead the brokerage assigned to you — its name, email, phone, source
   * and assignment — or delete it.
   *
   * Whoever is WORKING a lead they did not create may record everything about the conversation and
   * change nothing about who the lead is; the brokerage owns that relationship. This was written as
   * `role === 'agent'`, which quietly exempted `crm`, `accounting` and `documentation` — three
   * roles that already existed — and would exempt every role added after it. Expressed as an
   * action, the ladder answers correctly for roles nobody has invented yet.
   *
   * Set at `manager`, so Admin and Super Admin may correct a lead's details on anyone's desk and
   * nobody below them may.
   */
  'leads.rewrite-identity': ROLE_RANK.manager,
} as const;

export type Capability = keyof typeof CAPABILITIES;

/** Does this person hold at least the authority of `role`? */
export const atLeast = (u: Principal | null | undefined, role: string): boolean =>
  rankOf(u) >= (ROLE_RANK[role] ?? Number.POSITIVE_INFINITY);

/**
 * The top tier. `role === 'admin'` throughout this application, labelled "Super Admin" in the UI.
 */
export const isSuperAdmin = (u: Principal | null | undefined): boolean => rankOf(u) >= ROLE_RANK.admin;

/**
 * Every role that counts as top tier, for the callers that must COUNT them rather than test one.
 *
 * "Is the last administrator being deleted?" cannot be answered by `isSuperAdmin`, because that
 * takes a principal and the question is about a population. The delete guard therefore counted
 * `role: 'admin'` literally — the sixteen-inline-comparisons mistake this file opens by warning
 * against, and one that would silently under-count the day a second top-tier role is added, letting
 * somebody remove the last account that can administer the brokerage.
 */
export const superAdminRoles = (): string[] =>
  Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] >= ROLE_RANK.admin);

/** Super Admin or Admin — what four services each spelled out for themselves. */
export const isAdminOrAbove = (u: Principal | null | undefined): boolean => rankOf(u) >= ROLE_RANK.manager;

/** An agent, the least privileged role, who sees their own work and no one else's. */
export const isAgent = (u: Principal | null | undefined): boolean => (u?.role ?? '') === 'agent';

/**
 * May this person perform this action?
 *
 * A capability is defined either as a RANK THRESHOLD — the least authority that may perform it, which
 * is right when the action follows the seniority ladder — or as an EXPLICIT SET OF ROLES, which is
 * right when it does not. Marketing is the case that forced the second form: the role that needs it
 * ranks below two roles that must not have it, so no threshold can express the answer.
 *
 * A named set is the stricter of the two: a role added to `ROLE_RANK` later inherits threshold
 * capabilities at its rank, and inherits none of the named ones without being listed.
 */
export const can = (u: Principal | null | undefined, capability: Capability): boolean => {
  const rule = CAPABILITIES[capability];
  if (Array.isArray(rule)) return (rule as readonly string[]).includes(u?.role ?? '');
  return rankOf(u) >= (rule as number);
};

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
