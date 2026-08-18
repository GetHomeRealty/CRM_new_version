# CRM Lead Visibility & Permission Alignment

**Date:** 2026-08-15 · **Branch:** `version_3`
**Nature:** correction and alignment of the existing permission model. No new feature. Reviews module untouched. Transaction Desk untouched.

---

## A. THE EXISTING OWNERSHIP MODEL

The database already distinguished the two categories. Nothing new was introduced — no column, no table, no second ownership system.

| Concept | How the database records it |
|---|---|
| **Brokerage lead** | `leads.owner_user_id IS NULL` |
| **Agent lead** | `leads.owner_user_id = <user id>` |
| **Assignment** | `leads.assigned_to` — a **separate, independent** column |
| **Created by** | `leads.created_by` — a display *name string*, no foreign key. Not used for authorization |
| **Lead source** | `leads.source` — `manual` \| `import` \| `facebook_meta`. `leads.lead_source` is a free-text channel label a person typed and is **not** an ownership signal |

`owner_user_id IS NULL` was already the system's word for "the brokerage's". `LeadTransferService` calls it *"the brokerage's own pool"*; the unique index `leads_owner_email_key` is `UNIQUE(COALESCE(owner_user_id, 0), lower(email))`, which deliberately COALESCEs unowned rows into one shared book — book 0, the brokerage's.

**So Model A was already expressible.** `owner = brokerage, assigned = Agent A` is `owner_user_id IS NULL, assigned_to = A`. The model did not need building; it needed *using*.

### Assignment: Model A or Model B?

**It was Model B, and that was the defect.** `LeadTransferService.transfer` wrote *both* columns:

```ts
data: { owner_user_id: toUserId, assigned_to: toUserId }   // before
```

Handing a brokerage lead to an agent **converted it into that agent's private lead**. The brokerage permanently lost sight of a lead it had generated and paid for; the only way it ever came back was the agent leaving. It is now Model A — see §C.

---

## B. THE EXISTING PROBLEM

Four CRM surfaces each decided lead scope **independently**, and three disagreed. Measured on the running application for one Manager, at one moment:

| Surface | Answer | Implementation |
|---|---:|---|
| Leads screen | **0** | `lead-scope.ts` → `isSuperAdmin(user)` was the only route to a brokerage lead |
| Campaign audience | **81** | `campaign-audience.service.ts:65` → `if (can(user,'campaigns.brokerage-audience')) return {}` |
| Direct CRM email | **every lead** | `crm-advanced-email.service.ts:578` → `can(user,'data.read-all') ? {} : …` |
| Dashboard / calendar / notifications | 0 | correctly delegated to `lead-scope.ts`, so they inherited its narrowness |

`{}` is not "brokerage-wide" — **`{}` is every row in the table**. So the CRM was simultaneously:

- **too tight** on the screen people work from — the Manager and the CRM role, whose entire job is brokerage lead handling, saw an empty Leads list; and
- **too loose** on the two paths that actually send mail to clients — both could reach every agent's private book. Of the 81 leads a Manager could mail, **14 were agents' private clients** they could not open, contact history unseen.

A per-service test would have passed on all four. That is why the fix is a single shared rule and the regression test asks every module the same question.

---

## C. CHANGES MADE

