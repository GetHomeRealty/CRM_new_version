# CRM — Full Production Audit, 2026

**Status: IN PROGRESS.** Phase 1 (architecture discovery) is complete and Phase 2 (module-by-module)
has begun. This document is the master register: every finding lands here as it is confirmed, and
the consolidated report is assembled at the end.

**Method.** Runtime testing against the running application (Playwright, real browser, live Postgres)
plus code and schema inspection. Every finding below is marked with how it was established. Nothing
is reported as broken that was not observed to be broken.

---

## Phase 1 — CRM architecture inventory

### Modules

Derived from `SCREEN_AREA` in `client/src/desk/area.ts` and the `SCREENS` table in `App.tsx`, not
from the sidebar — the sidebar turned out to disagree with both (finding CRM-NAV-M01).

| Module | Area | Route | Backing API | Notes |
|---|---|---|---|---|
| Dashboard | both | `/crm` | `/api/dashboard/crm` | CRM and Desk render different components |
| Calendar | both | `/crm/calendar` | `/api/calendar/*` | 14 endpoints |
| **Client Reviews** | crm | `/crm/reviews` | **none** | Declared, navigable, **not built** — CRM-NAV-M01 |
| Inbox | both | `/crm/inbox` | `/api/account/inbox` | CRM-scoped mail accounts only |
| Leads | crm | `/crm/lead` | `/api/leads/*` | **43 endpoints** — the largest surface in the CRM |
| Campaigns | crm | `/crm/campaigns` | `/api/campaigns/*` | + `/api/campaigns/templates` |
| Meta | crm | `/crm/meta` | `/api/meta/*` | Public webhook controller alongside |
| Triggers | both | `/crm/triggers` | `/api/crm-settings/triggers` | Per-user rows since 2026-08-04 |
| Settings | both | `/crm/settings` | `/api/crm-settings/*`, `/api/company-settings` | 3 tabs in the CRM area |
| Audit Trail | both | `/crm/audit` | `/api/audit-logs` | |
| Users | — | `/crm/users` | `/api/users` | Super Admin only |
| Account | open | `/crm/account` | `/api/account/*` | Personal |
| Notification Preferences | open | `/crm/notifications` | `/api/account/notification-preferences` | Personal |

**Not CRM** (Desk area, excluded from this audit): transactions, invoice, reports, analytics,
inventory, mls, favorites, recycle-bin.

### Scale

- **49 backend controllers**, 92 Prisma models.
- **9 background schedulers**, all plain `setInterval`, all gated behind `RUN_SCHEDULERS` so exactly
  one process runs them: event reminders, campaign resume, IMAP sync, mail retention, Meta sync,
  export jobs, lawyer reminders, transaction reminders, review SLA.
- **6 roles**: admin (Super Admin), manager (Admin), agent, accounting, documentation, crm.

### Roles and default permissions

From `permission.service.ts` `compiledDefaults`:

| Role | settings | users | audit | lead | transactions | invoice |
|---|---|---|---|---|---|---|
| admin | edit | edit | edit | edit | edit | edit |
| manager | **view** | none | view | edit | edit | edit |
| accounting | none | none | **view** | view | edit | edit |
| documentation | none | none | none | view | edit | none |
| crm | none | none | none | **edit** | none | none |
| agent | none | none | none | edit | edit | none |

---

## Phase 2 — findings so far

### CRM-NAV-M01 · "Client Reviews" is navigable and does not exist

- **Module:** Navigation / Client Reviews · **Severity:** Medium · **Type:** Runtime + Code Inspection
- **Problem.** `Client Reviews` appears in the CRM sidebar for **every role**. There is no route in
  `SCREENS`, no controller on the server (`server/src/reviews` does not exist), and no page component.
- **Expected.** A navigation entry leads to a working screen, or is not offered.
- **Actual.** The route falls through to the "not built yet" stub. Measured body length **348–368
  characters** for all three runtime roles — i.e. chrome only, no content.
- **Evidence.** `e2e/audit-shots/crm-full-audit/{agent,admin,superAdmin}-reviews.png`;
  `data/A-screens-*.json`. Sidebar declaration at `DeskLayout.tsx:68`; area declaration at
  `area.ts:61` states plainly *"It has no screen behind it yet — no route, no controller, no page."*
- **Affected roles:** all six.
- **Business impact.** Every agent sees a feature the brokerage does not have. On a go-live day this
  generates support calls and erodes confidence in the rest of the navigation.
- **Recommended fix.** Remove the sidebar entry until the screen exists, or ship a deliberate
  "coming soon" state. **Small.**

### CRM-NAV-M02 · Agents are offered Settings and refused it

- **Module:** Navigation / Settings · **Severity:** Medium · **Type:** Runtime · **Affected roles:** agent
- **Problem.** `Settings` appears in the agent sidebar. Agents hold `settings: none`, so the route
  answers **"No access"**.
- **Evidence.** `A-screens-agent.json` — sidebar text includes `Settings`; the `settings` row has
  `noAccess: true`, body 301 characters. Screenshot `agent-settings.png`.
- **Why this matters beyond tidiness.** This is the same defect class as **T-H1** in the Triggers
  audit, which was fixed there — a screen offered by one authority and refused by another. It was
  fixed for Triggers and remains for Settings, which suggests the navigation and the route table are
  not gated from a single source.
- **Recommended fix.** Gate the sidebar entry on the same predicate the route uses. **Small.**

### CRM-PERM-M03 · Accounting can read the whole audit trail

- **Module:** Audit Trail · **Severity:** Medium · **Type:** Permission (runtime)
- **Measured.** `GET /api/audit-logs` — `superAdmin` 200, `admin` 200, **`accounting` 200**,
  `documentation` 403, `crm` 403, `agent` 403.
- **Why it is a finding rather than a decision already made.** `accounting` holds `users: none` and
  `settings: none`, yet the audit trail records user administration and settings changes. The role
  can therefore read the history of actions it cannot perform and screens it cannot open. The
  asymmetry with `documentation` (403) suggests it was inherited from `fill('view')` rather than
  chosen.
- **Recommended fix.** Decide explicitly, then make the map say so. If accounting needs the
  financial trail only, scope the endpoint by category. **Small to Medium.**

### CRM-PERF-L01 · Every page load requests an avatar that does not exist

- **Module:** Cross-module (shell) · **Severity:** Low · **Type:** Runtime / Performance
- **Measured.** `GET /api/users/{id}/photo` returns **404** on every CRM screen for `agent` and
  `admin` (neither has a photo), producing a console error on **every navigation**. On the Users
  screen as Super Admin, **five** such 404s in one page load.
- **Impact.** Console noise that masks real errors during support, and one wasted round trip per
  navigation per avatar. Not a functional defect — the UI falls back to initials correctly.
- **Recommended fix.** The API already returns `has_photo` on the user payload; request the image
  only when it is true. **Small.**

---

## Positive findings — verified, not assumed

These matter for deciding where remediation effort goes.

- **Every CRM screen renders for every runtime role.** 13 screens × 3 roles = 39 navigations, **zero
  `pageerror`s**, **zero** error-boundary appearances. Given that a production Dashboard crash was
  the reason this audit was commissioned, this is the single most important negative result in it —
  the current source does not reproduce it (see *Deployment drift* below).
- **CRM Settings is correctly closed.** `crm-settings`, `email-settings`, `email-log` and
  `broadcasts` all answer **403** to agent, accounting, documentation and crm.
- **Users and Roles are Super Admin only.** 403 for every other role including Admin.
- **Lead Books is Super Admin only.** 403 for Admin and below, matching the scoped change made
  earlier.
- **Auth rate limiting is real and reasoned.** My own sweep tripped it — 120 sign-ins per 5 minutes
  per IP. The sizing is documented against the "200-agent office at 9 a.m." case, with per-account
  lockout (8 failures / 15 min) as the actual brute-force defence. Recorded as informational, not a
  finding.

---

## Deployment drift — carried forward, confirmed

Established earlier and unchanged: **production runs a frontend bundle older than its backend.**

- Production serves `CrmDashboardPage-BMFC37ie.js`; current source builds `CrmDashboardPage-iaetgRbl.js`.
- The deployed bundle calls `tasks.filter(...)` on what is now `{ data, meta, summary }` —
  `l.filter is not a function`, which is the crash reported from production.
- Current source has **zero** `.filter(` calls in that chunk and passes all three roles locally.
- Production is also **15 migrations behind**.

**This is the single largest production risk in the CRM and it is not a code defect** — the code is
correct on both sides of the split. It is a deployment-ordering problem, and deploying the backend
without the frontend is what causes it.

