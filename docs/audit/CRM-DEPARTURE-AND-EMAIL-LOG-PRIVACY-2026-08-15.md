# Departing-Agent Lead Handling · CRM Email-Log Privacy

**Date:** 2026-08-15 · **Branch:** `version_3`
**Nature:** hardening of two existing areas. No second ownership system. No new ownership field. No widening of access to agent-private leads. Reviews untouched. Transaction Desk untouched.

---

## PART 1 — DEPARTING AGENT

### 1.1 What was happening

`LeadTransferService.returnToBrokerage`, called from `OffboardingService.depart` whenever an account moved Active → Inactive:

```ts
// before
await prisma.leads.updateMany({
  where: { owner_user_id: userId, deleted_at: null, ...brokerageLeadWhere() },
  data:  { owner_user_id: null },              // ← the agent's own clients, published
});
await prisma.leads.updateMany({
  where: { assigned_to: userId, ...brokerage },
  data:  { assigned_to: null },
});
```

Every non-Meta lead the leaver **owned** was converted to a brokerage lead. Their private book became visible to every brokerage role on the day they left.

**Why it was written that way, and why that reason has expired.** Ownership used to be decided *at departure*: every lead was owned by whoever created it, so an agent's book genuinely contained the brokerage's walk-ins and campaign enquiries. Unless those were unowned at the moment of departure, nobody could ever see them again. That reasoning was sound then. Ownership is now decided *at intake* — a brokerage lead is already `owner_user_id IS NULL` whoever is working it — so there is nothing left to convert, and converting anyway takes the one genuinely private category and publishes it.

### 1.2 What it does now

```ts
// after — one column, and only one
const unassigned = await prisma.leads.updateMany({
  where: { assigned_to: userId, deleted_at: null },
  data:  { assigned_to: null },
});
const keptPrivate = await prisma.leads.count({
  where: { owner_user_id: userId, deleted_at: null },
});
```

| What they held | What happens |
|---|---|
| **Brokerage lead assigned to them** | assignment cleared → back in the unassigned pool, still `owner_user_id IS NULL`, still live in the CRM, never deleted |
| **A colleague's lead assigned to them** | only the extra assignee is dropped; the owner keeps it |
| **Their own leads** | **untouched.** Still theirs, still private, still invisible to the brokerage |

`owner_user_id` is never written by any departure path.

### 1.3 The `brokerageLeadWhere()` predicate has been removed

It meant *"not `source = 'facebook_meta'`"* and answered an ownership question from the source column. It had two call sites and both were wrong under the current model:

- in `returnToBrokerage`, it selected which of the agent's owned leads to convert — an operation that no longer exists;
- in `LeadTransferService.eligibleWhere`, it filtered Meta leads out of the hand-out pool. That was **redundant** (a personal Meta lead is *owned*, so `owner_user_id IS NULL` already excludes it) and had become **harmful**: a Page connected by brokerage staff now produces brokerage-owned Meta leads, and once the person triaging them left, those leads landed unowned and unassigned — the definition of the pool — and this predicate filtered them straight back out. A lead the brokerage paid for would have been stranded permanently.

The function is deleted; a comment in `lead.constants.ts` records why, so nothing reintroduces it. `META_LEAD_SOURCE` remains and still records *how* a lead arrived.

### 1.4 Exhaustive sweep for other conversion paths

Every write to `owner_user_id` in the codebase, verified:

| Site | Purpose | Converts on departure? |
|---|---|---|
| `LeadsService.create` | intake (`ownerAtIntake`) | no |
| `LeadImportEngine` | intake | no |
| `MetaSyncService` | intake | no |
| `LeadTransferService.transfer` | assigns only, never writes owner | no |
| `LeadTransferService.returnToBrokerage` | **no longer writes owner at all** | no |

Every other match is a `where` clause, a `select`, or the presenter.

**Deactivation paths:** exactly one reaches `depart()` — `UsersService.update` when status goes Active → Inactive (`users.service.ts:144`), plus the delete path at `:253`. There is no bulk deactivation endpoint, no scheduled cleanup and no cascade that touches lead ownership.

### 1.5 Deletion: a real dependency, named rather than worked around

Deleting a user is still refused while they own leads. This is **not** ownership-transfer-as-a-workaround; it is a genuine schema dependency:

> `leads.owner_user_id` is a bare integer with **no foreign key**, and `users` has **no soft delete**. Removing the row would leave those leads owned by an id resolving to nobody — outside every scope, on no screen, unrecoverable.

The obvious workaround — nulling the owner so the delete succeeds — is exactly the conversion this work removed, so it is forbidden. Both refusal messages were rewritten: they had described the old behaviour ("leads that arrived through their own Meta account", "returns their brokerage leads to the brokerage"). They now state the real dependency and the real remedies: **the agent exports or removes their own leads, or the account is deactivated instead.**

**Deactivation is never blocked.** `depart()` runs after the status change and cannot refuse it; a failure is logged and reported while the account still switches off. Asserted directly.

### 1.6 Identifying the three states

`LeadsService.present` now returns `ownership: 'brokerage' | 'agent'` alongside the existing `assigned_to_name`, giving the three states the business asked for:

| Displayed as | From |
|---|---|
| Brokerage Lead — Unassigned | `ownership: 'brokerage'`, `assigned_to_name: null` |
| Brokerage Lead — Assigned to *N* | `ownership: 'brokerage'`, `assigned_to_name: 'N'` |
| Private Lead — agent-owned | `ownership: 'agent'` |

It discloses nothing new: `owner_user_id` was already on the row, and the scope rule guarantees every row reaching the presenter is either the brokerage's or the reader's own — so the label can never say `agent` about a lead the reader may not see.

### 1.7 Export / clear before leaving

Both already exist and are correctly scoped, so nothing was built:

- **Export** — `POST /api/leads/export`, requires `lead: edit`, scoped by `leadScopeWhere`; an agent gets their own book and nothing else.
- **Clear** — `DELETE /api/leads/:id` and `POST /api/leads/bulk-delete`, same scope.
- **Count shown during offboarding** — the checklist reports `leads.personal`, and its wording now tells the administrator these are not transferred, are not visible to anyone else, and **do not prevent the account being switched off**.

---

## PART 2 — CRM EMAIL-LOG PRIVACY

### 2.1 What was happening

```ts
// before
where: can(user, 'data.read-all') ? {} : { sent_by: user.name ?? '' }
```

`data.read-all` is a permission about **whose sends you may read**. It was deciding the whole query, so it also decided **whose clients you may read about** — and the rows carry `lead_name`, `recipient` (the address) and `subject`.

This was the one CRM surface where lead identities escaped `leadScopeWhere`. A Manager who got 404 on an agent's private lead from the Leads module, from search, from campaigns and from direct email could read that same client's name, address and subject lines here, one row at a time.

### 2.2 The rule now enforced

Two independent conditions, both required:

```
email-log permission   (data.read-all → everyone's sends, else your own)
        AND
lead scope             (leadScopeWhere → may you see this client at all?)
```

`crm_email_log` carries no lead id, only the recipient address, so the address is resolved back to leads and the caller's own scope decides. Three outcomes:

| Case | Result | Why |
|---|---|---|
| The address is nobody's lead | **shown** | A test send, or a lead long since purged. Nothing private to protect — and swallowing these would quietly empty the administrator's log |
| The address is a lead they **can** see | **shown** | They can already read that name and address on the Leads screen. The same person legitimately appears in two books, which is why `leads_owner_email_key` is per book |
| **Every** lead at that address is out of scope | **row hidden entirely** | Not redacted field by field: the row's existence, kind, subject and timestamp each say something about a client they may not know exists |

**Soft-deleted leads count as leads on both sides** — binning a private lead must not turn its correspondence public, and the owner keeps seeing their own.

A page may therefore return fewer rows than `limit`. That is deliberate: reporting how many were withheld would itself disclose that private correspondence exists.

### 2.3 Surfaces audited

Every read of `crm_email_log` in the codebase:

| Site | Kind | Action |
|---|---|---|
| `CrmAdvancedEmailService.listLog` | the only user-facing read (`GET /api/crm-settings/email-log`) | **fixed** |
| `LeadGreetingsService.alreadyGreeted` | internal idempotency check, returns a boolean | none needed |
| `LeadWelcomeService.alreadyWelcomed` | internal idempotency check, returns a boolean | none needed |
| `dispatch()` | writes rows | none needed |

There is **no** secondary route: no dashboard widget, notification, export, search or other API returns CRM email metadata. `client/src/lib/crmSettingsApi.ts` has a single call site.