| File / service | Existing logic | Problem | New logic | Risk |
|---|---|---|---|---|
| `core/authz.ts` | — | No data-scope capability existed; scope was inferred from rank | Added `leads.brokerage-scope`, a **named set** of every role except `agent` | Widens brokerage-lead visibility to `accounting`/`documentation`; neither can reach any agent's private lead |
| `common/lead-scope.ts` | — | Each intake path decided ownership for itself | Added `ownerAtIntake` — the single intake rule | Behaviour change, intended (§I.1) |
| `leads/leads.service.ts` (`create`) | `owner_user_id: user.id` | Every creator owned what they made, so non-agents made private leads | `ownerAtIntake(user)` | Non-agent creations become brokerage leads |
| `leads/lead-import.engine.ts` (`create`) | `owner_user_id: ctx.userId` | Same | `ctx.ownerId`, defaulting to the importer when absent | Brokerage imports land in the brokerage's book |
| `meta/meta-sync.service.ts` | `owner_user_id: ctx.userId` | An admin-connected Page produced that admin's private leads | `ownerFor(ctx)` from `ownerAtIntake` | Brokerage ad leads become brokerage leads |
| `common/lead-scope.ts` | `if (isSuperAdmin(user)) mine.push({owner_user_id:null})` | Only the top tier reached brokerage leads | `if (hasBrokerageLeadScope(user))` + exported `hasBrokerageLeadScope` / `isBrokerageLead` | **Widens** to brokerage-owned leads only. Agent books untouched |
| `campaigns/campaign-audience.service.ts` | `if (can(...)) return {}` | Unscoped — every agent's private book | `leadScopeWhere(user)` | **Narrows.** Campaigns lose reach into private books |
| `crm-settings/crm-advanced-email.service.ts` | `can(user,'data.read-all') ? {} : leadScopeWhere(user)` | Unscoped — any lead addressable | `leadScopeWhere(user)` always | **Narrows.** Refusal wording now matches the rule enforced |
| `leads/lead-transfer.service.ts` | `{ owner_user_id: toUserId, assigned_to: toUserId }` | Model B — converted brokerage lead to private | `{ assigned_to: toUserId }` only | Behaviour change, intended. Brokerage retains ownership |
| `leads/leads.service.ts` | `canSee`: `owner===null && isSuperAdmin` | Row check disagreed with the query | `isBrokerageLead(lead) && hasBrokerageLeadScope(user)` | None — now consistent |
| `core/resource-access.service.ts` | `assertLead`: same `isSuperAdmin` spelling | Guard for **all** lead activities disagreed | Same shared helpers | None — now consistent |
| `leads/lead-import.engine.ts` + `lead-import-job.service.ts` | `userIsSuperAdmin` | Named a role instead of asking for a scope; a manager's import would have **duplicated every brokerage lead** | `userHasBrokerageScope` | Prevents a duplication bug the widening would otherwise have introduced |

**Net effect on access:** brokerage roles *gain* the brokerage's own leads; campaigns and direct email *lose* their reach into agents' private books; agents are entirely unaffected. No path was widened to a lead anybody owns.

### One central rule

`leadScopeWhere` is now the only implementation. It has **no branch that returns `{}`** — a property asserted directly by a test, because a returning-everything branch is precisely what three services had.

---

## D. ROLE MATRIX

Verified — every cell exercised by `src/core/lead-ownership-scope.spec.ts` and/or `e2e/tests/lead-ownership-scope.spec.ts`.

| Lead type | Agent | Manager | CRM Role | Admin¹ | Super Admin | Accounting / Documentation |
|---|---|---|---|---|---|---|
| Own private lead | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Other agent's private lead** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Brokerage unassigned lead | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brokerage lead assigned to self | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brokerage lead assigned to another agent | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ In this application `manager` is labelled **"Admin"** and `admin` is labelled **"Super Admin"**. Both are shown.

**No role, at any rank, reaches another agent's private lead.** Super Admin included — asserted explicitly in both suites.

`accounting` and `documentation` DO hold brokerage scope, because every non-agent role is brokerage staff — see §I.1. Neither can create a lead in practice (`lead: view`, and creating needs `lead: edit`), but if they ever did it would belong to the brokerage, so they must be able to see the brokerage's book. Ownership and visibility are two halves of one decision.

---

## E. MODULE CONSISTENCY