---

## Still to audit

Phase 2 continues through: Dashboard, Calendar, Inbox, Leads (43 endpoints — the largest),
Campaigns, Meta, Audit Trail, and re-verification of the Settings and Triggers findings closed
earlier this week. Field validation, workflow interruption, concurrency, N+1 and large-dataset
behaviour are pending per module.

No module has yet been given a score, and **no production decision has been reached.** Both come
after every module is audited.

---

## Correction to Phase 1 — CRM-NAV-M02 WITHDRAWN

**I reported that agents are offered Settings and refused it. That was wrong.**

The agent's sidebar "Settings" is `{ key: 'account', label: 'Settings', agentOnly: true }` — their own
account page. Clicked as an agent it lands on `/crm/account` and renders (`noAccess: false`). My
sweep reached `/crm/settings` by typing the URL, and "No access" is the correct answer to that.

Company Settings and Roles & Permissions are children of the `settings` nav group, filtered on
`can('settings','view')`. Agents hold `settings: 'none'`, so neither has ever rendered for them.

The lesson is the same one this audit keeps producing: **navigating by URL is not navigating**, and a
finding about what a user is "offered" has to be established by using the interface.

### Phase 1 findings — final state

| ID | Finding | Outcome |
|---|---|---|
| CRM-NAV-M01 | Client Reviews navigable, does not exist | **Deferred by the owner** — to be built later |
| CRM-NAV-M02 | Agents offered Settings | **WITHDRAWN — not a defect** |
| CRM-PERM-M03 | Accounting could read the whole Audit Trail | **FIXED** — migration `20260805090000_accounting_no_audit` |
| CRM-PERF-L01 | Avatar 404 repeated on every mount | **FIXED** — measured 21 repeats → 0 |

**CRM-PERM-M03 needed a migration, not just code.** `roleDefaults` reads stored `role_permissions`
first and only falls back to the compiled map, so the code change alone would have changed nothing at
runtime. The parity spec in `core/role-permission.spec.ts` caught it.

**CRM-PERF-L01's first regression test was worthless** and was caught by reverting the fix: it walked
four screens and passed either way, because the shell's single avatar never unmounts during in-app
navigation. The repetition is in LISTS that unmount and remount. Re-measured on the Users screen over
three round-trips: **21 repeat requests without the memo, 0 with it.**

---

# CRM › LEADS AUDIT

**Score: 92 / 100.** The largest surface in the CRM — 43 endpoints — and the best-defended one
examined so far.

## Runtime testing completed

Ownership isolation and IDOR across two agents; field validation (13 cases) on create; duplicate
prevention; soft delete, restore and double-delete; pagination, sorting, search and unbounded limits
(10 probes); the role matrix across five roles on six operations; export scope versus list scope
across five roles. All against the running application with a live database. Every probe record is in
`e2e/audit-shots/crm-full-audit/data/L*.json`.

## Findings

### CRM-LEADS-M01 · A lead name accepts and stores raw HTML

- **Severity:** Medium · **Type:** Runtime / Security
- **Measured.** `POST /api/leads` with `name: "<script>alert(1)</script>"` → **201**, stored verbatim.
- **Why Medium and not High.** React escapes it on screen, so there is no XSS in the application.
  What makes it more than cosmetic is that `renderTemplate` — the mail merge — does **no HTML
  escaping** (established in the Settings audit, finding S-M9), and a lead's name is merge data. The
  CRM's own advanced emails call `esc()` on it, so those are safe; the campaign path needs the same
  check before this can be called closed.
- **Recommended fix.** Escape by default in `renderTemplate` (already recommended as S-M9) — one fix
  closes both. **Small**, but needs a test per HTML-bearing variable.

### CRM-LEADS-L02 · Export is available to roles that cannot own a lead

- **Severity:** Low · **Type:** Permission
- **Measured.** `POST /api/leads/export` → **200** for every role including accounting and
  documentation, which hold `lead: view`.
- **Why Low.** The export is correctly **scoped** — this was the thing worth testing, and it holds:

  | Role | List total | Export count | |
  |---|---|---|---|
  | agent | 36 | 36 | match |
  | agent2 | 21 | 21 | match |
  | accounting | 0 | 0 | match |
  | documentation | 3 | 3 | match |
  | superAdmin | 24 | 24 | match |

  No role can extract more than it can already see, so this is a question about whether view-only
  roles should be able to take a file away at all, not a data-exposure defect.
- **Recommended fix.** A decision, not a bug: gate export on `lead: edit` if bulk extraction should
  follow ownership. **Small.**

## What is genuinely well built

Verified, not assumed — and unusually strong:

- **Agent-to-agent isolation is airtight.** Two agents, zero overlap in their lists. Cross-account
  read, write, delete, note and task all return **404 — not 403**, so the API does not even confirm
  the record exists. Nothing was modified by the attempt.
- **Validation is thorough.** Empty name 422, 500-character name 422, malformed email 422,
  400-character email 422, null name 422, empty body 422. Names are **trimmed** (`"   X   "` stored
  as `"X"`). Emoji and non-Latin names are accepted, which is correct — real clients have them.
- **Duplicate prevention is case-insensitive and helpful.** A second lead on the same address is
  refused 422 naming the existing record: *"ZZAUDIT Dupe One already uses that email address (lead
  #42993)."* An address differing only in capitalisation is refused too.
- **Mass assignment is closed.** `company_id: 99` posted in the body was ignored — the row was written
  with `company_id: 1`.
- **Soft delete is complete and idempotent.** Delete 200 → read 404 → appears in the deleted list →
  second delete 404 rather than an error → restore 200 → read 200.
- **Pagination is properly bounded.** `limit=99999999` capped at **200**; `limit=-1` clamped to 1;
  `limit=abc` fell back to 50; `page=-5` clamped to 1; `page=99999` returned an empty page with
  correct metadata. No unbounded query is reachable.
- **Search is parameterised and effective.** A SQL-injection string returns **0 rows** (matched as a
  literal, not executed); a real term returns exactly its matches. Every probe answered in under
  100 ms.
- **The role matrix is correct.** `books` and `transfer-ownership` are Super Admin only (403 for
  everyone else including Admin); `bulk-delete` is 403 for view-only roles and 400 for an empty
  selection.

## Two probe errors worth recording

Both produced confident-looking results that were wrong, and both were caught by checking rather than
by reading the output:

1. **13 validation cases all returned 422** — because a lead requires `name` AND `email` and my probe
   sent only `name`. Every "failure" was the missing email. Re-run with complete bodies, only 6 of 13
   are genuine refusals.
2. **Search appeared not to filter** — every term returned the full list. The parameter is `search`,
   not `q`; the server was correctly ignoring an unknown parameter.

A third near-miss: `budget: -5000` and `budget: 999999999999999` both returned 201, which looked like
missing numeric validation. The database showed `budget = null` for both — the field does not exist on
this model and was whitelisted out. Not a finding.

## MODULE STATUS — Production Ready With Minor Issues

No Critical, no High. The two findings are a shared escaping issue already tracked as S-M9, and a
permission question that is a decision rather than a defect. Isolation, validation, deletion,
pagination and search are all demonstrably sound under adversarial input.

---

## Still to audit

Campaigns, Inbox, Meta, Calendar, Dashboard, Audit Trail. No consolidated score or production
decision until those are done.

---

## Remediation — 2026-08-05

Two findings fixed on the owner's instruction, both sensitivity-checked.

### CRM-LEADS-M01 / S-M9 · merge values are now HTML-escaped

`renderTemplate` escapes every value by default. The opt-out list is **enumerated, not guessed** —
four variables carry real markup, and what builds each is named in the code:

| Variable | Built by |
|---|---|
| `logo_img` | `logoImg()` — an `<img>` tag |
| `documents_table` | `outcomeTable()` — a `<tr>` per document |
| `pending_docs` | `documents.service.ts` — a `<ul>` |
| `transaction_button` | `reminder-sweep.service.ts` — a styled `<a>` |

Demonstrated: `Smith & Jones Realty` → `Smith &amp; Jones Realty`; `<img src=x onerror=…>` →
`&lt;img …&gt;`; the four markup variables pass through untouched. The case that was already
shipping is the company email `info@GetHomeRealty.ca & Commissionpayouts@…`, whose bare `&` was
being emitted as an unterminated entity on every send.

14 tests, including a guard that the allow-list is **exactly** those four — so growing it must be a
deliberate change rather than a side effect of fixing a rendering complaint. Reverting the escape
fails 8 of 14.