`data.read-all` keeps its job — deciding whose sends you may read — and is no longer able to grant access to a client.

---

## TESTS

### Added — `server/src/core/lead-ownership-scope.spec.ts` (42 tests total)

Email-log privacy:
```
✓ hides a row about an agent’s private lead from every brokerage role
✓ shows that same row to the agent who owns the lead
✓ shows a row about a BROKERAGE lead to the roles whose log permission covers it
✓ still shows correspondence with an address that is nobody’s lead
✓ a SOFT-DELETED private lead does not become readable by the brokerage
✓ an agent still cannot read a COLLEAGUE’s sends, as before
```

The third of those pins the two conditions apart: `crm` may see the brokerage *lead* but not a *send* made by somebody else — and its **own** send about that same lead does come through, proving the refusal is the sender rule and not the lead rule.

### Added — mixed departure, exactly as specified

`server/src/users/offboarding.spec.ts` — 5 private leads (mixed sources: two Meta, one import, one manual, one with no source at all) + 10 brokerage leads assigned to the agent:

```
✓ releases the brokerage leads into the pool and leaves every private one alone
```

asserting all ten remain, undeleted, `owner_user_id IS NULL`, `assigned_to IS NULL`, and genuinely back in the Lead Books pool; all five remain owned by the agent and undeleted; and the account still deactivates.

```
✓ releases the ASSIGNMENT on a brokerage lead they were working, and keeps it in the CRM
✓ NEVER converts a lead the agent owns into a brokerage lead — whatever its source
✓ says plainly in the summary what stayed with them
✓ reports the split on the checklist by OWNERSHIP, not by source
```

### Added — browser (`e2e/tests/lead-ownership-scope.spec.ts`, 16 tests)

```
✓ the CRM email log cannot be used to discover an agent’s private lead
✓ deactivating an agent releases brokerage leads and keeps their own private
```

The second hires an agent through the real Users API, gives them one brokerage lead (assigned) and one of their own, deactivates them through the real endpoint, and asserts the brokerage lead is still present/unowned/unassigned while their own lead returns **404** to a Super Admin.

### Changed — tests that encoded the old model

| Test | Was | Now |
|---|---|---|
| `offboarding` × 4 | agent-owned leads convert to brokerage on departure | they stay private; assignments release |
| `offboarding.leadCounts` × 2 | a manual/source-less owned lead counts as the *brokerage's* | counts as *personal* — ownership, not source |
| `lead-transfer` "will not take a Meta lead even when it has no owner" | unowned Meta lead is never eligible | **it is the brokerage's and is handable**; a new test pins that an agent's *own* Meta lead still is not |
| `lead-ownership-scope` browser `beforeAll` | manufactured a brokerage lead by hiring→creating→deactivating | a Super Admin simply creates one — the departure route no longer produces one, by design |

---

## RESULTS

```
Typecheck  clean
Server     127 suites · 2028 tests passed · 0 failed
Browser    473 passed · 1 skipped · 2 pre-existing failures unrelated to this work
```

Neither browser failure is caused by this work; both were identified during the earlier CRM audit:

- `inbox.spec.ts:33` — **stale test.** It asserts the inbox body renders in a `<pre>`; `MailBody.tsx` deliberately replaced that with a sandboxed `srcdoc` iframe some time ago. Fails identically before and after.
- `account-google-cards.spec.ts:90` — **flaky test.** It reads the Google status pill immediately after asserting the element exists, with no wait for the status request, so it fails on a cold server. It passed in other runs of this same code.

---

## NOT CHANGED, AS INSTRUCTED

No new ownership field or model · ownership and assignment remain separate columns · assignment never changes ownership · no automatic transfer of agent-private leads · no brokerage lead deleted on departure · private leads never block deactivation · `data.read-all` can no longer bypass `leadScopeWhere` for lead-related records · no broad role-rank check replaced an explicit lead-scope rule · no unrelated CRM features added.

## ONE THING TO BE AWARE OF

**Existing data was not migrated.** Any lead converted by the old departure logic *before* this change is still recorded as `owner_user_id IS NULL` — the brokerage's. Nothing in the current code can tell those apart from genuine brokerage intake, because the conversion left no marker. If former agents' private books need restoring to them, that is a data exercise needing the audit trail and a decision per departed agent; it is not something this change could do safely on its own, and I have not attempted it.