| Module | Uses the central brokerage scope? | Agent leads protected? | Status |
|---|---|---|---|
| Leads (list, detail, filters, pagination, search) | ✅ `leadScopeWhere` | ✅ | **FIXED** |
| Search / autocomplete | ✅ composes on the scope | ✅ | **VERIFIED** |
| Campaigns (audience, preview, send) | ✅ now `leadScopeWhere` | ✅ | **FIXED** |
| Direct CRM email | ✅ now `leadScopeWhere` | ✅ | **FIXED** |
| Lead activities (notes, tasks, showings, calls, messages) | ✅ via `ResourceAccessService.assertLead` | ✅ | **FIXED** |
| Tasks / follow-ups | ✅ `leadTaskScopeWhere` → `liveLeadWhere` | ✅ | **INHERITED** |
| Dashboard | ✅ `liveLeadWhere` | ✅ | **INHERITED** |
| Calendar | ✅ `liveLeadWhere` | ✅ | **INHERITED** |
| Notifications | ✅ `leadScopeWhere` | ✅ | **INHERITED** |
| Export | ✅ same `where` as the list | ✅ | **VERIFIED** |
| Import (duplicate matching) | ✅ `userHasBrokerageScope` | ✅ | **FIXED** |
| Lead Books | ✅ pool is unowned + unassigned | ✅ | **FIXED (Model A)** |
| **CRM email log** (`listLog`) | ❌ still `data.read-all` → `{}` | ⚠️ **No** | **DECISION — §I.4** |

---

## F. SECURITY TESTS

Run against a live API with the UI bypassed, as each role, before and after.