### CRM-LEADS-L02 · view-only Leads access can no longer export

`POST /api/leads/export` moved from `@Screen('lead','view')` to `'edit'`. `accounting` and
`documentation` lose it and keep the list; agent, crm, manager and admin keep it. Both directions are
tested. Reverting the gate fails exactly the two refusal tests.

Not a data fix — the rows were always correctly scoped. It says a role trusted only to look is not
thereby trusted to extract.

### Three verification failures of my own

Each made a fix look verified when nothing had been tested, and all three were caught rather than
shipped:

1. **A revert script silently no-op'd.** `String.replace` does not error on a missed pattern, so the
   controller was never reverted and the "sensitivity check" passed meaninglessly.
2. **An `&&` chain short-circuited** on a failing jest run, so `npm run build` never executed and the
   reverted code was never compiled.
3. **Playwright reused the running server**, so even once built, the old process was still serving.

Redone with an explicit edit, rebuild and restart.

---

# CRM › CAMPAIGNS AUDIT — PARTIAL

**Not scored.** Enough was established to be useful, and one planned area was not established at all.
Recording both honestly rather than presenting a partial pass as a module report.

## What was established

### Audience scoping is correct — the question that mattered most

A campaign audience respects lead ownership exactly. Measured by comparing each agent's audience
against the leads they own:

| | Owns leads | Audience count | Sample rows not owned by them |
|---|---|---|---|
| agent | 36 | **36** | none |
| agent2 | 21 | **21** | none |

**Sample overlap between the two agents: zero.** No agent can campaign to another agent's clients —
which is a consent question under CASL as much as a data one, and it holds.

An earlier probe reported 21 for both and looked like a shared audience. That was a bug in my own
extraction helper, superseded by the direct ownership comparison above.

### The unauthenticated perimeter is right

Tracking has to be reachable by mail clients, and is — without leaking or accepting anything:

```
open pixel, bogus token   404
click, bogus token        404
unsubscribe, bogus token  404
campaign list             401
suppressions              401
```

A bogus token returns 404 rather than an error revealing whether the campaign exists.

### The role matrix, with one open question

| Role | list | suppressions | create / test-send |
|---|---|---|---|
| agent | 200 | 200 | allowed |
| **crm** | 200 | 200 | **403** |
| accounting | 200 | 200 | 403 |
| documentation | 200 | 200 | 403 |
| admin / superAdmin | 200 | 200 | allowed |

**CRM-CAMP-Q01 (question, not yet a finding).** The `crm` role — the CRM coordinator — cannot create
or send a campaign, while an `agent` can. That may be deliberate, since campaigns send external mail
under the brokerage's name. It is recorded as needing a decision rather than asserted as a defect.

**CRM-CAMP-Q02 (question, not yet a finding).** Every role including `agent` can read the brokerage
suppression list. That list is addresses of people who have unsubscribed — client PII belonging to
whichever agent owns them. The test database holds one row, too few to tell whether the list is
scoped by owner or brokerage-wide. **Needs a seeded multi-owner test before it can be called either
way.**

## What was NOT established

**Field validation on campaign create — CANNOT VERIFY.** All eight probes returned 400, including
cases that should have succeeded, which means the probe omitted a field `POST /api/campaigns`
requires. This is the same mistake made on the Leads probe. The results say nothing about validation
and are not reported as findings.

Also not attempted: send/resume safety, duplicate-send protection, scheduling behaviour,
open/click attribution accuracy, template ownership, large-audience performance.

## MODULE STATUS — Not yet assessable

No Critical or High found in what was covered, and the two highest-risk properties — audience
ownership and the unauthenticated perimeter — are demonstrably sound. That is not the same as a
clean module report, and Campaigns should be re-audited to the depth Leads received.

---

## Audit status

**Complete:** Phase 1 discovery, Leads (92/100), Triggers and Settings (audited and remediated
separately).

**Partial:** Campaigns.

**Not started:** Inbox, Meta, Calendar, Dashboard, Audit Trail.

No consolidated score and no production decision — those require every module.

---

## CRM › CAMPAIGNS — continued, 2026-08-05

### CRM-CAMP-M02 · A crash mid-send can deliver a second copy

- **Severity:** Medium · **Type:** Code inspection (sequence verified, not reproduced)

**The sequence.** In the delivery loop:

```
await this.mailer.sendDirect(...)          // the email leaves
sent++;
await this.markRecipient(row.id, 'sent')   // the status is written AFTER
```

**The scenario.** A recipient's mail is accepted by the SMTP server; the process dies before that
one `UPDATE` lands — a deploy, a restart, an OOM. The row stays `pending`. On boot
`CampaignResumeService.onModuleInit` resumes interrupted campaigns and reloads exactly the rows
still marked `pending`, so that recipient is sent to **again**.

**Why this is a finding and not merely a trade-off.** Every system has to choose between
at-least-once and at-most-once here, and the choice is defensible either way. What makes it a
finding is that **this module states the opposite preference in its own code**:

> *"a second copy in somebody's inbox, which is the one failure this module treats as worse than not
> sending at all"* — the comment on the `delivering` guard.

The guard it defends closes a different hole (two passes racing inside one process). The ordering
chosen for the durable path optimises for the outcome the comment calls the worst one.

**Window and likelihood.** One database write wide. Small per recipient — but a campaign to several
hundred people takes minutes because of the inter-send delay, so a deploy during a send is a
realistic way to hit it, and that is exactly when restarts happen.

**Recommended fix.** Either accept at-least-once and correct the comment so the next reader is not
misled, or move to a claim-then-send order (mark `sending` with a timestamp, send, mark `sent`), which
converts a crash into a *possible miss* that the resume can detect and report rather than a silent
duplicate. Correcting the comment is **Small**; the claim-then-send change is **Medium** and needs
its own tests.

### Verified sound

- **Resume cannot re-send a completed recipient.** A pass loads `status: 'pending'` only, so anyone
  already marked `sent` is never reloaded. The durable guard is per-recipient state, not a counter.
- **Two passes in one process cannot race.** The `delivering` set refuses a second pass over a
  campaign already going out, and the soft-bounce retry sweep runs every minute — which is what made
  that guard necessary.
- **Soft bounces are honoured, not hammered.** A deferred recipient stays `pending` with a
  `next_retry_at`, and a pass skips anything whose backoff has not expired. A deferred recipient
  counts as neither sent nor failed, so the totals do not lie while it waits.
- **Counters continue rather than restart.** A resume or retry pass carries the prior totals forward,
  so a campaign that reached 480 and then retried 3 does not report 3.
- **Only the scheduler owner resumes**, so two processes cannot both pick up the same interrupted
  campaign.

### Still not established

- **Scheduled sends** — whether a campaign scheduled for a future time fires at that time, and what
  happens to one whose time passed while the process was down. Not tested.
- **Open and click attribution accuracy** — whether an open is counted once per recipient, and
  whether a click is attributed to the right recipient and link. Not tested.
- **Template ownership** — whether one user can read or edit another's campaign template. Not tested.
- **Campaign create validation** — still **CANNOT VERIFY**; the earlier probe omitted a required
  field and every case returned 400.

Campaigns remains **Not yet assessable**. One Medium finding, no Critical or High in what has been
covered.

### CRM-CAMP-M03 · A long campaign name returns 500

- **Severity:** Medium · **Type:** Runtime / API
- **Measured.** `POST /api/campaigns` with a 500-character `name` → **500 Internal Server Error**.
  `campaigns.name` is `VARCHAR(255)`; nothing checks the length, so the value reaches Postgres and
  the driver error surfaces raw.
- **Contrast.** Every other refusal on this endpoint is a clean 400 with a usable message — "Campaign
  name is required.", "A valid template must be selected.", "Template not found." One field falls
  through to a server error instead.
- **Same class as** the SMTP host and admin email length checks added during the Settings audit.
- **Recommended fix.** Reject over 255 with the message the other fields already produce. **Small.**

### Campaign create validation — CANNOT VERIFY is now resolved

The earlier probe sent `subject`/`content`; the endpoint is **create-and-send** and takes `name` plus
a valid `template_id`. Re-run with the right shape, validation is otherwise sound:

| Case | Result |
|---|---|
| no name / blank name | 400 — "Campaign name is required." (trimmed) |
| no template / id 0 / id −1 / non-numeric | 400 — "A valid template must be selected." |
| template id 999999 | 404 — "Template not found." |
| **name 500 chars** | **500** — CRM-CAMP-M03 |
| valid shape, audience matching nothing | 400 — "No leads match this audience." — and nothing sent |

