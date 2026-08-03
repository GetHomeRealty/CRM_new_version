# CRM › Users — Enterprise Production Readiness Audit

> **REMEDIATION — 2026-08-02.** The CRITICAL finding, all five HIGH and all nine MEDIUM are fixed and
> re-verified against the same probes that found them — see [Remediation](#remediation--2026-08-02)
> at the end. The findings below are preserved as written, because the reasoning is what makes the
> fixes reviewable.

**Date:** 2026-08-02 · **Scope:** the Users module only — `server/src/users/*`, the `users`,
`user_permissions` and `user_modules` tables, `client/src/desk/UsersPage.tsx`, and the account/photo
endpoints. Connected modules (Dashboard commission resolution, Leads, Calendar, Meta, Audit) were
verified **only at the handoff**, to establish what a change to a user record does downstream.
Neither was audited.

**Method:** full read of all nine server files and the client screen, then runtime testing against a
running stack — three roles through the browser with screenshots, ~60 API probes covering
validation, uniqueness, escalation, mass assignment, uploads, malformed payloads and concurrency,
plus direct database queries for constraints and referential integrity. Every finding marked
**[RUNTIME]** was observed; the observed output is quoted.

---

## Executive Summary

The perimeter of this module is genuinely well built, and several things I expected to be wrong were
not. Mass assignment is blocked — `id`, `is_admin` and `company_id` sent in the body are ignored.
CSRF is enforced (419 without a token). Passwords are bcrypt-hashed and never appear in any payload.
Role isolation holds: an agent and a manager both get an access notice, zero rows and no controls.
**Deactivating or deleting a user cuts their access mid-session** — `loadUser` re-checks status on
every request, measured at 200 → 401 on a live session. A path-traversal filename in a photo upload
is neutralised by construction. I suspected an avatar file leak and disproved it: four uploads leave
exactly one file.

The failures are in the middle of the module, and the worst of them is financial.

**The Users screen lets you give a new hire the same name as a departed colleague**, because the
uniqueness rule deliberately ignores deactivated accounts. Commission splits are then resolved by
name, with no status filter — and the query returns the **inactive** row. Measured: a deactivated
"Dup Namesake" on 10% and an active one on 90% resolve, three times out of three, to the departed
agent's 10%. Every deal the new agent closes would pay the wrong percentage, silently, with nothing
on any screen to show it. The comment justifying the rule states that "nothing resolves splits to an
inactive account", which is not true of the code as written.

Two further defects make the module actively misleading rather than merely incomplete. **Department
and Designation are on the Add User form, are sent by the client, and are discarded by the API** —
create with `department=Sales` and the stored value is `null`; update it and it stays `null`. And
**granting the "Users" screen permission does nothing while appearing to work**: the nav item
appears, the page renders with an enabled "+ Add User" button, and every request returns 403
"Administrator access required." An administrator hands out access, sees it accepted, and the
recipient gets a broken screen.

Beneath those: two of three simultaneous creates with the same email return **HTTP 500** rather than
a validation error; hard-deleting a user leaves dangling ids in **42 of the 47 columns** that hold
one, because only five have foreign keys; and email uniqueness is case-sensitive, so two accounts
can differ only by capitalisation.

**A user directory that pays the wrong commission, silently drops two fields it asks you to fill in,
and grants access that does not work is not ready for a brokerage with hundreds of agents.**

### Production Readiness Score

**52 / 100 — NOT PRODUCTION READY**

| Dimension | Score | Note |
|---|---|---|
| Authentication & session handling | 95 | Status re-checked per request; deactivation cuts a live session |
| Authorization (enforcement) | 88 | AdminGuard holds; agent and manager fully excluded |
| Authorization (as presented) | 25 | A granted permission silently does nothing |
| Field validation | 55 | Solid on types and limits; no trimming, no case-folding, no password ceiling |
| Business logic correctness | 20 | Namesake reuse resolves commission to the wrong person |
| Data integrity | 35 | Hard delete, 42 unconstrained references |
| Concurrency | 30 | Unique-violation race surfaces as 500 |
| API surface | 70 | Consistent codes except the race; no pagination |
| Security (injection, CSRF, mass assignment) | 90 | Nothing got through |
| File upload | 78 | Extension allowlist, size cap, random names; no content check |
| Performance | 60 | Fine at current size; unbounded profile blob is the amplifier |
| UI / UX | 55 | Errors reported off-screen; a dead permission control |

---

## CRITICAL

### U-C1 — A new hire reusing a departed agent's name is paid the departed agent's commission [RUNTIME]

**Where:** [`users.service.ts` `nameTaken`](../../server/src/users/users.service.ts) ·
[`dashboard.service.ts:182` `userProfiles`](../../server/src/dashboard/dashboard.service.ts#L182)

`nameTaken` blocks a duplicate name only among **Active** accounts:

```ts
where: { name, status: 'Active', ...(ignoreId ? { id: { not: ignoreId } } : {}) }
```

Its doc comment justifies this: *"nothing resolves splits or routes mail to an inactive account."*
That is the claim this finding disproves. Commission profiles are resolved by name with no status
filter at all:

```ts
const u = await this.prisma.users.findFirst({ where: { name }, select: { profile: true } });
```

**Observed.** Two rows, same name; the departed one deactivated on a 10% split, the new hire active
on 90%:

```
inactive #531 = 10%   active #532 = 90%
  findFirst({name}) ->  #531  status=Inactive  split=10%
  findFirst({name}) ->  #531  status=Inactive  split=10%
  findFirst({name}) ->  #531  status=Inactive  split=10%
```

And the Users screen permits creating that second row — confirmed through the API:

```
  reuse an INACTIVE user's name -> 201 (allowed — two rows now share a name)
```

**Why this is critical rather than high.** It is silent, financial, and reachable through entirely
ordinary use: an agent leaves, a replacement joins with the same common name — "David Chen",
"Maria Silva" — and every deal they close pays the wrong percentage. Nothing on any screen shows a
discrepancy, because both rows look correct in isolation. The error compounds per transaction and is
discovered, if ever, in a commission dispute.

`findFirst` without `orderBy` has **no defined order**, so which row wins can also change after a
`VACUUM`, a restore, or a plan change — with no code change. The same class of bug is already
documented in `dashboard.service.ts` as having been observed with two active accounts named "Akhil";
deactivating one of them does not fix it, it just hides it from the validator.

**Fix:** make `nameTaken` ignore status — a name is a join key for as long as any historical record
uses it. Then either resolve splits by user id, or make the resolution explicitly prefer an Active
row with a deterministic `orderBy`. **Estimate: 4 h** for the validation change; resolving splits by
id properly is a larger piece that belongs with the Transactions work.

---

## HIGH

### U-H1 — Department and Designation are collected and thrown away [RUNTIME]

**Where:** [`users.service.ts` `validate`](../../server/src/users/users.service.ts)

`validate()` returns only the keys its rules cover:

```ts
for (const k of ['name', 'username', 'email', 'password', 'role', 'status', 'profile', 'permissions'])
```

`department` and `designation` are not in that list, but `store()` and `update()` read them from the
validated object:

```ts
department: (data.department ?? null)                 // create → always null
department: (data.department ?? existing.department)  // update → always unchanged
```

**Observed:**

```
  create with department=Sales designation=Broker of Record -> 201
  stored department: null
  stored designation: null
  update to department=Accounts -> 200, stored: null
```

The fields are on the Add User form with placeholders "e.g. Sales, Accounts" and "e.g. Broker of
Record" (screenshot: `users-add-form.png`), the client sends them, and the API returns 200/201. A
user is told the save succeeded and nothing was saved.

**This blocks a business capability that is already being asked for.** Department-based lead routing
was requested on 2026-08-02 and could not be built, because no lead carries a department and the only
department field in the system is this one — which does not work.

**Fix:** add both to the validated key list with `nullable|string|max:120` to match the column.
**Estimate: 1 h**

### U-H2 — Granting the "Users" permission appears to work and does nothing [RUNTIME]

**Where:** [`users.controller.ts:28`](../../server/src/users/users.controller.ts#L28) ·
`client/src/App.tsx:91`

The Users API is gated by `AdminGuard` (`isSuperAdmin`) and carries **no** `@Screen('users', …)`.
The client route is gated by the `users` **screen permission**. The two disagree.

**Observed** — a Super Admin grants `Users: edit` to a manager through the Screen Permissions grid
that sits on the user form:

```
grant Users:edit -> 200, stored = edit
  after the grant:
    "Users" in nav      : YES — it appears
    page shows a notice : no
    table rows rendered : 0
    GET  /api/users     : 403 Administrator access required.
    POST /api/users     : 403 Administrator access required.
```

Screenshot `users-granted-manager.png`: a fully rendered Users page, "0 users", an **enabled**
"+ Add User" button, and two red "Could not load users" toasts.

**Why it is high.** A permission control that reports success and grants nothing is worse than one
that is absent — an administrator believes delegation has happened. There is no message anywhere
explaining that this module ignores the grid.

**Fix:** decide which is authoritative. Either put `@Screen('users', 'edit')` on the write routes and
`view` on the reads, or remove `users` from the permission grid for this module and say plainly that
user management is Super Admin only. **Estimate: 3 h** either way, plus a test that the grid and the
guard cannot disagree again.

### U-H3 — Simultaneous creates with the same email return 500 [RUNTIME]

Validation checks uniqueness with a `SELECT` and then inserts, which is a read-then-write race. The
database unique index is the real guard, and its violation is not handled.

**Observed** — three concurrent creates, one email:

```
  create 1: 500 {"statusCode":500,"message":"Internal server error"}
  create 2: 500 {"statusCode":500,"message":"Internal server error"}
  create 3: 201 {...}
  rows now holding that email: 1
```

The data stays correct — one row — but two callers get an unhandled server error instead of "The
email has already been taken." Two administrators onboarding the same new starter, or one double
-clicking Save, produce a 500 and a support ticket.

**Fix:** catch `P2002` around the create and translate it to the same 422 the pre-check produces,
exactly as `leads.service.ts` already does. **Estimate: 2 h**

### U-H4 — Hard delete leaves dangling user ids in 42 of 47 columns [DB]

`users` has **no `deleted_at`** — deletion is permanent — and almost nothing references it by a
foreign key. Measured against the schema:

```
FKs pointing at users: 5
   notification_preferences.user_id -> ON DELETE CASCADE
   push_subscriptions.user_id       -> ON DELETE CASCADE
   transaction_message_reads.user_id-> ON DELETE CASCADE
   user_modules.user_id             -> ON DELETE CASCADE
   user_permissions.user_id         -> ON DELETE CASCADE
columns that hold a user id: 47
```

The other 42 include `leads.owner_user_id`, `leads.assigned_to`, `calendar_events.user_id`,
`lead_tasks.assigned_to`, `campaigns.created_by`, `invoices.created_by`, `mail_accounts.user_id`,
`google_connections.user_id`, `meta_connections.user_id` and `audit_logs.user_id`.

**Consequences.** A deleted user's calendar becomes unreachable by anybody (the calendar is private
to its owner, per B-A3, and its owner no longer exists). Their leads are owned by an id that resolves
to nobody. Their mail and Google connections are orphaned rows. Audit entries lose attribution.

Two mitigations already exist and are worth crediting: deletion is refused while the person holds
personal Meta leads, and deactivating first returns their brokerage leads to the pool. Neither covers
calendar, invoices, campaigns or integrations.

**Fix:** prefer deactivation and make deletion the exception — or add `ON DELETE SET NULL` to the
columns that can lose an owner and refuse deletion where they cannot. **Estimate: 8 h**, plus a
migration reviewed against production data.

### U-H5 — Email uniqueness is case-sensitive [RUNTIME]

```
  same email UPPERCASE -> 201
```

`emailTaken` compares exactly, and the database index is case-sensitive too, so
`priya@brokerage.ca` and `PRIYA@BROKERAGE.CA` are two accounts. Mail systems treat them as one
person. Which account a password-reset or a notification reaches becomes ambiguous, and the sign-in
form will authenticate whichever row matches the typed case.

**Fix:** store and compare the address case-insensitively — a `lower(email)` unique index, matching
the pattern already used for lead emails. **Estimate: 3 h** including a collision check before the
migration.

---

## MEDIUM

| ID | Finding | Evidence |
|---|---|---|
| **U-M1** | **No trimming** of name, username or email. `"  Spaced  "` is accepted and stored, so ` Name ` and `Name` are distinct — bypassing the name-uniqueness rule that U-C1 shows is load-bearing for commission joins. | `leading/trailing spaces in name -> 201` |
| **U-M2** | **`profile` is unbounded.** A 500 kB profile was accepted, and because the users list embeds every profile, one account inflated the whole list from 4.3 kB to **493 kB** for every administrator request. | `create with a 500 kB profile -> 201`; `users list is now 493.1 kB` |
| **U-M3** | **`GET /api/users` is unpaginated** and ignores `page`/`limit`. 546 bytes per user today — ~0.42 MB at 800 agents, before U-M2 amplification. | `pagination params honoured? NO` |
| **U-M4** | **No maximum password length.** A 10,000-character password is accepted; bcrypt uses only the first 72 bytes, so the stored strength is far less than the user believes. | `10k-char password -> 201` |
| **U-M5** | **Changing a password does not end existing sessions.** Resetting a compromised account's password leaves the attacker's session live until it expires. | no session invalidation in `users.service.ts` or `auth.service.ts` |
| **U-M6** | **No length validation on department/designation** (columns are `VarChar(120)`). Latent today only because U-H1 discards them; fixing U-H1 without this turns 121 characters into a 500. | `121-char department -> 201` |
| **U-M7** | **Mobile Number and Gender are required by the client only.** The API accepts a user without either, so anything not going through the form creates incomplete records. | form marks both `*`; all API probes omitted them and returned 201 |
| **U-M8** | **Validation errors are reported off-screen.** Submitting the empty form scrolls to Screen Permissions at the bottom and shows a toast — "Name and email are required" — while those fields are at the top, out of view, with no field-level highlighting. | screenshot `users-empty-submit.png` |
| **U-M9** | **Duplicate error toasts.** The user list fetch fires twice, producing two identical "Could not load users" toasts. | screenshot `users-granted-manager.png` |

---

## LOW

*All four closed on 2026-08-03 — U-L1, U-L3 and U-L4 fixed; U-L2 investigated and deliberately not
changed. See **The LOW band — 2026-08-03**. The findings are left as written below, because the
record of what was found is the point.*

| ID | Finding |
|---|---|
| **U-L1** | Photo upload validates the **extension only**, never the content — `evil.png` containing `<script>alert(1)</script>` is accepted (200) and stored. Not exploitable here: helmet sets `nosniff`, the file is served as `image/png`, and the stored name is randomised. Worth a magic-byte check regardless. |
| **U-L2** | `email` and `username` are unique **globally**, not per `company_id`, while every other table carries a tenant. Harmless while one person belongs to one brokerage; inconsistent with the tenancy model if that changes. |
| **U-L3** | The last-administrator guard counts `role: 'admin'` literally rather than asking the authorization engine what the top tier is — the same second-source-of-truth mistake `AdminGuard`'s own comment warns against. |
| **U-L4** | `isEmail` is a loose regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`). Documented as deliberate, and noted here only for completeness. |

---

## What is genuinely well built

Stated because an audit that lists only faults misrepresents the module.

- **Session invalidation is immediate and correct.** `loadUser` re-reads the user on every request
  and returns null when the row is missing *or* `Inactive`. Measured on a live session: `200` before
  deactivation, `401` immediately after. Most systems get this wrong.
- **Mass assignment is blocked.** `id`, `is_admin`, `company_id`, `remember_token` and
  `email_verified_at` in the body are all ignored — the validated-subset pattern does its job.
- **CSRF is enforced** — 419 without a token.
- **Injection.** SQL metacharacters and `<img src=x onerror=…>` are stored literally through
  parameterised queries and escaped by React on render.
- **Photo upload** allowlists extensions, caps at 4 MB inside a 12 MB body limit, regenerates the
  filename randomly, and guards the read path against traversal. `../../evil.png` landed at
  `avatars/1/photo-<random>.png`.
- **File hygiene is correct.** I suspected leaked avatars and measured it: four uploads leave exactly
  one file. The extra files I first saw were pre-existing state, not a leak.
- **Role isolation** holds through the UI and the API for both agent and manager.
- **Self-deletion is refused**, and create, update and delete are all written to the audit trail.

---

## Runtime coverage

| Area | Cases | Result |
|---|---|---|
| Field validation | 21 | 15 correctly refused, 6 accepted that should not be |
| Uniqueness | 6 | 3 correct, 3 findings (case, spaces, inactive namesake) |
| Role reachability (UI + API) | 3 roles | isolation correct |
| Privilege escalation | 6 | all refused |
| Mass assignment | 5 keys | all ignored |
| Photo upload | 7 | allowlist correct; no content check |
| Malformed / abuse | 6 | correct codes |
| Concurrency | 3 parallel | 2 × 500 — finding |
| Session / deactivation | 1 | correct |
| Performance projection | 4 sizes | unpaginated |

Screenshots: `users-agent.png`, `users-admin.png`, `users-superAdmin.png`, `users-add-form.png`,
`users-empty-submit.png`, `users-granted-manager.png`.

**Not covered:** SMTP delivery of the onboarding email and contract agreement (needs a live mail
account); PDF rendering of the contract; behaviour under a genuine database restart; and load beyond
a projection — the largest user table available held 8 rows.

---

## Priority order

1. **U-C1** — namesake commission resolution. Money, silent, reachable by normal use.
2. **U-H3** — 500 on concurrent create. Cheap, and it is a visible failure today.
3. **U-H1** — department/designation discarded. Cheap, unblocks department-based routing.
4. **U-H2** — the permission that does nothing. Decide which side is authoritative.
5. **U-H5** — case-sensitive email. Do before real accounts accumulate.
6. **U-M1** — trimming. One line, and it feeds U-C1.
7. **U-M2 / U-M3** — bound `profile`, paginate the list. Before the agent count grows.
8. **U-H4** — deletion strategy. Largest piece; needs a decision before a migration.
9. **U-M4 … U-M9**, then LOW.

**Estimated fix time: 5–6 days** for CRITICAL through HIGH excluding U-H4, plus **1–2 days** for the
MEDIUM band. U-H4 is a further 1–2 days and should not be rushed.

---

## Recommendations

1. **Stop resolving people by name.** U-C1 is one symptom; `dashboard.service.ts` documents another
   with two active "Akhil" accounts. Names are user-editable, non-unique across time, and currently a
   join key for commission splits, team members and mail routing. Every fix here is a workaround
   until identity is an id.
2. **Make the permission grid honest.** Either every module honours it or the ones that do not say
   so on screen. Silent no-ops in an access-control UI are how a brokerage believes it has delegated
   something it has not.
3. **Prefer deactivation to deletion** and say so in the UI. The departure flow built on 2026-08-02
   already handles deactivation properly; deletion is the path with 42 unconstrained references.
4. **Add a validation ceiling to anything free-form** — `profile` especially, since it is embedded in
   a list endpoint and one record degrades the screen for every administrator.
5. **Add a regression test that the screen-permission grid and the route guards agree**, in the same
   spirit as `rate-limits.spec.ts` guarding the throttler configuration.

---

## MODULE STATUS

### NOT PRODUCTION READY — *as assessed on 2026-08-02*

> **Superseded.** Every finding below has since been closed. The module's current status is
> **PRODUCTION READY, subject to one action that is not mine to take**: running
> `migration-preflight.cjs` against production and applying the two 2026-08-03 migrations. The
> original assessment is kept unedited, because an audit that rewrites its own verdict is not a
> record of anything.

**Justification.** The module's security perimeter would pass — I could not escalate, forge, inject
or mass-assign my way through it, and session handling is better than most. That is not what blocks
it.

It is blocked because the module is **quietly wrong in ways its users cannot see**. A commission
percentage resolved from a departed colleague's record produces incorrect pay with no error, no
warning and no screen showing a discrepancy — and the only way anyone finds out is a dispute. Two
form fields accept input, report success and save nothing. A permission grant is accepted, displayed
as granted, and does nothing. A double-clicked Save returns a 500.

For a brokerage with hundreds of agents, where names repeat and staff turn over, U-C1 is not a tail
risk — it is what happens the first time a common name is reused. **U-C1, U-H1, U-H2 and U-H3 must
be fixed before go-live.** U-H4 and U-H5 need a decision and a migration, and should be scheduled
rather than rushed; both get worse the longer real data accumulates.

---

## Remediation — 2026-08-02

Fifteen findings closed: one CRITICAL, five HIGH, nine MEDIUM. Each was re-run against the running
application afterwards, with the before-and-after quoted.

### The runtime re-verification, in full

```
U-H1 department stored : "Sales"  designation: "Broker of Record"
U-M1 name trimmed      : "Padded 1785724614166-40584"
U-H5 UPPERCASE email   : 422 (was 201)
U-C1 reuse inactive name: 422 (was 201)
U-M4 10k password      : 422 (was 201)
U-M2 500kB profile     : 422 (was 201)
U-M6 121-char dept     : 422 (was 201)
U-M7 no mobile/gender  : 422 (was 201)
U-M3 list=11, limit=2 -> 2 (was ignored)
U-H3 concurrent creates: 201, 422, 422 (was 201, 500, 500)
U-H4 delete clean user : 200 (expected 200)
U-H2 with Users:edit   -> nav=hidden, "No access"=yes, Add User=hidden
     (was: nav shown, no notice, Add User enabled, every call 403)
```

### What changed

| ID | Change | Verified |
|---|---|---|
| **U-C1** | `nameTaken` no longer ignores deactivated accounts — a name stays reserved while the row exists, because it is a join key for as long as any historical record uses it. The comment justifying the old rule claimed nothing resolves splits to an inactive account; `dashboard.service.ts` does exactly that, which is what made the finding. | reusing a deactivated namesake now 422; the active case still refused |
| **U-H1 / U-M6** | `department` and `designation` added to the validated subset — they were absent, so `store` always wrote null and `update` always kept the old value. Given rules at the same time (`max:120`), because carrying them through without one would have turned a silent loss into a 500 at 121 characters. | stored on create and changed on update; 121 chars refused |
| **U-H2** | The route, the nav item and the permission grid now all say what the API enforces. `/api/users` is guarded by `AdminGuard` and never consulted the `users` screen permission, so granting it produced a page that rendered with an enabled "+ Add User" and answered 403 to everything. The grid row is kept but disabled and labelled, because it still governs Settings → Roles & Permissions, which does honour it. | with `Users: edit` a manager now sees no nav item and a "No access" notice |
| **U-H3** | `P2002` from the unique indexes is translated into the validation error the pre-check would have produced. A `SELECT` before an `INSERT` cannot be atomic, so the index is the real guarantee and this reports what it decided. | three concurrent creates: `201, 422, 422` |
| **U-H4** | Deletion is refused while anything would be left pointing at the removed id — calendar, leads, tasks, mailbox, Google connection, invoices, campaigns and email templates — and points at deactivation instead. Chosen over adding cascades to 42 columns, which is a migration that destroys history if one rule is wrong. Deleting an account that never did anything still works, which is the case it is useful for. **Campaigns and templates were added on 2026-08-03**; the first version skipped them on a false premise (see Follow-up). | refused with a calendar appointment, a campaign and a template; allowed for a clean account and for a shipped template |
| **U-H5** | Email and username compare case-insensitively, backed by two functional unique indexes (`users_email_lower_key`, `users_username_lower_key`) added by a **guarded** migration that refuses to run if a database already holds case-variant duplicates, naming the query to list them. | uppercase duplicate now 422; a spec asserts both indexes exist |
| **U-M1** | Name, username, email, department and designation are trimmed before anything reads them — `" David Chen "` and `"David Chen"` were different strings, so the uniqueness rule could be walked past with a space. | padded name stored trimmed, and the padded form now collides |
| **U-M2** | `profile` is capped at 64 kB. It is embedded in the users list, so one 500 kB blob took that list from 4.3 kB to 493 kB for every administrator. | 500 kB profile refused |
| **U-M3** | `page`/`limit` are honoured. They were accepted and ignored, so a caller could believe it was paging. The response stays an **array** deliberately: the screen hands a row straight to the editor, and a feed that silently changes shape under a client is the failure that blanked the CRM dashboard earlier the same day. | `limit=2` returns 2 |
| **U-M4** | Passwords are capped at 72 bytes, which is all bcrypt uses. Accepting 10,000 characters and silently ignoring 9,928 of them overstated the protection to the person choosing it. | 10k password refused with a message saying why |
| **U-M5** | Changing a password deletes that account's stored sessions. Previously a reset only affected the next sign-in, so whoever was already inside stayed inside — at the one moment a reset exists for. Best-effort: a failure is logged rather than thrown, so a password that has been changed stays changed. | both of one user's sessions removed, a colleague's untouched |
| **U-M7** | Mobile and gender are required by the API on create, not only by the form, so an API client or import can no longer produce a record the screen would refuse to save. Create only — an existing account predating the rule stays editable. | create without them refused; update without them allowed |
| **U-M8** | A failed save now scrolls to the offending field, focuses it and outlines it. The toast alone named Name and Email while the view sat at the Screen Permissions grid at the bottom — an error about fields the user could not see. | field-level `data-field` targeting with `.field-bad` |
| **U-M9** | The failure toast fires once. React's double mount effect produced two identical "Could not load users" messages; the guard is on the failure, not the fetch, so a later reload can still report a new problem. | |

### Sensitivity

Reverting four of the fixes fails five of the tests:

```
× refuses a name already held by a DEACTIVATED account
× stores a trimmed name, so a space cannot smuggle a duplicate past the rule
× trims the email too
× actually stores them            (department)
× changes them on update          (designation)
```

Reverting the case-insensitive comparison does **not** fail its test — because the functional index
still enforces it and the P2002 translation reports it as the same validation error. That is defence
in depth working, and worth stating rather than hiding: the guarantee holds even if the service
check is bypassed.

### Verification

- **21 new tests** in `users-validation.spec.ts`, one per finding, written as the failure rather than
  the feature.
- Server suite **690 passed**, 1 pre-existing unrelated failure (`reminder-sweep.spec.ts`).
- Typecheck and build clean, server and client.
- One migration: `20260803000000_users_ci_unique`, additive and guarded, applied to development and
  test.

### Revised score

**52 → 88.** No CRITICAL, HIGH or MEDIUM findings remain open.

The gap to a higher score is the LOW band. The structural half of U-C1 — people resolved by name
rather than by id — was left open at the time of writing and has since been closed; see
**Follow-up — 2026-08-03** below.

### Still open

*Nothing. All four were closed on 2026-08-03 — three fixed, one decided against. See **The LOW
band** below.*

---

## Follow-up — 2026-08-03

The three items left open by the remediation. Two are done; the third is diagnosed but not fixed,
and this says so plainly rather than closing it.

### 1. People are identified by id, not by the name they happen to have (HIGH — done)

U-C1 was prevented at the point of entry on 2026-08-02: the Users screen refuses to create a second
account with an existing name. That stops new occurrences and does nothing for the design underneath
— every commission split, agent email and review notice still resolved a person with
`users.findFirst({ where: { name } })`, which is ambiguous by construction and, without an
`orderBy`, decided by the query planner.

**What changed.**

| | |
|---|---|
| **Migration** | `20260803010000_person_user_ids` adds `transactions.agent_user_id` and `team_members.user_id`, nullable, with indexes. Additive: nothing is dropped or renamed, and the name columns keep their values because they are still what the screens display. |
| **Backfill** | Only where a name resolves to **exactly one** user. A name matching two accounts is precisely the case that made this necessary, so guessing there would bake the wrong answer into a column that is then trusted. Those rows stay NULL and keep the name fallback; the migration prints how many. |
| **`PersonResolver`** | One place that answers "which user does this record mean": the id when the row has one, the name when it does not. Seven call sites each had their own slightly different lookup. |
| **Name fallback** | Kept deliberately, and made **deterministic**: an Active row wins, ties break on the lowest id. It cannot be made *correct* — the question is ambiguous — but it can stop changing after a VACUUM or a restore. |
| **Write path** | New transactions and team members record the id beside the name, so the fallback is only ever exercised by rows that predate this. |
| **Campaigns** | No new columns needed. `campaigns.created_by_id` and `campaign_templates.user_id` already exist and are already written by the campaigns service — attribution there is id-based today, and only the varchar name beside them is legacy display data. I added redundant columns before checking, then removed them. **This also corrected a real gap:** the U-H4 deletion guard had skipped campaigns entirely, on the stated grounds that `created_by` is a name with no id to match — so it answered "nothing would be stranded" while a person's campaigns and templates would have been. Both are now checked, with the wrinkle that a template whose `user_id` is NULL is one of the six shipped with the application and belongs to nobody. |

**Verified.** `person-resolver.spec.ts`, 8 tests, including the exact U-C1 scenario at the commission
layer: a deactivated namesake on 10% and the new hire on 90% now produce an agent line of **90%**.
Disabling the id preference fails two of them.

`dashboard-parity.spec.ts` — which asserts commission totals to the cent, with **no tolerance**, and
which caught a $21,865.50 error when this endpoint was last optimised — passes unchanged, including
its own duplicated-name scenario. That is the gate that matters: it proves the cached and uncached
paths still agree exactly.

One honest note: the U-C1 test passes even with the id preference disabled, because the deterministic
name fallback prefers the Active row and reaches the same answer. Both mechanisms fix it
independently, which is the intent, but it means that single test does not isolate the id.

**A stale comment was corrected, not left.** `dashboard.service.ts` carried a long note explaining
why the profile cache *deliberately did not batch* — because `findFirst` had no defined order and
the cache had to match it query-for-query. `PersonResolver` removes that constraint by making the
rule explicit, so it now batches, and the comment says why that became safe.

### 1b. A correction to the U-H4 deletion guard

While checking whether campaigns needed a user id, I found the guard I had written on 2026-08-02 was
wrong — and wrong in the way that is hardest to notice, because a comment explained why it was right.

It skipped campaigns entirely, stating that `campaigns.created_by` is a `varchar` holding a name with
no id to match against. `campaigns.created_by_id` sits beside it and is written by the campaigns
service on every create. So the guard reported "nothing would be stranded" while a person's campaigns
would have been — the exact failure it exists to prevent, with a justification that made the gap look
deliberate.

Both `campaigns.created_by_id` and `campaign_templates.user_id` are checked now. One wrinkle: a
template with a NULL `user_id` is one of the six the application ships with, belonging to everybody
rather than to nobody, so only rows naming the user count.

Three tests cover it, and removing the check fails two of them.

**The lesson is about the comment, not the query.** A wrong claim stated confidently in prose is
harder to catch in review than a missing line of code, because it answers the question a reviewer was
about to ask.

### 2. Production verification of `users_ci_unique` (HIGH — prepared, not applied)

**I have not touched production and cannot: no production connection is configured in this
repository.** What exists instead is the tooling to make the deploy a decision rather than a
surprise.

`scripts/migration-preflight.cjs` — read-only, safe against production:

```
DATABASE_URL=postgresql://user:pass@host:5432/myapp node scripts/migration-preflight.cjs
```

It reports, for both 2026-08-03 migrations: addresses and usernames differing only by capitalisation
(**blocking** — exit 2), agent names matching more than one account or none (proceeds, but those
rows keep the name fallback), and users sharing a name. Clean database → exit 0.

**Both the pre-flight and the migration's own guard were proven, not assumed.** On the test database
I seeded `CaseProbe@audit.test` alongside `caseprobe@audit.test`; the pre-flight reported
`BLOCKING … 1 email(s) differ only by capitalisation` and exited 2, and `prisma migrate deploy`
refused with `P0001` rather than applying anything. The probe rows were removed and the database
restored.

Running the pre-flight against production is the outstanding action, and it is yours to take.

### 3. The `reminder-sweep` failure (MEDIUM — closed by removing the class, not by finding the cause)

The trigger was never identified. Three candidates were each tested and ruled out:

- **A midnight boundary.** The assertion is a day countdown, so this was the obvious suspect. Pinning the test's `today` to 23:59:59.900 — it passes.
- **DST.** `daysBetween` normalises both ends to `startOfDay` and rounds, so an hour of drift inside the span cannot move the answer.
- **Agent-name ambiguity.** The sweep does resolve an agent by name (`addressFor`), and this database had accumulated duplicate probe accounts, which made it a plausible mechanism — but the spec's agent names are timestamped and unique, and the failing assertion is on the countdown rather than the address.

**What was done instead.** The spec derived "today" from `new Date()`, which made
`expect(rows.map(r => r.days_remaining)).toEqual([5, 4])` a function of when the suite happened to
run. `reminder-sweep.spec.ts` now reasons from a fixed anchor — midday on a Tuesday in mid-June,
far from any month end and from both DST transitions. `sweep()` already took the date as a
parameter, so nothing about the product is faked; only the question the test asks is pinned.

That removes the whole class rather than the one instance: month ends, DST, the date rolling over
mid-run, and a CI box in another timezone all stop mattering. Being honest about the limit of this —
**it closes the flake, not the mystery.** If a countdown bug exists in `sweep()` itself, a pinned
clock is exactly what would hide it. What argues against that is the same 17 assertions passing at
23:59:59.900, at midday, and across the date roll from 2026-08-02 to 2026-08-03.

### Verification

- Server suite **699 passed**, 57 suites, **no failures at all** — the first fully green run of this
  session.
- Browser suite **148 / 148**.
- Typecheck and build clean, server and client.
- New: `person-resolver.spec.ts` (8), `scripts/migration-preflight.cjs`.
- Migrations applied to development and test; production pending your pre-flight.

---

## The LOW band — 2026-08-03

The four remaining findings. Three are fixed; the fourth was investigated and deliberately left
alone, which is a decision rather than an omission and is recorded as one.

### U-L1 — an avatar has to be an image, not merely be named like one

The extension was the only check, so `evil.png` containing `<script>alert(1)</script>` was accepted
with a 200 and written to disk — confirmed at runtime during the audit.

`sniffImage()` in `user-photo.service.ts` now reads the magic bytes and rejects anything that is not
PNG, JPEG, GIF or WEBP, and rejects a genuine image whose extension names a different format. Two
details that are not incidental:

- **It runs after the size cap**, so a 200 MB non-image is refused for being oversized rather than
  buffered and sniffed.
- **It runs before `userOr404` and before any write**, so nothing that is not an image reaches disk,
  and the check cannot be skipped by naming a user who does not exist.

`.jpg` and `.jpeg` compare equal, because the comparison is on the resolved mime rather than on the
extension string — otherwise every `.jpeg` upload would be rejected for "not matching".

**Restating what this was not.** It was not exploitable: helmet sets `nosniff`, the file is served as
`image/png`, and the stored name is randomised. The reason to fix it anyway is that "not exploitable
through the paths we happen to have today" is a weaker guarantee than "it is an image", and the
second one costs four signature checks.

### U-L2 — global uniqueness is a requirement, not an oversight (investigated, deliberately unchanged)

The finding proposed making `email` and `username` unique per `company_id`, for consistency with the
rest of the tenancy model. **I did not make that change, and it should not be made.**

`findAuthenticatable` in `auth.service.ts` looks a person up by `{ username }`, then by `{ email }`,
with no company scope — and it cannot have one. Its own comment says why: *signing in is the moment
the tenant becomes knowable; it cannot already be known here.* A person types an address into a login
form; nothing at that point says which brokerage they belong to.

So per-tenant uniqueness would let two brokerages hold one address, and `findFirst` would return
whichever row the planner reached first. That is U-C1 — the finding this audit opened with, where an
ambiguous lookup paid the wrong agent's commission split — reintroduced at the authentication layer,
where the consequence is signing in as the wrong person.

Global uniqueness is what global login requires. The inconsistency with the other tables is real and
is the correct trade.

### U-L3 — the last-administrator guard asks the authorization engine

The guard counted `role: 'admin'` as a literal string — the second-source-of-truth mistake that
`authz.ts` opens by warning against, having replaced sixteen inline copies of that comparison.

`superAdminRoles()` now derives the top tier from `ROLE_RANK`, and the guard counts
`role: { in: superAdminRoles() }`. `isSuperAdmin` could not serve here: it takes a principal, and
"is this the last one?" is a question about a population.

**A second bug surfaced while fixing the first.** The count had no status filter, so deactivated
administrators counted as cover. A brokerage with one live admin and one dormant one could delete the
live account and be left with nobody able to sign in and administer it — a lockout requiring database
access to undo. The count is now `status: 'Active'`.

### U-L4 — the email rule refuses what is undeliverable and nothing else

`isEmail` was `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. The rewrite is deliberately **not** an RFC 5322 parser
— that grammar admits quoted local parts, comments and bracketed IP domains, and every attempt to
express it as one regular expression is either wrong or unreadable.

Now refused, all undeliverable and all previously accepted: a local part starting or ending with a
dot, doubled dots anywhere, a domain label starting or ending with a hyphen, a one-character TLD
(`a@b.c`) and a numeric one (`user@host.1`). Length limits are enforced at 254 for the address and 64
for the local part.

Still accepted, on purpose: plus-addressing, dotted local parts, apostrophes (`o'brien@…`),
subdomains, long TLDs and punycode IDNs. **This list is the one that matters** — a validation rule
that refuses a real address locks somebody out of their own account, which is a worse failure than
accepting a typo.

### Verification

Every fix was sensitivity-checked by reverting it and confirming the tests fail:

| Fix | Reverted to | Result |
|---|---|---|
| U-L1 | sniff block removed | **7 of 8** photo tests fail |
| U-L3 | `where: { role: 'admin' }` | the live/dormant test fails |
| U-L4 | the original loose regex | **9 refusals** fail; every acceptance still passes |

That last row is the useful one: reverting the email rule fails exactly the addresses that should be
refused and none of the addresses that should be accepted, which is what proves the new rule did not
tighten too far.

One process note, because it produced a false result before it produced a true one: the first revert
was written through a shell `node -e`, which ate the backslashes and turned `[^\s@]` into `[^s@]` — a
regex rejecting every address containing the letter *s*. Three legitimate addresses "failed", which
looked like a passing sensitivity check and was not one. The revert was redone from a script file and
re-run.

- New spec: `user-photo.spec.ts`, 12 tests. `users-validation.spec.ts` gains 20 (U-L3, U-L4).
- Server suite **736 passed**, 58 suites, no failures. (**739** after the soft-delete correction
  below adds three.)
- Browser suite **148 / 148**.
- Typecheck and build clean, server and client.

---

## A second correction to the U-H4 deletion guard — 2026-08-03

Found while fact-checking the §1b write-up above against the code, rather than by re-reading it.

`orphanRisk()` counts eight tables. **Four of them are soft-deleted** — `calendar_events`, `leads`,
`invoices`, `campaign_templates` — and only the first two filtered `deleted_at`. A row the owner had
already deleted still blocked the account from being removed.

Confirmed by probe, not by inspection: one template created, soft-deleted through the normal path,
then counted both ways.

```
{ guard_counts: 1, live_rows: 0 }
```

**Why this is worse than a spurious refusal.** The administrator is told "cannot delete — 1 email
template" and has no way to clear it. Every read in `campaign-templates.service.ts` filters
`deleted_at: null`, so the row holding the block does not appear on any screen. The guard refuses on
evidence the user cannot see or act on.

Both counts now filter `deleted_at: null`. The comment records which four tables have **no**
`deleted_at` column at all — `lead_tasks`, `mail_accounts`, `google_connections`, `campaigns` — so
their missing filter reads as correct rather than as the same omission repeated, and the next person
to check does not have to re-derive it from the schema.

Three tests: the two "already deleted" cases, plus a live invoice, so the filter cannot pass by
counting nothing at all. Reverting both filters fails exactly the two.

**What this says about the first correction.** §1b ends by observing that a confident explanation
stops a reviewer asking the question it appears to answer. That corrected comment sat directly above
two counts carrying the same class of defect — accurate about the thing it discussed, and drawing
attention away from the lines underneath it. **A correction is not exempt from the failure mode it
describes.** The thing that found this was checking the claim against the schema; re-reading the
prose would not have.

---

### Revised score

**88 → 94.** No findings remain open at any severity.

The six points still withheld are not defects on this list: production application of the two
2026-08-03 migrations is outstanding and is yours to take (§2 above), and the `reminder-sweep` flake
was closed by removing the class rather than by identifying the cause.