| Attempt (target = Agent A's private lead) | Manager | CRM | Super Admin | Agent B |
|---|---|---|---|---|
| `GET /api/leads/{id}` | **404** | **404** | **404** | **404** |
| `PUT /api/leads/{id}` | **404** | **404** | **404** | **404** |
| `DELETE /api/leads/{id}` | **404** | **404** | **404** | **404** |
| `POST /api/leads/{id}/notes` · `/tasks` · `/calls` · `/showings` | **404** | **404** | **404** | **404** |
| Direct email to that address | **refused** | refused | **refused** | refused |
| Campaign audience containing it | **excluded** | excluded | excluded | excluded |
| `POST /api/leads/export` | **absent from file** | absent | absent | absent |
| `GET /api/leads?search=<their name>` | **no result** | no result | no result | no result |

`404`, never `403` — the answer must not depend on who is asking, or the guard becomes a way to enumerate other people's books one id at a time.

**Client-supplied ownership.** `owner_user_id` is not in `LeadsService.validate`'s allow-list, so it cannot be set or changed through any request. Verified live: `PUT /api/leads/5 {owner_user_id: 1, id: 9999}` returned 200, and the row was read back from the database still owned by user 4, with no id 9999 created. An agent therefore cannot mark their lead brokerage-owned to expose it, nor claim a brokerage lead as their own.

**Assignment cannot be self-served.** On a brokerage lead an agent holds, `assigned_to` is a LOCKED field (`isBrokerageAssigned`), so they cannot pass it on or take it. Only `leads.rewrite-identity` holders (manager and above) may reassign.

---

## G. BROWSER TESTS

`e2e/tests/lead-ownership-scope.spec.ts` — **12 tests, all passing**, in real Chromium against the real SPA and API.

It does not plant fixtures. It hires a throwaway agent through the Users API, signs in **as them**, has them create a lead, then deactivates them — the one supported workflow that produces a brokerage-owned lead — and asserts on the rendered page:

- **`a Manager SEES the brokerage lead on the Leads screen`** — the headline regression, read from the DOM. This was blank before.
- The CRM role sees it too.
- On that same screen, in the same session, the agent's private lead is **absent** — the pairing is what makes it an ownership test rather than a page-load test.
- Super Admin gets 404 on the private lead.
- Screen and campaign audience agree; audience never exceeds the visible list.
- Export contains no unseen lead; search cannot surface one.
- Assigning the brokerage lead: brokerage keeps it, assignee gains it, other agent does not, `owner_user_id` still `NULL`.

---

## H. REGRESSION TESTS

| | |
|---|---|
| **Added** | `server/src/core/lead-ownership-scope.spec.ts` — **36 tests**, seeded exactly as the requirement specifies: 10 brokerage, 5 Agent A, 7 Agent B — plus the intake-ownership table for every role and source |
| **Added** | `e2e/tests/lead-ownership-scope.spec.ts` — **14 browser tests** |
| **Changed** | `campaigns/brokerage-audience.spec.ts` — asserted `ownerClause === null` (i.e. `{}`, every lead). That expectation *was the bug*; now asserts the brokerage clause is present, plus a new test that **no role** gets an empty owner clause |
| **Changed** | `core/lead-transfer.spec.ts` — asserted transfer set `owner_user_id`; now asserts assignment with ownership retained |
| **Changed** | `users/offboarding.spec.ts` — same; the routing it proves is unchanged |
| **Changed** | `core/authz.spec.ts`, `leads/lead-import.spec.ts` — new capability, renamed context field |
| **Changed** | `e2e/settings-high-fixes.spec.ts` — **H5 partially reversed**, see below |
| **Changed** | `e2e/settings-low-fixes.spec.ts` — the two L10 mailbox cases addressed an agent-owned lead, so the send is now refused at the recipient check before reaching the mailbox selection they exist to pin. They create their own recipient instead; subject of the test unchanged |
| **Changed** | `e2e/notification-center.spec.ts` — two cases assumed **every** feed item is transaction-shaped (`key === source:transaction_id`, a `/desk/transactions/…` link, one of four Desk sources). `direct` has been a fifth source since the in-app platform shipped, with `transaction_id: 0` and its own id. They were passing on the *absence* of CRM in-app notifications, not on a property of the feed. Both now handle each shape; the isolation assertion is strengthened rather than relaxed |

### A previously-shipped decision this reverses — H5

`settings-high-fixes.spec.ts` asserted *"an administrator can email a lead on somebody else's desk"*. That fix was right about the problem — the "Send a CRM Email" card refused every recipient it would ever be given — and went one step too far by using unscoped `data.read-all`.

The new rule is narrower and deliberate: an administrator emails **the brokerage's** leads, not an agent's private ones. The test block is rewritten with the reasoning recorded in it, so nobody "fixes" it back without seeing why. Its two refusal cases are kept, because refusals are what regress silently.

### Results

```
Typecheck:  clean
Server:     Test Suites 127 passed · Tests 2018 passed, 0 failed
Browser:    472 passed · 1 skipped · 1 pre-existing failure unrelated to this work
```

The single browser failure is `inbox.spec.ts:33`, which asserts the inbox body renders in a `<pre>`; `MailBody.tsx` deliberately replaced that with a sandboxed `srcdoc` iframe some time ago. It fails identically before and after this change and is recorded in the audit report as L1.

The required assertion is `lead-ownership-scope.spec.ts` — *"a Manager can access brokerage-owned leads while being unable to access private agent-owned leads through Leads, Search, Campaigns, Direct Email, Reports or Export"* — and it holds:

```
✓ a Manager sees the 10 brokerage leads — not 0, and not all 22
✓ campaign audience offers the brokerage’s 10, not every agent’s book
✓ direct email resolves a brokerage lead for a Manager, and refuses an agent’s private one
✓ export carries the brokerage’s 10 and no private lead
✓ search cannot surface another agent’s lead by name
✓ a filter narrows the scope and can never widen it
✓ refuses a Manager, a CRM user and a Super Admin on an agent’s private lead
✓ never drops the owner clause — there is no branch that returns everything
```

and the intake rule, for every role and every source:

```
✓ admin / manager / crm / accounting / documentation create for the BROKERAGE — owner is null
✓ an agent owns what they create
✓ a CSV import run by a Manager lands in the brokerage’s book, not the Manager’s
✓ a CSV import run by an agent fills that agent’s own book
✓ a Manager’s new lead really is the brokerage’s, and the CRM role can see it
✓ an agent’s new lead stays private to them
✓ every role that creates brokerage leads can also see them
```

`10`, not `0` and not `22`. Asserting the exact number is what distinguishes *fixed* from *opened up*.

---

## I. DECISIONS REQUIRED

These are ambiguous by the requirement's own test, so nothing was silently chosen.

### I.1 — Intake ownership  ✅ **DECIDED AND IMPLEMENTED**

The problem found: **nothing in the application created a brokerage lead.** Every intake path stamped the acting user as owner, so the only producer of a brokerage-owned lead was an agent *leaving*. Measured before the change: `myapp_test` **0** brokerage leads of 81; `myapp` (dev) **0** of 3.

**The rule now implemented, confirmed by the business:**

> **Only an agent owns a lead. Every other role creates for the brokerage, whatever the source.**

| Source | Owner |
|---|---|
| Agent creates manually | **Agent** |
| Agent imports CSV | **Agent** |
| Agent's own Meta ad account | **Agent** |
| Any non-agent creates manually | **Brokerage** (`owner_user_id = NULL`) |
| Any non-agent imports CSV | **Brokerage** |
| Meta Page connected by a non-agent | **Brokerage** |
| Agent departs (`returnToBrokerage`) | **Brokerage** |

Implemented as one shared function, `ownerAtIntake(user)` in `common/lead-scope.ts`, called by `LeadsService.create`, `LeadImportJobService` and `MetaSyncService`. The answer cannot depend on which door a lead came through — only on who was standing at it.

**Consequence, and why `leads.brokerage-scope` widened.** Ownership is decided by `isAgent`; visibility by `leads.brokerage-scope`. These describe the same split from opposite sides, so they must partition the roles *identically* — otherwise a role creates leads it cannot then see, and the save looks broken. The capability therefore covers **every role except `agent`**, now including `accounting` and `documentation`.

In practice those two cannot create leads anyway (they hold `lead: view`; creating needs `lead: edit`), so this is closing a trap rather than opening a door — and a test asserts the two lists stay in step:

```
✓ every role that creates brokerage leads can also see them
```

**Meta, specifically.** Meta reports nothing about whose budget paid for a click, so the only honest signal is who connected the Page: an agent connecting their own ad account keeps their leads, anyone else is the brokerage advertising for itself. A brokerage Meta lead keeps `source = 'facebook_meta'` — the source records *how* it arrived, ownership records *whose* it is — so the long-standing rule that a personal Meta lead stays with a departing agent is untouched, because that rule is about leads an agent **owns**.

**Still no website intake path exists.** If brokerage website enquiries are meant to become leads, that is a separate piece of work; nothing was invented for it here.

### I.2 — A departing agent's *private* leads become brokerage leads

`returnToBrokerage` nulls `owner_user_id` on every non-Meta lead the leaver owned — including ones they created themselves. Requirement §15 says not to convert private leads automatically. **This is pre-existing, deliberate and documented** (otherwise the leads are invisible to everyone for ever), so I left it. It now has a wider effect: those leads become visible to Manager and CRM as well as Super Admin. **Confirm this is wanted.**

### I.3 — The CRM email log still uses `data.read-all`

`listLog` returns `{}` for `manager` and above — the whole brokerage's send history, including `lead_name` and `recipient` for **agents' private leads**. It is an indirect disclosure of private lead identities. Left unchanged because a compliance log is a different category from a lead record and narrowing it may remove a CASL capability. **Decide:** keep as an audit record, or scope it like everything else.

---

## J. CLASHES RESOLVED

| Clash | Resolution |
|---|---|
| Leads screen said 0, campaign audience said 81 | Both now resolve `leadScopeWhere` |
| Direct email reached every lead via `data.read-all` | Now the same scope as the screen |
| Ownership and assignment collapsed into one field on transfer | Separated — Model A |
| Row checks (`canSee`, `assertLead`) spelled the rule themselves | Both delegate to shared helpers |
| Import matched on `isSuperAdmin` | Now matches on the same scope, preventing duplicate creation |

`campaigns.brokerage-audience` is now unused for scoping. It is **left defined** — it still documents the marketing-roles decision and is referenced by the suppression-list rules — but it no longer grants data reach.

---

## K. WHAT WAS NOT CHANGED

Transaction Desk permissions, routes, services and scope — untouched. `transaction-scope.ts` was not modified, and no CRM change reaches it. Reviews — untouched. No schema change, no migration: the fix uses columns that already existed.