That last row matters: an impossible audience is refused *before* any send rather than producing an
empty campaign marked complete.

### Template ownership — sound between peers

Measured: a template created by one user, then accessed by another —

```
read    404
edit    404
delete  404
```

**404, not 403**, so the API does not confirm the template exists. Peer isolation holds.

**Not established:** whether a Super Admin editing another user's template is an intended override or
a missing check. A Super Admin edit returned **200** on an agent-owned template. `assertEditable`
appears to refuse both a shipped template and another user's, so either there is a Super Admin bypass
elsewhere or the check is not on that path — I could not distinguish the two before running out of
context, and it is **not** reported as a defect on that basis. The six shipped templates
(`user_id` NULL) were verified intact.

**Probe hygiene note.** The ownership probe renamed template 7 while testing. Templates 1–6, the
genuinely shipped ones, were untouched; template 7 was accumulated residue from earlier test runs and
has been restored. Recorded because a probe that mutates data it did not create is the same mistake
the Users audit made and is worth not repeating quietly.

### Still not established after this pass

- **Scheduled sends** — whether a future-dated campaign fires at its time, and what happens to one
  whose time passed while the process was down.
- **Open and click attribution accuracy** — whether an open counts once per recipient and a click
  lands on the right recipient and link.

### Open and click attribution — verified sound

Established by reading the tracking path end to end. **No finding.**

An open is counted **once per recipient**, not once per pixel load:

```ts
if (!r.opened) {
  // transaction: flag the recipient AND increment the campaign counter
} else {
  // already counted — only the latest opened_at is updated
}
```

The counter and the recipient flag move together in one transaction, so the campaign total is
"distinct recipients who opened" and cannot drift from the rows.

Four separate exclusions apply before anything is counted:

| Guard | What it stops |
|---|---|
| `r.campaign_id !== campaignId` | a token from one campaign crediting another |
| `r.bounced \|\| r.status === 'failed'` | counting a read on mail that was never delivered |
| `looksAutomated(user-agent)` | scanners and gateways |
| `isMachinePrefetch()` — 10 s window after `sent_at` | Gmail/Outlook image prefetch counted as a human read |

Click tracking is stronger still: **the destination is looked up by id from a row this server wrote
at send time and is never taken from the request.** The obvious `?u=https://…` shape would have made
the endpoint an open redirect; it was deliberately avoided, and the reasoning is written at the call
site.

**A near-miss worth recording.** I nearly reported the prefetch guard as dead code: the constant and
a doc comment sit together with no method beneath them, and `recordOpenUnscoped` does not reference
either. The method is defined ~70 lines further down and is called from the controller. The only
real defect is an **orphaned doc comment** — cosmetic, and the sole reason it read as a missing
implementation. Fourth time this audit that a comment's placement, not the code, produced a wrong
first reading.

### Scheduled sends — STILL NOT TESTED

Not attempted. Verifying it properly needs control over the clock or a long-running wait: a
future-dated campaign must fire at its time, and one whose time passed while the process was down
must be picked up rather than silently skipped. `parseSchedule` treats an unparseable date as "send
now", which is a deliberate choice with a stated reason, but the firing behaviour itself is
unverified. **Do not read the absence of a finding here as a pass.**

---

## Campaigns — where this leaves the module

| Area | State |
|---|---|
| Audience scoping and ownership | **Verified sound** |
| Unauthenticated tracking perimeter | **Verified sound** |
| Open / click attribution | **Verified sound** |
| Create validation | **Verified** — one finding, CRM-CAMP-M03 |
| Template ownership between peers | **Verified sound** |
| Crash mid-send | **CRM-CAMP-M02** — possible duplicate delivery |
| Super Admin editing another user's template | **Unresolved** — not reported as a defect |
| Scheduled sends | **Not tested** |

Two Medium findings, no Critical or High. Still **Not yet assessable** as a module, on the strength
of the untested scheduling path alone.

### CRM-CAMP-H02 · A scheduled campaign can mail someone who unsubscribed after it was scheduled

- **Severity:** HIGH · **Type:** Runtime (state verified) + code inspection (delivery path)
- **Module:** Campaigns · **Compliance:** CASL

**What was measured.** A campaign scheduled 24 hours ahead is created with status `scheduled` and
**its recipient list materialised immediately** — 64 `campaign_recipients` rows, all `pending`,
written at schedule time rather than at send time. Nothing is sent, which is correct.

**What the delivery path then does.** `dispatchScheduled` → `deliverPending` loads
`campaign_recipients WHERE status = 'pending'` and sends to them. **Neither re-checks suppression.**
`resolveRecipients` — which applies the suppression list, the `unsubscribed` flag, duplicate removal
and address validation — runs only at create time, against the audience as it stood then.

**What unsubscribing does, and does not do.** The handler marks that one recipient row, increments
the campaign's counter, inserts into `email_suppressions`, and sets `leads.unsubscribed = true`. It
does **not** touch `pending` recipient rows belonging to other campaigns.

**The scenario.**

```
Monday    campaign scheduled for Friday; 64 recipients frozen as `pending`
Tuesday   one of those people unsubscribes (any campaign, or an agent adds them)
          → suppression row written, lead flagged
Friday    the tick dispatches; `deliverPending` loads the same `pending` rows
          → the person who opted out on Tuesday is sent to
```

**Why this is High.** Under CASL the violation is sending *after* consent is withdrawn, and the
window here is as long as the scheduling gap — a campaign scheduled a week ahead carries a week of
stale consent. The application states in several places that honouring opt-outs is the point, and
every immediate send does honour them; the scheduled path is the one that does not. It also silently
contradicts CRM-CAMP-M02's stated priority, that a wrong send is the worst outcome this module has.

**What was NOT done.** I did not let a scheduled send actually run, so the delivery itself is
established from the code path rather than observed. The three facts it rests on — recipients frozen
at schedule time, `deliverPending` selecting on `status` alone, and unsubscribe not touching other
campaigns' rows — are each verified directly.

**Recommended fix.** Re-check suppression at dispatch, not only at schedule: filter the loaded
`pending` rows against `suppressedEmails()` and the leads' `unsubscribed` flag before sending, and
mark the excluded rows so the campaign reports them rather than dropping them silently. **Medium** —
it is the same call `resolveRecipients` already makes, moved to where the send happens.

### Scheduled sends — what IS correct

- A future-dated campaign is stored `scheduled` and **not** sent. Verified at runtime: create → 201,
  status `scheduled`, read-back `scheduled`, nothing delivered.
- **A campaign whose time passed while the process was down is still picked up.** The tick selects
  `status: 'scheduled' AND scheduled_for <= now`, so a missed window is caught on the next tick
  rather than skipped — the failure mode I expected to find, and it is handled.
- The tick runs every 60 s, on the scheduler owner only, so two processes cannot both dispatch.
- A dispatch failure leaves the campaign `partial` rather than `scheduled`, so it is not retried
  every 60 s against a broken configuration.

---

## Inbox · Calendar · Dashboard · Audit Trail · Meta — BREADTH SWEEP ONLY

**These five modules are NOT audited.** What follows is a permissions-and-perimeter sweep, which is
one dimension of the twelve the brief asks for. None of them has a score, and none should be read as
having passed.

### What this sweep did establish

**The unauthenticated perimeter is clean.** Nine endpoints across all five modules, no session:
**zero** answered. `open: []`.

**Read authorization behaves:**

| Endpoint | superAdmin | admin | agent | accounting | crm |
|---|---|---|---|---|---|
| inbox (personal) | 200 | 200 | 200 | 200 | 200 |
| calendar | 200 | 200 | 200 | 200 | 200 |
| dashboard | 200 | 200 | 200 | 200 | 200 |
| **audit** | 200 | 200 | **403** | **403** | **403** |
| meta status / health | 200 | 200 | 200 | 200 | 200 |

The audit row confirms **CRM-PERM-M03 is fixed in the running application** — accounting is now
refused, alongside agent and crm.

### What this sweep FAILED to establish — and it is the important part

**Cross-user isolation was not tested.** The probe tried to create a calendar event as one agent and
reach it as another; the create returned **400** (my request body was malformed), so no event
existed and every cross-user assertion after it ran against nothing. The result file records
`eventCreate: 400` and no isolation data.

That leaves the single highest-risk question in these modules **open**, including the one the owner
stated explicitly: *no one may view another agent's calendar events, not even an admin or super
admin.* That has **not** been verified.

**The inbox cross-read was not tested either** — the seeded agent mailbox holds 0 messages, so there
was nothing to attempt a cross-read against.

**Dashboard aggregates were not compared.** Only the response KEYS were captured, not the values, so
whether an agent's dashboard reports brokerage-wide numbers is unknown.

**Two probe paths were wrong** and their results mean nothing: `/api/todos` (404 for everyone) and
`/api/meta/forms` (400 for everyone) — wrong paths or missing parameters, not authorization results.

### Still required for these five

Everything except the perimeter and the read matrix: cross-user isolation, write authorization, field
validation, business logic, workflow interruption, concurrency, database constraints, performance,
UI, and edge cases. Meta additionally has an earlier standalone audit (`CRM-META-AUDIT.md`) whose
findings have **not** been re-verified against the current code.

**Status for all five: NOT AUDITED.**

---

# CRM › CALENDAR — isolation verified

## The rule the owner stated

> *"No one can view any other agent's events — not even the admin or super admin."*

**Verified at runtime. It holds completely.** One agent created an event; four other accounts tried
to reach it four ways each:

| Who | Read | Edit | Delete | Appears in their list |
|---|---|---|---|---|
| owner (agent) | **200** | — | — | yes |
| agent2 | 404 | 404 | 404 | **no** |
| admin (manager) | 404 | 404 | 404 | **no** |
| **superAdmin** | **404** | **404** | **404** | **no** |
| crm | 404 | 403 | 403 | **no** |

Three things worth drawing out:

1. **Super Admin is refused like everyone else.** That is unusual — Super Admin overrides most things
   in this application — and it is exactly what the owner asked for.
2. **404, not 403.** The API does not confirm the event exists, so its existence is not disclosed by
   the error code.
3. **The list check matters as much as the fetch.** A person does not usually guess an id; they look
   at their calendar. No other account's list contained the event.

The event was **verified intact in the database afterwards** — `deleted_at: null`, title unchanged,
still owned by its creator. None of the twelve hostile attempts modified anything.

## A false alarm, and why it is worth recording

The probe's final read — the owner re-reading their own event — returned **404**, which read as
"one of the delete attempts succeeded despite returning 404". It had not. The database showed the
event present and unmodified.

**The cause was the test, not the application.** Signing in on a new page created from the same
Playwright `BrowserContext` replaces the session cookie for the *whole context*, so by the end the
original page was authenticated as `crm`, not as the agent. The final read was therefore a
cross-user read — correctly 404 — and the probe's own cleanup failed for the same reason, which is
why a probe row was left behind and had to be removed directly.

Recorded because it nearly became a reported defect, and because the same trap will catch the next
multi-role isolation test written against a shared context.

## Calendar — what is still NOT audited

Isolation is one dimension. Untested: field validation, recurrence rules (`recur_freq`,
`recur_interval`, `recur_until`, `recur_count` all have validation worth exercising), timezone and
DST behaviour on `date`, the reminder scheduler, Google Calendar sync, write authorization per role,
concurrency, and the UI.

**Status: PARTIALLY AUDITED — isolation verified, everything else outstanding.**

---

## Open at handover — 2026-08-05

### 3 failing tests: `meta-budget-and-token.spec.ts`

**Pre-existing, not caused by this session's work** — confirmed by stashing every change and
re-running: still 3 failures.

Diagnosis so far, so the next session does not repeat it:

- **Not state pollution.** `meta_api_budget` is **empty** after a run; the tests use rolled-back
  transactions.
- **Not an environment override.** `META_BUDGET_PER_WINDOW` has no `.env` entry, so the default of
  600 applies.
- **Reproducible**, not flaky — the same three fail every run.

The symptom is that the FIRST `consume(META_BUDGET_PER_WINDOW)` in a clean window returns
`allowed: false`. That should be impossible: with no existing row the statement takes the INSERT
branch, and the `WHERE` guard only constrains the `ON CONFLICT DO UPDATE` branch.

**Where to look next:** whether `$queryRaw` inside the interactive transaction is actually seeing the
transaction client, and whether an earlier test in the same file leaves a committed row for the same
`window_start` (the window key is epoch-milliseconds, so two tests inside one window share a key).
Instrument `consume()` to print `start`, `rows.length` and the pre-existing `calls` before assuming
anything.

### Not started

- **Settings S-M1 … S-M12 and S-L1 … S-L7** — 19 recorded items, no work done this session.
- **Inbox, Meta, Dashboard, Audit Trail** — permissions and perimeter only; effectively unaudited.
- **Calendar** — isolation verified; validation, recurrence, DST, reminders and Google sync
  outstanding.
- **CRM-CAMP-M02 claim test** — the fix is in and the recovery half is tested; the test that would
  catch someone deleting the claim is not (see `claim-then-send.spec.ts` for the attempted approach
  and where it stalled).

### Migrations awaiting production

`20260805090000_accounting_no_audit` and `20260805140000_crm_role_campaigns_edit`, on top of the
previously outstanding set. Until they are applied, stored role permissions will not match the code.

---

# SETTINGS · INBOX · META · DASHBOARD · AUDIT TRAIL — 2026-08-05

Server suite **894 passed / 68 suites**, up from 837 / 65. Server and client builds clean, client
typecheck clean. Every fix below was sensitivity-checked by reverting it and confirming its tests go
red; the counts are recorded per section.

## First, a correction to this register

**"Settings S-M1 … S-M12 and S-L1 … S-L7 — 19 recorded items, no work done this session" was wrong
about the code, not about the session.** Re-measuring all nineteen against the current source found
**fourteen already closed** — most of them by the 2026-08-04 High and Medium remediation, which fixed
them under different labels and did not go back to strike them off the older list. One of the
fourteen I found only after changing it, which is its own lesson and is written up below.

| Recorded as open | Actually |
|---|---|
| S-M1 logo accepts any bytes · S-M2 SVG with script | Closed by M11 — magic-byte check plus SVG sanitising |
| S-M4 counter rewound · S-M5 int4 overflow | Closed by M9 |
| S-M6 concurrent edits overwrite | Closed by M8 — optimistic concurrency on `updated_at` |
| S-M7 Save not disabled while saving | Closed — `busy` / `saving` on both screens |
| S-M8 two unbounded fields | Closed by M10 — `assertNotesWithinLimit` |
| S-M9 / S-L7 / L15 signature unescaped in email | Closed — `CrmAdvancedEmailService.sanitizeHtml`, applied in `shell()` |
| S-M10 / L13 `crm_settings` has no foreign keys | Closed — migration `20260804120000_crm_settings_integrity` |
| S-M11 phone-width overflow | Closed by L1 |
| S-M12 no programmatic labels | Closed by M12 |
| S-L2 name reverts to factory default · S-L3 currency free text | Closed by H6 and M10 |
| S-L5 uncapped `limit` | Closed — `Math.min(500, limit)` / `Math.min(200, limit)` |
| L3 no unsaved-edit warning | Closed — `useUnsavedGuard`, on three screens |
| L4 unknown tab keeps its URL · L5 toasts accumulate | Closed |
| L16 email log not scoped to its sender | Closed — `can(user, 'data.read-all')` |
| L7 a role without `settings` gets a blank screen | Closed — by `RequireScreen`, at the route, not in `SettingsPage` |

**The lesson is about the register, not the module.** A finding list that records the label a fix was
filed under, rather than the behaviour, goes stale the moment two audits overlap — and the cost lands
on whoever reads it next and starts re-fixing what is already fixed. Five of the nineteen were
genuinely open, and they are below.

## Settings — the five that were real

| ID | What was wrong | Fix |
|---|---|---|
| **S-M3** | `saveProfile` compared email and username as raw strings while `users_email_lower_key` / `users_username_lower_key` are UNIQUE on `lower(...)`. `ADMIN@test.local` passed the application's own check, reached the INSERT, violated the index and came back as a bare **500** on an administrator's own profile form. `users.service.ts` has compared case-insensitively since that migration landed — two doors onto one row, and only one of them asked the question the database asks | `mode: 'insensitive'` on both lookups |
| **S-L1** | No trimming anywhere in Company Settings. `"  Padded Brokerage  "` stored verbatim and printed, padding included, on invoices and deposit receipts. A name of three spaces also passed `@IsNotEmpty` | `@Transform(trimmed)` on all eleven text fields, running before validation so `@IsNotEmpty` means what it says |
| **S-L4** | The company `email` had no format check at all. `"not-an-email"` accepted and stored, then printed on client-facing documents as the brokerage's contact address | `@Matches(EMAIL_OR_BLANK)` — a shape check that still permits empty, because clearing the box is how you unset it and `@IsOptional()` skips only `undefined`/`null` |
| **L11** | 40 consecutive `PUT /api/crm-settings` in a tight loop, all 200. The cost is not load — it is the audit trail, which every one of those writes appends to, and which is the only record of who changed the brokerage's bank account | `SETTINGS_WRITE_LIMIT` — 30/minute per user on the four configuration writes. Deliberately loose: these are explicit Save buttons, and a limit that refused the fourth save of a session would be the worse bug |
| **NUL byte** | `crm-advanced-email.service.ts` carried a literal NUL inside a string literal at byte 30357 — `user.name ?? '<NUL>'`, almost certainly shell mangling from an earlier edit. It compiled, and `grep`/`ripgrep` refused the whole file as binary, which is how it survived | Byte removed; the fallback is `''` |

**Left as recorded decisions, not defects:** S-L6 (the CRM Settings SMTP fields are inert and the help
text says so), L12 (single-brokerage tenancy, stated in `core/tenant.ts`).

### L7 was already closed too, and I did not find that out until the browser told me

L7 records that agent, crm, accounting and documentation "reach `/crm/settings` and get an empty tab
bar and nothing else — no redirect, no 'you do not have access'". I read `SettingsPage.tsx`, saw its
fallback tab was the literal string `'company'`, concluded the finding was open, and added a "No
access to Settings" card.

Then the browser test written to prove it failed, and the failure screenshot gave the answer:
**`RequireScreen` in `desk/guards.tsx` renders "No access — You don't have permission to view this
screen. Ask an administrator to grant you access under Users" before `SettingsPage` ever mounts.**
The route guard had closed it. My card was for a state those four roles cannot reach.

The follow-up question was whether *anything* reaches it. The Settings route is `orSuperAdmin`, so a
Super Admin whose `settings` permission was revoked gets past the guard and would — apparently — find
no tabs, since both CRM-area tabs ask `can('settings','view')`. Revoked it against the running
application and looked: they still see all three. `PermissionService.effectiveFor` short-circuits
`isSuperAdmin` to every screen at `edit` before the role map or any override is consulted. The branch
is unreachable.

**So the change was reverted.** What stands in its place is a comment saying where L7 is actually
handled and why the fallback can stay, plus seven browser tests pinning the real mechanism —
including the revoke-and-restore one, because that is what makes "unreachable" a measurement rather
than an assertion.

**Two things this cost, both worth carrying forward.**

*Reading one component and inferring the behaviour of a screen was the mistake.* The route table is
part of that screen. This is the third time this session a confident code-reading has been overturned
by a measurement, and every one of them went the same way: the code said less than the running system
did.

*And reverting it, I ran `git checkout --` on `SettingsPage.tsx`* — which discarded the **uncommitted**
H2 and L4 fixes from the 2026-08-04 remediation along with my own change, because that file had never
been committed. It was restored from the copy read earlier in the session and verified by `grep` for
both fixes, and the client rebuild and the 241-test browser suite were re-run to confirm. The rule
this leaves: **never `git checkout` a file in a tree with uncommitted work.** Take a copy first and
restore from the copy — which is exactly what the two server-side sensitivity checks in this same
session did, and why neither of them lost anything.

**Cover:** `settings-low-band.spec.ts`, 27 tests — reverting the three server fixes turns **18 of 27**
red — plus `e2e/tests/settings-l7-dashboard-invoices.spec.ts`, 17 browser tests.

## Audit Trail — the module with no tests, and four 500s

Zero spec files before this session. The 2026-08-05 sweep had established the read matrix
(admin/superAdmin 200, agent/accounting/crm 403) and nothing else. Probed the query string directly
against 127 real rows:

| Query | Before | Now |
|---|---|---|
| `?from=garbage`, `?to=2026-99-99` | **500** — `new Date('garbage')` is an Invalid Date and Prisma refuses it | 400 naming the field |
| `?page=Infinity`, `?page=1e20` | **500** — `Number(page)` went straight into `skip` | clamped to `MAX_PAGE` |
| `?user_id=abc` | **200, `total=1`** — `Number('abc')` is NaN, which Prisma renders as `user_id: null`, so a nonsense filter returned the one row with no user attached, presented as that user's activity | 400 |
| `?q=%`, `?q=_` | **all 127 rows** — Prisma's `contains` puts the value into `LIKE '%…%'` unescaped, so both were wildcards | escaped; a literal `50%` is now findable |
| `?q=` × 100,000 chars | accepted | truncated at 200 |

The `user_id` one is the worst of them and the least visible: this is the screen people open to
establish **who did something**, and it answered a nonsense question confidently rather than refusing
it.

**Cover:** `audit-log-query.spec.ts`, 36 tests. Reverting the service turns **17 of 36** red.

## Inbox — the isolation question the sweep could not answer

The sweep recorded: *"the inbox cross-read was not tested — the seeded agent mailbox holds 0
messages, so there was nothing to attempt a cross-read against."* These seed the mail themselves.

**Isolation holds.** Two agents, two connected accounts, real messages: not in the list, 404 on fetch
by id, 404 on mark-read with the row verifiably unchanged afterwards, identical wording for a real id
and an invented one, an unread badge counting only their own, and a `?lead=` filter that does not
widen the scope. The two areas are separate inboxes, and the helpful "that message is in your CRM
inbox" reply is produced **only** for a message the caller already owns.

**One thing worth carrying forward.** Stripping `user_id` from the service left the by-id tests
**passing** — the primary-account filter was catching them — which would make `user_id` look
redundant to whoever refactors this next. It is not: `scopeFor` falls back to "every account this
area can see" when the reader has no primary, and that fallback is not scoped to a person at all.
There is now a test for exactly that path, and it is the most important one in the file.

**Cover:** `inbox-isolation.spec.ts`, 10 tests. Removing the `user_id` filters turns **6 of 10** red.

## CRM-DASH-M01 · An agent's dashboard prints the brokerage's money

- **Module:** Dashboard (Transaction Desk) · **Severity:** Medium · **Type:** Runtime, measured
- **Affected roles:** agent, documentation, crm — every role holding `invoice: 'none'`

Three of the fourteen aggregates in `AreaDashboardService.desk()` read `{ deleted_at: null }` and
nothing else, while the other eleven are scoped — transactions by `agent`, documents through
`transactions: { is: live }`, calendar and to-dos by `user_id`. Measured against the development
database:

```
agent  Akhil      transactions.total 3   invoices { total: 5, billed: 123396, outstanding: 123396 }
admin  Akhilesh   transactions.total 7   invoices { total: 5, billed: 123396, outstanding: 123396 }
SELECT count(*), sum(total) FROM invoices WHERE deleted_at IS NULL   ->   5, 123396
```

The deal figure was correctly the agent's own 3 of 7. The money was the whole brokerage's — and the
agent role holds `invoice: 'none'`, so this was a figure the same person is refused everywhere else in
the product. **It was on screen, not merely in the payload:** `DeskDashboardPage` rendered Invoices,
Billed, Collected and Outstanding unconditionally.

**The class docstring said "every query is scoped to the signed-in user the same way its module
already scopes".** It was true of eleven of the fourteen. This is the same shape as the deletion-guard
comment recorded earlier in this project: a comment asserting a property the code does not hold is
worse than no comment, because it stops the next reader looking.

**Fixed in two parts, because either alone is insufficient.** Withheld (`invoices: null`) from anyone
without the `invoice` screen — that is the authority. And scoped through `transactions: { is: live }`
for an agent who *does* hold it, because Roles &amp; Permissions can grant one, and at that point the
old query would have handed them everything again. Null rather than zeros: "the brokerage has billed
nothing" is a different and worse untruth. The client omits the four tiles rather than blanking them.

**Cover:** `desk-dashboard-scope.spec.ts`, 11 tests. Reverting turns **6 of 11** red.

## Meta

Already carries its own audit at **95/100** with 55 tests across 5 spec files, and its three failing
budget tests were fixed earlier this session. **M-M6** — `adAccounts` and `selectAdAccount` were the
only two Graph calls on the controller not passed through `wrap()`, so an expired token or a missing
`ads_read` grant surfaced as a bare 500 instead of Meta's own message and code — is now fixed. M-M7,
M-M9 and M-M10 remain open and remain cosmetic or already mitigated; the earlier audit states why for
each.

**One noise item, not a defect.** The test run logs `MetaSyncSchedulerService: this.sync.pruneRawPayloads
is not a function`. The method exists on `MetaSyncService`; the warning comes from a spec injecting a
stub that lacks it, and the scheduler correctly swallows retention-sweep failures rather than blocking
boot. Worth silencing in the fixture so that a real failure is not lost inside a familiar warning.

## Module status after this pass

| Module | Before | Now |
|---|---|---|
| Settings | High + Medium remediated, Low band open | **All nineteen closed or recorded as decisions — fourteen were already closed and mislabelled** |
| Audit Trail | permissions only, 0 tests | **Query surface audited and fixed, 36 tests** |
| Inbox | permissions only, isolation untested | **Isolation verified, 10 tests** |
| Dashboard | aggregates never compared | **One Medium found and fixed, 11 tests** |
| Meta | 95/100, M-M6 open | **M-M6 closed** |

**Still outstanding** and unchanged by this session: the Calendar dimensions beyond isolation and its
existing 124 tests; the `claim-then-send` wiring test; and the production migrations, which remain the
owner's action.

---

# PRIORITY 1 & 2 — WRITE AUTHORIZATION AND ATTACHMENT SECURITY, 2026-08-05

## Priority 1 — direct API write authorization

### Calendar — holds completely

29 browser tests over real HTTP, one `BrowserContext` per role so no session cookie is shared (the
trap the Calendar audit recorded, which silently invalidates any multi-role file that ignores it).

| Operation | agent2 | admin | superAdmin | crm |
|---|---|---|---|---|
| `PUT /api/calendar/events/:id` on another agent's event | 404 | 404 | 404 | 404 |
| `DELETE /api/calendar/events/:id` on another agent's event | 404 | 404 | 404 | 404 |

Every refusal is re-read **as the owner** afterwards — title unchanged, event still present — because
a refusal that has already written is not a refusal. Also verified:

- **No creation on behalf of another user.** `POST` carrying `user_id`, `owner_user_id` and
  `created_by_id` pointing at another agent lands in the ATTACKER's calendar. `EventInput` has no
  such field and `whitelist: true` strips it, but mass assignment is invisible until somebody tries.
- **Guessed ids** (`999999999`, `0`, `-1`, `2147483647`) refuse below 500 on both verbs — no probe
  oracle separating ids that reached the database from ids that did not.
- **A role without `calendar: edit`** is refused on its own event too, so the screen hiding the
  button and the endpoint agree.
- **CSRF omitted → 419.** **Unauthenticated → refused on all five write paths.**

### Inbox — two real defects, both fixed

The browser version of the cross-user sync test **skipped**: it sourced a victim account from
`GET /api/mail-accounts`, which lists only brokerage accounts (`user_id: null`) and returns `[]` in
this fixture. **A skip in an authorization suite reads as a pass in the summary line**, so it moved
to the controller level where the account can simply be created — and there it found both of these.

### CRM-INBOX-M01 · A signed-in user can learn a colleague's connected email address

- **Module:** Inbox · **Severity:** Medium · **Type:** Runtime, measured · **Roles:** any authenticated

`POST /api/account/inbox/sync/:accountId` read the account with `findUnique({ where: { id } })` — no
user filter — purely to decide its area, and the wrong-area refusal interpolates `from_email`:

```
{"message":"zz-secret-…@private.test is connected under Customer Relationship Management
 and cannot be synced from here."}
```

Any authenticated user could walk account ids from the other area and be told, one at a time, which
addresses colleagues have connected. **The sync itself was never at risk** — `syncForUser` filters
`{ id, user_id }` correctly. It was the *refusal* that leaked.

**Fixed** by scoping the controller's own lookup to the caller, so the only address this endpoint can
ever name is your own — which is the entire point of that message, and costs nothing.

### CRM-INBOX-L01 · A cross-user sync answered 500

`getStatus()` was `undefined`: `syncForUser` signalled both failures with a bare `throw new Error`.
A routine "not yours" surfaced as an Internal Server Error, and so did the ordinary case of pressing
"Sync now" on an SMTP-only account — an error page carrying a perfectly good explanation that nothing
would ever render as one. Now `NotFoundException` and `BadRequestException`, with the not-found
wording identical for "does not exist" and "not yours".

**Cover:** `inbox-sync-authorization.spec.ts`, 6 tests. Reverting the controller scoping turns 2 red.
`e2e/tests/write-authorization.spec.ts`, 13 tests.

## Priority 2 — attachment security

### The Inbox has no attachments

`inbound_emails` has no attachment column, no route serves one, and `imap-sync.service.ts` never
references them — `simpleParser`'s attachments are discarded on the way in. So "can Agent A download
Agent B's inbox attachment", path traversal, MIME handling and dangerous-file handling have **no
surface** there. Saying so is the answer; writing tests that pass because nothing exists would be
worse than no tests.

The same questions land on the three surfaces that do store files, and one of them was open.

### CRM-CAMP-H03 · An agent's private template attachments were readable and writable by anyone

- **Module:** Campaigns · **Severity:** High · **Type:** Code + runtime, measured
- **Roles:** anyone holding `campaigns: view` (download) or `campaigns: edit` (add, remove)

Templates were made owner-private earlier in this audit on an explicit business decision — *a Super
Admin must not see or edit an agent's custom campaign templates.* `get`, `update` and `remove` each
go through `visibleWhere(user)` and `assertEditable`.

**The three attachment methods took no `user` argument at all, and the controller passed none.**
`getAttachment`, `addAttachment` and `removeAttachment` were reachable with two integer ids by anyone
with the screen permission. `@Screen` answers "may you use the Campaigns module"; it cannot answer
"is this yours".

**The write side is the worse half.** An attachment rides along with EVERY send of its template, so
planting one is not "editing somebody's draft" — it is putting a file in front of the brokerage's
clients over that agent's name. Removing one silently strips a document from sends that person
believes still carry it.

**Fixed** with the same two locks the template itself uses, in the same wording, so a private
template and its files answer identically. Built-ins (`user_id: null`) stay readable by everyone and
editable only by administrators, exactly as the template rule already draws it. The ownership check
sits in the SERVICE, not the controller, because the controller streams `file.data` straight to the
response — anything it can see has already left the building.

**Cover:** `template-attachment-access.spec.ts`, 17 tests. Reverting both locks turns **10 of 17**
red; reverting only the visibility lookup turns 6 red, which is what separates the read hole from the
write hole.

**Not re-audited here:** `email_template_attachments` (behind `AdminGuard`, Super Admin only) and
transaction documents. Both are file surfaces and both deserve the same pass; neither is claimed as
covered.

## A mistake of mine, and the cost of it

The full browser run after Priority 1 came back **2 failed**, and one of them was
`calendar-more.spec.ts` — a pre-existing test I had not touched.

**I had polluted its probe day.** My fixtures used `2026-09-15`, which is exactly that file's `DAY`.
It clears the day before and after every test, but only for titles carrying its own prefix, so the
21 events my earlier runs left behind survived, inflated the day, and made "+2 more" wrong. Its own
header warns about this in as many words — *"thirty-five stale appointments accumulated on this date
… every expectation was wrong for a reason that had nothing to do with the code."*

Three changes, because the per-test cleanup I had already added was not the whole answer:

- The probe day moved to a month no other spec uses.
- A `test.afterAll` sweep scoped to that month, because an assertion timeout kills a test where it
  stands and its `finally` can be cut short with it.
- The 21 stale rows were deleted from `myapp_test`.

**And one false alarm inside the fix**, worth recording because it nearly became a second finding: my
cleanup checker reported ten leaked events after every run. They were all `deleted_at` rows — calendar
deletes are soft, the API and `calendar-more` never see them, and the checker was not filtering. The
per-test cleanup had been working the whole time. The tool was wrong, not the tests.


---

# PRIORITIES 3, 4 AND 5 — 2026-08-05

## CRM-CAL-M01 · Two simultaneous saves both applied

- **Module:** Calendar · **Severity:** Medium · **Type:** Runtime, measured

The Calendar already had optimistic locking — a `version` column, echoed by the editor, compared on
save, 409 with the current version — and it works for the ordinary case. But the comparison was a
separate READ from the write, and `update()`'s own comment was candid about the limit: *"two saves
racing past the check above still end on different versions."* Under read-committed both requests
finish the read before either writes.

**Measured:** two `update()` calls started together on one event at version 1 left the row at
**version 3** — both writes applied, the second silently erasing the first. Repeated runs went either
way; the non-determinism is the signature of the race, not evidence against it.

**Fixed** by moving the predicate into the write — `updateMany({ where: { id, version: sent } })`,
with `count: 0` as the conflict. Postgres takes the row lock, the loser re-evaluates against the
committed row, matches nothing, and receives a 409 carrying the version it now has to reconcile
against. No advisory lock and no transaction: the condition *is* the lock.

A caller that sends no version still saves, as documented, and that is pinned so tightening the race
cannot quietly close that door too.

**Cover:** `concurrent-edit.spec.ts`, 5 tests, three consecutive clean runs. Removing the `version`
predicate turns it red on all three.

**Inbox concurrency — verified, and deliberately not "fixed".** `markSeen` sets one boolean; there is
no field to lose, so last-writer-wins is correct and a 409 on a read receipt would be the wrong
product. What is pinned is that a race cannot leave a state neither caller asked for and cannot slip
past the ownership filter — including a concurrent `get`, which marks read as a side effect.

## Priority 4 — Inbox list surface

**There is no Inbox search.** No `q` in the service, none in `listInbox`, no search box in
`InboxPage.tsx`. "Search accuracy", "expensive searches" and "isolation during search" have no
surface. Recorded as a product GAP — an inbox that pages but cannot be searched means finding an old
message is clicking Next — and deliberately not filled in by inventing a feature under an audit
heading.

Measured before anything was changed:

| Query | Before | Now |
|---|---|---|
| `?page=Infinity`, `1e20`, `1e999` | **500** — `skip: Infinity` reached Prisma | clamped |
| `?page=2.7` | accepted; reported back as `page: 2.7`, offset `(2.7−1)×30` | floored |
| `?page=999999` | accepted; `skip: 29,999,940` | clamped to `MAX_PAGE` |
| `?lead=abc` | **the filter was silently dropped** — a request for one lead's mail returned the whole mailbox | 400 |
| list query plan | `Limit → Sort (received_at DESC) → Seq Scan` over 2,265 rows | two composite indexes |

The `lead` one is the same shape as the Audit Trail's `?user_id=abc`: a filter that cannot be
honoured is dropped, and the reply then contains MORE than was asked for while looking like the
answer.

Migration `20260805200000_inbox_list_index` adds `(user_id, received_at DESC)` and
`(account_id, received_at DESC)` — two, because `scopeFor` produces two different filters depending
on whether the area has a primary account. The test asserts the indexes EXIST rather than that the
planner picks them: at fixture size a seq scan is genuinely the right plan, and a timing assertion
would measure the machine.

**Cover:** `inbox-pagination.spec.ts`, 20 tests. Reverting the clamp turns 6 red.

## CRM-CAL-M02 · The "+N more" popover was 518px wide inside a 390px screen

- **Module:** Calendar · **Severity:** Medium · **Type:** Runtime, measured

`CalendarPage.tsx` set `style={{ maxWidth: 520 }}`, which REPLACES the stylesheet's
`max-width: 100%` rather than adding to it. With `.modal { width: 780px }` the used width was
`min(780, 520) = 520px` at every viewport. Measured at 390px: **518px inside a 390px overlay**,
putting the right-hand side of every appointment — including its Edit and Delete buttons — off the
screen.

That is this feature's own bug in a new place. "+N more" exists because a day's later appointments
were unreachable from the grid; on a phone the thing that revealed them was itself unreachable.
Nobody would find it on a desktop, which is where 520 was chosen. Fixed to `min(520px, 100%)`.

**Three of the six checks were not previously covered**, and one of them found this. The old
isolation test asserted `.cal-item` count equals `onDay(page)` — both sides from the same user's
data, so it would have passed unchanged while another agent's appointments leaked. There were simply
never any to leak. The new test creates four for `agent2` in a separate context: **no leak, the
isolation holds.**

**Cover:** `calendar-more.spec.ts`, now 9 tests. Reverting reproduces 518 exactly.

## Priority 5 — external failure and recovery

### Inbox IMAP — sound

Nine tests drive the REAL `syncAccount` against a real `ImapFlow` pointed at `127.0.0.1:1`. Nothing
is mocked and no network leaves the machine. One bad mailbox never stops the poll; the error reaches
the UI in words with an action in them; **`last_uid` is not advanced on failure**, which is the one
that would lose mail permanently; two simultaneous syncs produce one run and one quiet no-op; the
guard is released so the next attempt happens.

Not testable without a controllable IMAP server, and stated in the file rather than skipped quietly:
a mid-transfer drop, and a server that accepts and then stalls.

### Google — the surface is smaller than it looks

**There is no Google scheduler** (there was none before this session). The integration is `pull()` on
demand plus `void`-ed pushes on write, so "rate limiting", "API outage" and "restart recovery" had no
retry loop to exercise — what they had was a push attempted once and dropped. Two gaps were recorded,
then implemented on instruction.

### CRM-GCAL-M02 · A revoked grant is now distinguished from a passing fault

`refresh()` threw `error_description || error`, so whenever Google sent a sentence the
machine-readable code was DISCARDED — and deciding permanence by matching Google's English breaks
silently the day they reword it. `GoogleAuthError` now carries `code` alongside the message.

- `invalid_grant`, `invalid_client`, `unauthorized_client` → **deactivate**, with wording that says
  reconnect and means it. Tokens are left in place: reconnecting overwrites them, and clearing them
  would lose the calendar id and the sync token for nothing.
- Everything else → **stays active**, records that it was temporary and will be retried.
- An untyped `Error` is never permanent — the string `invalid_grant` inside a generic message is not
  evidence of a revocation, and a test pins that.

Deactivation does real work rather than only labelling: `accessToken` checks `is_active` first, so
the sweep spends nothing on a credential that cannot come back. Asserted as zero refresh calls after.

### CRM-GCAL-M01 · A failed push is recorded, retried and visible

Migration `20260805220000_google_sync_retry` adds `google_sync_error`, `google_sync_attempts` and
`google_sync_next_retry_at` to `calendar_events`, plus a PARTIAL index on the sweep's query.

**No outbox table**, deliberately: the operation to retry is derivable from the row — `deleted_at`
means delete, no `google_calendar_id` means insert, otherwise patch — so a queue would duplicate
state the event already holds and would need reconciling when the two disagreed. There is a test for
the case that makes this matter: an event created, then deleted, before the sweep runs needs a
DELETE, not the insert that originally failed.

**Bounded three ways**, because an unbounded retry against a third party is its own outage: five
attempts per event, 1/5/15/60/180-minute backoff, 50 events per pass. Past the cap the event keeps
its error — still counted, still manually retryable — it simply stops asking on its own.

**The sweep is this integration's first background worker**, gated like every other
(`schedulersEnabled`, `forEachTenant`, `registerWorker`), every five minutes with a 90-second first
pass. Before it, a failed push was simply gone: `pushEvent` is `void`-ed from the request that saved
the event, so nothing survived that request to try again.

**Visible and actionable:** `GET /api/google/calendar/status` returns `pending_sync`; the calendar
card shows *"3 appointments have not reached Google yet"* with a **Retry now** button, which resets
the attempt count — an event that has used up its five automatic attempts is precisely the one
somebody is pressing it for.

Also caught while building it: `insertEvent` resolving to `null` is not an exception but is not a
success either, and used to leave the event outstanding with nothing recording it.

**Cover:** `google-sync-retry.spec.ts`, 21 tests. Reverting the classifier turns 4 red; reverting the
failure recording turns 6 red. The two tests in `google-failure.spec.ts` that deliberately pinned the
OLD behaviour are updated to the new outcome with the history kept in their comments — leaving them
would have been a lie in the other direction.

## Two process notes from this pass

**A skip in an authorization suite reads as a pass.** The browser test for cross-user Google account
sync skipped because it sourced its victim account from `GET /api/mail-accounts`, which lists only
brokerage accounts and returns `[]` in the fixture. Moved to the controller level, where the account
can simply be created, it immediately found two real defects.

**A probe polluted another spec's fixtures.** The write-authorization fixtures used `2026-09-15` —
exactly `calendar-more.spec.ts`'s probe day, which clears only its own prefix. Twenty-one leftover
events inflated the day and broke its "+N more" count in the full run. Fixed by moving to an unused
month, adding an `afterAll` sweep scoped to that month, and deleting the stale rows. The follow-up
false alarm is worth as much: the cleanup checker then reported ten leaks after every run, and all
ten were `deleted_at` rows — calendar deletes are soft, and the checker was not filtering. The tool
was wrong, not the tests.

**A latent type error surfaced.** `tsc --noEmit` over the project found `crm-dashboard-scope.spec.ts`
constructing `AreaDashboardService` with one argument after CRM-DASH-M01 added a second. ts-jest does
not typecheck, so it had been passing. Worth running `tsc` over the project, not only building.

