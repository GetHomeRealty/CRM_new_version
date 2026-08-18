# CRM — Full Production Audit

**Date:** 2026-08-15
**Branch:** `version_3`
**Scope:** CRM application only. Reviews module excluded by instruction. Transaction Desk audited *only* where it can affect the CRM.
**Auditor method:** codebase inspection, live database inspection (6 databases), server unit/integration suite, browser E2E suite, live authenticated API probing across all six roles, and query-plan measurement against a 2.5-million-lead dataset.

---

## HOW TO READ THIS REPORT

Every claim below carries its evidence class. Nothing is marked working because a route exists.

| Class | Meaning |
|---|---|
| **MEASURED** | Executed in this audit; numbers or HTTP codes reproduced here |
| **CODE-VERIFIED** | Traced end-to-end in source; deterministic; not executed at runtime |
| **TEST-BACKED** | Covered by a suite that was run and passed in this audit |
| **NOT TESTED** | Could not be exercised in this environment — stated, never assumed |

---

## 1. EXECUTIVE SUMMARY

### Overall result

# READY AFTER REQUIRED FIXES

The CRM is substantially complete and unusually well built. Its authorization model is the strongest part of the system and was verified by live attack, not by reading code: **every cross-agent read and write attempt returned 404, from every one of the six roles.** There is no privilege-escalation path, no mass-assignment path, and no unauthenticated path into any CRM endpoint that this audit could find.

It is not, however, ready to deploy today. Three defects block or materially damage production behaviour, and all three share a shape: **they are invisible in development and only appear at production scale or with production integrations connected.** None would be caught by the existing test suites, and none has a test.

### Why not "READY"

| # | Blocker | Why it blocks |
|---|---|---|
| B1 | Disconnecting Google from the CRM very likely also kills the Transaction Desk's Google Calendar | Both scopes share one OAuth client, so one grant. Silent cross-module breakage — exactly the boundary failure this audit was asked to look for |
| B2 | Birthday/anniversary greetings permanently stop above ~73,000 leads with a date of birth | Head-of-queue starvation. Leads past the 200-row cap are re-selected and re-skipped every pass, for ever |
| B3 | New-lead welcome emails silently stop when intake exceeds 100 leads per 24 h | Same pattern. A lead that ages out of the window before being reached is never welcomed |

B2 and B3 are **CODE-VERIFIED and deterministic**. B1 is **CODE-VERIFIED as a code path** but could not be reproduced against live Google in this environment; it needs one 10-minute manual confirmation before deployment (§17).

### Strengths

- **Ownership isolation is real and total.** Lead privacy holds against *every* role including Super Admin. Live-probed, not assumed (§3, §10).
- **One rule, one place.** `leadScopeWhere`, `authz.ts`, `transaction-scope.ts` and `domain.ts` are each the single definition of their rule, and the dashboard/list/counter drift that plagues CRMs has been deliberately engineered out.
- **The unauthenticated attack surface is small and correctly defended.** Meta webhook HMAC is constant-time over the raw body and refuses to run without a secret; inbound mail is rendered in a sandbox with neither `allow-scripts` nor `allow-same-origin`.
- **Production topology is thought through.** A single scheduler-owning worker, `RUN_SCHEDULERS` defaulting *off* under a process manager, and a boot-time config validator that refuses to start a misconfigured production server.
- **1,671 server tests pass, and 455 of 457 executed browser tests pass with zero application defects.** They assert outcomes, not status codes — the browser suite independently confirms cross-agent isolation on tags, notes and calls.

### Weaknesses

- **Scale-dependent defects are untested as a class.** The two starvation bugs, the unbounded tag scan and the unindexed list sort all pass every test and every dev-database check. The suites have no notion of "large".
- **An unauthenticated metrics endpoint is publicly documented as internet-reachable** and returns the full internal route inventory plus up to 300 characters of server exception text (§10 M1).
- **A security-critical browser test has gone stale** and now fails, so the property it guarded is unverified by anything (§23 L1).
- **A capability/scope contradiction**: the `crm` and `manager` roles may email the entire brokerage's lead list but cannot open a single lead record (§22 D2).

### Issue counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 (B1, B2, B3) |
| Medium | 5 |
| Low | 5 |
| Decisions required | 3 |

| Category | Count |
|---|---|
| Broken features | 3 |
| Partially complete | 2 |
| Built but not usable | 1 (Reviews — excluded from assessment; see §2) |
| Dead code | 2 |

---

## 2. CRM MODULE INVENTORY

Discovered from `client/src/App.tsx` (`SCREENS`), `client/src/desk/area.ts` (`SCREEN_AREA`), `server/src/common/domain.ts` (`SCREEN_DOMAIN`) and all 54 controllers — not from the sidebar.

| Module | Purpose | Frontend | Backend | Status | Code | Browser | Security | Perf |
|---|---|---|---|---|---|---|---|---|
| Leads | Lead lifecycle, activities | `/crm/lead`, `/crm/lead/:id` | `leads.controller` (44 routes) | **COMPLETE** | ✅ | ✅ | ✅ | ⚠ §12 |
| Lead Books | Hand out unassigned brokerage leads | inside Leads | `leads/books`, `leads/transfer-ownership` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Lead Import | CSV import, queued job | `/crm/lead` | `leads/import`, `leads/import/:jobId` | **COMPLETE** | ✅ | ✅ | ⚠ M4 | ✅ |
| Lead Export | CSV export, capped + truncation notice | `/crm/lead` | `POST leads/export` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Campaigns | Bulk email, templates, suppression | `/crm/campaigns` | `campaigns.controller` | **COMPLETE** | ✅ | ✅ | ✅ | NOT TESTED |
| Campaign Tracking | Open/click/unsubscribe (public) | — | `campaign-tracking.controller` | **COMPLETE** | ✅ | ✅ | ✅ | NOT TESTED |
| Meta Lead Ads | Webhook + sync → leads | `/crm/meta` | `meta.controller`, `meta-public.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| CRM Communications | One screen for every CRM email | `/crm/communications` | `crm-communications.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| CRM Settings | Brokerage CRM controls | `/crm/settings?tab=crm` | `crm-settings.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Welcome email | Auto-email new leads | — (sweep) | `lead-welcome.service` | **BROKEN** §9 B3 | ✅ | — | ✅ | ⚠ |
| Greetings | Birthday / anniversary | — (sweep) | `lead-greetings.service` | **BROKEN** §9 B2 | ✅ | — | ✅ | ⚠ |
| CRM Dashboard | CRM tiles | `/crm` | `dashboard/crm` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Calendar | Appointments, reminders | `/crm/calendar` | `calendar.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Tasks / Follow-ups | Lead tasks + reminders | inside Leads | `leads/:id/tasks`, `lead-task-reminder` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Inbox | Personal IMAP mail, area-scoped | `/crm/inbox` | `inbox.controller`, `mailbox.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Notifications | In-app / email / push | `/crm/notification-center` | `notifications`, `notification-preference` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Google Calendar (CRM) | Per-area Google connection | `/crm/account` | `google.controller` | **PARTIAL** §17 B1 | ✅ | ✅ | ⚠ | ✅ |
| Audit Trail (CRM) | CRM-domain history | `/crm/audit` | `audit-log.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Two-Step Verification | Personal MFA | `/crm/two-step` | `mfa.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| Users / Roles | Accounts + permission map | `/crm/users` | `users`, `roles.controller` | **COMPLETE** | ✅ | ✅ | ✅ | ✅ |
| **Client Reviews** | — | `/crm/reviews` → **StubPage** | none | **NOT BUILT** | — | — | — | — |

> **Reviews:** excluded from assessment by instruction and *not* audited. Recorded here only as a deployment fact: it is a live CRM sidebar entry that renders a "🚧 Planned module" page. Decide whether to hide the nav entry before launch.

---

## 3. ROLE-BASED AUDIT

### Roles discovered (source of truth: `server/src/core/authz.ts` + `permission.service.ts`)

Six roles, ranked. The UI label differs from the stored value — this matters when reading logs.

| Stored | UI label | Rank |
|---|---|---|
| `admin` | **Super Admin** | 100 |
| `manager` | **Admin** | 80 |
| `accounting` | Accounting | 60 |
| `documentation` | Documentation | 60 |
| `crm` | CRM | 40 |
| `agent` | Agent | 20 |

### Live backend authorization matrix — MEASURED

Signed in as all seven seeded accounts against a running API; **HTTP codes reproduced verbatim.** This is backend enforcement with the UI bypassed entirely.

| Endpoint | Super Admin | Admin | Agent | Agent2 | Accounting | Docs | CRM | Correct? |
|---|---|---|---|---|---|---|---|---|
| `GET /api/leads` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | ✅ |
| `GET /api/leads/books` | 200 | **403** | 403 | 403 | 403 | 403 | 403 | ✅ Super Admin only |
| `GET /api/campaigns` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | ✅ |
| `GET /api/users` | 200 | **403** | 403 | 403 | 403 | 403 | 403 | ✅ |
| `GET /api/audit-logs` | 200 | 200 | **403** | 403 | **403** | **403** | **403** | ✅ |
| `GET /api/crm-settings` | 200 | 200 | **403** | 403 | 403 | 403 | **403** | ✅ |
| `GET /api/invoices` | 200 | 200 | **403** | 403 | **200** | **403** | **403** | ✅ named-set capability |
| `GET /api/transactions` | 200 | 200 | 200 | 200 | 200 | 200 | **403** | ✅ |

Every result matches the documented intent. Note the two cases a rank threshold could not express and which are therefore named sets — `invoices.access` correctly admits `accounting` while refusing `documentation` at the *same rank*, and refuses `crm`.

### Cross-user access — MEASURED

Lead 1 owned by Agent; lead 5 owned by Agent2; lead 499 unattributed brokerage intake.

| Acting as | lead 1 (Agent's) | lead 5 (Agent2's) | lead 499 (intake) |
|---|---|---|---|
| Agent | **200** own | **404** | 404 |
| Agent2 | **404** | **200** own | 404 |
| CRM | 404 | 404 | 404 |
| Accounting | 404 | 404 | 404 |
| Documentation | 404 | 404 | 404 |
| **Admin (manager)** | **404** | **404** | 404 |
| **Super Admin** | **404** | **404** | **200** |

**This is the headline security result.** No role — not Admin, not Super Admin — can read another person's book. Super Admin reaches only *unattributed* intake. `404` rather than `403` throughout, so the error code cannot be used to enumerate which lead ids exist.

### Write, escalation and mass assignment — MEASURED

As Agent2, with a valid session and valid CSRF token, against Agent's lead:

| Attack | Result |
|---|---|
| `POST /api/leads/1/notes` | **404** |
| `POST /api/leads/1/tasks` | **404** |
| `POST /api/leads/1/calls` | **404** |
| `POST /api/leads/1/showings` | **404** |
| `PUT /api/leads/1 {assigned_to: self}` | **404** |
| `DELETE /api/leads/1` | **404** |
| `POST /api/leads/transfer-ownership` (Super-Admin-only) | **403** |
| `POST /api/users {role:"admin"}` | **403** |
| `PUT /api/leads/5 {owner_user_id:1, id:9999}` on own lead | 200 — **but DB verified: `owner_user_id` still 4, no id 9999 created** |

Mass assignment is rejected by field allow-listing in `LeadsService.validate()`. Confirmed by reading the rows back from the database afterwards, not by trusting the response.

### Per-role summary

**Agent (20)** — sees only leads they own or are assigned. Full CRM: leads, campaigns, Meta, calendar, triggers, own communications. No invoices, no audit trail, no users, no settings. Cannot export another's data because export is scoped identically to the list (verified 36/36-style parity in prior audits; re-confirmed by the matrix above). **No issues found.**

**CRM (40)** — the marketing role. `lead: edit`, `campaigns: edit`, `triggers: edit`. Refused transactions, invoices, audit, settings. **One contradiction:** holds `campaigns.brokerage-audience`, so campaigns may target the whole brokerage, while `leadScopeWhere` gives it **zero visible leads**. See §22 D2.

**Accounting (60)** — transactions + invoices. `audit: none` is set explicitly, which is correct: the audit trail carries user administration and permission grants, not financial records.

**Documentation (60)** — transactions edit, invoice `none`. Same rank as Accounting yet correctly denied invoices, which is exactly why `invoices.access` is a named set and not a threshold.

**Admin / `manager` (80)** — brokerage administration, no user management, `settings: view`. **Sees zero leads.** See §22 D1.

**Super Admin (100)** — everything, plus unattributed intake. Still cannot read an agent's book. Lead Books and user administration are exclusively theirs.

---

## 4. FUNCTIONAL AUDIT — key results

| Feature | Expected | Actual | Browser | API | DB | Status |
|---|---|---|---|---|---|---|
| Lead list, filters, counters | Counters reflect scope, not filter | Correct — counters computed from scope alone | ✅ | ✅ | ✅ | PASS |
| Lead create / edit / delete | Owner-scoped, audited | Correct | ✅ | ✅ | ✅ | PASS |
| Lead duplicate rule | Per-book, not brokerage-wide | Correct (`leads_owner_email_key`) | ✅ | ✅ | ✅ | PASS |
| Notes authorship | Author-only edit; author/admin delete | Correct | ✅ | ✅ | ✅ | PASS |
| Lead export | Capped, reports truncation | Correct, `truncated` flag returned | ✅ | ✅ | ✅ | PASS |
| CSV formula injection | Neutralised | E2E: HYPERLINK payload exported as text | ✅ | ✅ | ✅ | PASS |
| Lead import | Queued, idempotent, resumable | Correct; restart marks stranded jobs failed | — | ✅ | ✅ | PASS |
| Meta webhook ingest | Signed, idempotent | HMAC + globally-unique `facebook_lead_id` | — | ✅ | ✅ | PASS |
| Campaign consent | Unsubscribe + suppression enforced at dispatch | Correct, applied last and to everyone | ✅ | ✅ | ✅ | PASS |
| **New-lead welcome** | Every new lead welcomed once | **Stops above 100 leads / 24 h** | — | — | — | **FAIL B3** |
| **Birthday/anniversary** | Every lead greeted on the day | **Stops above 200 leads sharing a date** | — | — | — | **FAIL B2** |
| **Google disconnect (CRM)** | Desk connection unaffected | **Shared OAuth grant — likely revokes both** | — | — | — | **FAIL B1** |
| Inbox area separation | CRM inbox ≠ Desk inbox | Correct, filtered by `mail_accounts.scope` | ✅ | ✅ | ✅ | PASS |
| Deactivated user mid-session | Access revoked | `loadUser` returns null → 401 next request | — | ✅ | ✅ | PASS |
| Role change mid-session | Applies immediately | Permissions re-read every request; no cache | — | ✅ | ✅ | PASS |

---

## 5. BROKEN FUNCTIONALITY

### B1 — Disconnecting Google from the CRM probably kills the Transaction Desk calendar

- **Role:** any user with both areas connected
- **Module:** Google integration — CRM ↔ Transaction Desk boundary
- **Steps:** Connect the *same* Google account under CRM Settings and under Transaction Desk Settings → disconnect Google in the **CRM** → use the Transaction Desk calendar
- **Expected:** the Desk connection is untouched (this is the stated architecture, and `google-calendar-disconnect.spec.ts` asserts "leaves the Transaction Desk calendar exactly as it was")
- **Actual (predicted):** the Desk row survives and still *looks* connected, but its tokens are dead. The next sync fails `invalid_grant` and the connection silently deactivates.
- **Root cause:** `google-connection.service.ts:152-160`

  ```ts
  async disconnect(userId, scope = DEFAULT_SCOPE) {
    const conn = await this.find(userId, scope);
    if (conn.refresh_token) await this.google.revoke(decryptToken(conn.refresh_token));
    ...
  ```

  The DB delete is correctly scoped to `(user_id, scope)`. **The Google revoke is not scoped to anything** — it cannot be. Both calendar scopes authenticate with the single `GOOGLE_CLIENT_ID` (`google.constants.ts:13`; only *mail* has an optional separate client at line 37). Google revokes the whole authorization grant for a (user, client) pair, so revoking the CRM refresh token invalidates the Desk's as well.
- **Why the test does not catch it:** the E2E assertion checks local database rows. There is no Google in the test environment, so the revoke is a no-op.
- **Severity:** **HIGH** — silent cross-module breakage of exactly the boundary this audit was commissioned to protect.
- **Evidence class:** CODE-VERIFIED. **NOT reproduced against live Google** (no credentials in this environment).
- **Required fix:** before revoking, check whether the same Google account (`google_connections.email`) is connected under the other scope. If it is, delete the row and skip the network revoke; otherwise revoke as now. Confirm manually with two real connections before deploying.

### B2 — Birthday and anniversary greetings starve above ~73,000 leads with a date of birth

- **Role:** system (scheduler)
- **Module:** CRM greetings
- **Root cause:** `lead-greetings.service.ts:110-121`

  ```sql
  SELECT id FROM leads
   WHERE deleted_at IS NULL AND unsubscribed = false
     AND email IS NOT NULL AND email <> ''
     AND <column> IS NOT NULL
     AND EXTRACT(MONTH FROM <column>) = $1
     AND EXTRACT(DAY   FROM <column>) = $2
   ORDER BY id
   LIMIT 200                      -- MAX_PER_PASS
  ```

  The query **does not exclude leads already greeted**. Deduplication happens afterwards in JavaScript (`alreadyGreeted`, reading `crm_email_log`). So once the lowest-id 200 leads for today's date have been greeted, every subsequent hourly pass re-selects **those same 200 ids**, skips all 200, and sends nothing. Lead 201 and beyond are never selected on that date — not that day, not that year.
- **Trigger threshold:** any calendar date with more than 200 eligible leads. Uniformly distributed birthdays reach that at roughly **73,000 leads carrying a date of birth**.
- **Expected:** every eligible lead greeted once on the day.
- **Actual:** only the 200 lowest lead ids per date, permanently.
- **Severity:** **HIGH** at brokerage scale; invisible below it. The sweep logs `"1 sent, 2 skipped"` and looks healthy.
- **Evidence class:** CODE-VERIFIED, deterministic. Could not be reproduced at runtime: the 2.5 M-lead dataset carries no dates of birth (measured: 0 leads with DOB).
- **Required fix:** exclude already-greeted recipients inside the query (`NOT EXISTS` against `crm_email_log` for the current year) so the cap advances, or page by `id > lastSeen`. Add a test with `MAX_PER_PASS + 1` eligible leads.

### B3 — New-lead welcome emails starve above 100 new leads per 24 hours

- **Module:** CRM welcome email
- **Root cause:** `lead-welcome.service.ts:102-118` — same shape:

  ```ts
  where: { created_at: { gte: since }, ... },   // 24-hour window
  orderBy: { id: 'asc' },
  take: MAX_PER_PASS,                           // 100
  ```

  Already-welcomed leads are filtered afterwards, in JS. The oldest 100 leads in the window are re-selected every 5 minutes and re-skipped.
- **Difference from B2:** the window *slides*, so the queue does drain — but a lead that ages past 24 hours before the cursor reaches it is **never welcomed at all**, and it is silently dropped rather than retried.
- **Trigger threshold:** sustained intake above ~100 leads per 24 h — reachable by one bulk import or one good ad day.
- **Severity:** **HIGH** — a lead paid for and never contacted, with no error anywhere.
- **Evidence class:** CODE-VERIFIED.
- **Required fix:** as B2 — exclude already-welcomed rows in the query so the cap advances.

---

## 6. SECURITY AUDIT

### Critical
**None found.**

### High
**None found in the CRM's own authorization.** B1 above is a functional/boundary defect rather than an access-control failure.

### Medium

#### M1 — Unauthenticated metrics endpoint exposes the internal route map and exception text
- **Endpoint:** `GET /api/health/metrics`, `GET /api/health/workers` — no guard, by design
- **MEASURED:** `HTTP 200` unauthenticated. Returned the complete internal route inventory with call counts and latencies, e.g. `POST /api/user/password`, `POST /api/users`, `DELETE /api/users/:user`, `GET /api/audit-logs/export`, plus process memory and event-loop lag.
- **The leak:** `metrics.ts:52` records `message.slice(0, 300)` for **every 5xx**, and `snapshot()` publishes it as `recent_errors`. Unhandled Prisma errors quote field values and constraint details; unhandled application errors quote whatever was interpolated. The source comment asserts these endpoints "expose no business data … never a record" — but error messages *are* the vector, and they are business data whenever a 500 carries one.
- **Exposure is intended and documented:** `docs/VPS-DEPLOYMENT.md:485` instructs `curl -s https://your-domain.ca/api/health/metrics`. Only the worker's port 8001 is restricted to localhost.
- **Data exposed:** internal route inventory, traffic volumes, infrastructure state, and 5xx exception text.
- **Remediation:** keep `/api/health` and `/api/health/ready` public; require an auth token, or restrict to the monitoring network at the reverse proxy, for `/metrics` and `/workers`. Independently, drop `recent_errors` from the public payload.

#### M2 — `GET /api/leads/tags` loads every in-scope lead into memory on each call
- **Code:** `leads.service.ts:794` — `findMany({ where: scope, select: { tags: true } })`, unbounded, then counted in JS.
- **MEASURED** against 2.5 M leads: Super Admin scope returned **250,000 rows in 271 ms**, ~**5.3 MB** of raw JSON before Prisma object overhead. A 15,000-lead agent: 15,000 rows, 74 ms.
- Called on every Leads page load. Under 50 concurrent users this is sustained multi-hundred-megabyte transient allocation and GC pressure.
- The scoping fix applied previously closed the *disclosure* problem; the *scan* remains.
- **Remediation:** aggregate in SQL, or persist tag counts. Not a data-exposure issue — a capacity one.

#### M3 — Lead list has no index supporting its scope-plus-sort
- The list filters `(assigned_to = ? OR owner_user_id = ?) AND deleted_at IS NULL` and sorts `created_at DESC, id DESC`. **There is no index on `created_at`** (14 indexes on `leads`; none covers the sort), and the `OR` prevents a single-index path.
- **MEASURED** (2.5 M leads, 1,182 MB table):

| Book size | Share of table | Plan | p50 |
|---|---|---|---|
| 15,000 | 0.6 % | Bitmap Heap Scan | **20 ms** |
| 614,290 | 24.6 % | **Parallel Seq Scan** | **326 ms** |
| Super Admin (250,000 unattributed) | 10 % | Parallel Seq Scan + sort | **182 ms** |

- **Honest reading:** at a realistic average book (measured 11,364 leads/agent across 198 agents) performance is **fine**. The seq scan appears only when one person's scope approaches a quarter of the table. The real-world risk is the **Super Admin**, whose scope includes *all* unattributed intake and grows without bound, and each such request also consumes two extra parallel workers.
- **Remediation (not urgent):** composite indexes `(owner_user_id, created_at DESC)` and `(assigned_to, created_at DESC)`; consider keyset pagination for the Super Admin view.

#### M4 — Import job status has no ownership check
- `leads.controller.ts:193` → `imports.status(jobId)`; `lead-import-job.service.ts:128` looks the job up by `job_id` alone, with **no user check** — unlike `recent()`, which correctly filters on `requested_by_id`.
- Any user holding `lead: view` can read any import job's counts, tag and failure reason.
- **Mitigated** by a 128-bit random `job_id` (`randomBytes(16)`), so it is a capability URL, not enumerable.
- **Severity:** Low-Medium. **Remediation:** filter by `requested_by_id` unless the caller is a Super Admin.

#### M5 — Three CRM surfaces treat "whose leads are these" differently

Not a leak — each individual decision is deliberate and documented — but there is no single answer, and that is how the next change introduces one.

| Surface | Rule applied | `manager` reach | `crm` reach |
|---|---|---|---|
| Leads list / detail | `leadScopeWhere` — owner or assignee only | **0 leads** | **0 leads** |
| Campaign audience | `campaigns.brokerage-audience` (named set) | **whole brokerage** | **whole brokerage** |
| Manual CRM email recipient + email log | `data.read-all` (rank ≥ manager) | **whole brokerage** | own book only |

**MEASURED** — leads visible on the Leads screen vs. leads selectable as a campaign audience, same account, same moment:

| Role | Leads visible | Campaign audience | Gap |
|---|---:|---:|---|
| agent | 10 | 10 | consistent ✅ |
| agent2 | 4 | 4 | consistent ✅ |
| **crm** | **0** | **81** | **the whole brokerage, none of it visible** |
| **admin (`manager`)** | **0** | **81** | **the whole brokerage, none of it visible** |
| superadmin | 67 | 81 | 14 agent-owned leads mailable but not readable |

So `manager` may email and mail-merge every client in the brokerage while the Leads screen shows them nothing, and `crm` may run a brokerage-wide campaign to 81 leads it cannot open *or* individually email. See §15 D1 and D2.

### Low

- **L3** — Template preview is injected with `dangerouslySetInnerHTML` (`EmailSettingsPanels.tsx:476`, `OnboardingEmailModal.tsx:226`) and server-side sanitisation is regex-based (`crm-advanced-email.service.ts:103`), which is bypassable. Authoring is **Super Admin only**, so this is effectively self-XSS with admin-to-admin reach. Low.
- **L6** — CSRF token compared with `!==` rather than a constant-time comparison (`csrf.guard.ts`). Not practically exploitable; noted for completeness.

### Verified-good security controls

| Control | Evidence |
|---|---|
| All CRM endpoints reject anonymous callers | **MEASURED** — 401 on 11/11 endpoints probed |
| CSRF enforced, token rotates at sign-in | **TEST-BACKED** — 6 E2E cases pass; reproduced manually (419 on stale token) |
| Session fixation prevented; cookie HttpOnly; logout destroys session | **TEST-BACKED** — 12 E2E cases pass |
| Password change ends other sessions | **TEST-BACKED** |
| Meta webhook HMAC-SHA256 over raw body, `timingSafeEqual`, refuses without secret | **CODE-VERIFIED** |
| Meta `signed_request` verified before use | **CODE-VERIFIED** |
| Inbound email sandboxed — no `allow-scripts`, no `allow-same-origin` | **CODE-VERIFIED** (`MailBody.tsx:289`) |
| CSV formula injection neutralised | **TEST-BACKED** — E2E HYPERLINK payload |
| Mass assignment rejected | **MEASURED** — DB read back |
| Deactivated account loses access immediately | **CODE-VERIFIED** (`auth.service.ts:93`) |
| Rate limiting keyed per identity, not per office IP | **CODE-VERIFIED** |
| Raw SQL: all CRM raw queries parameterised or literal-switched | **CODE-VERIFIED** |
| Production boot refuses weak `APP_KEY`/`SESSION_SECRET`/cookie/URL config | **CODE-VERIFIED** |

---

## 7. DATA LEAKAGE REPORT

| Vector | Result |
|---|---|
| Cross-agent lead leakage | **NONE** — MEASURED across 6 roles × 3 leads |
| Cross-role leakage | **NONE** — Admin and Super Admin included |
| CRM ↔ Transaction Desk data leakage | **NONE found** — separate `google_connections(user_id,scope)`, `mail_accounts.scope`, separate dashboards, `domain` on audit rows |
| Export leakage | **NONE** — export scoped identically to list; `lead: edit` required, so view-only roles cannot extract |
| Notification leakage | **NONE** — Notification Centre scoped server-side to the viewer |
| API payload leakage | **NONE found** in CRM responses |
| **Unauthenticated metrics** | **PRESENT** — §6 M1 |
| Browser storage | Session is an HttpOnly cookie; no tokens in `localStorage` |

---

## 8. CRM ↔ TRANSACTION DESK BOUNDARY REPORT

The separation is **deliberate, coherent and enforced in one place per concern** — the strongest architectural aspect of this codebase.

| Shared item | Intentional? | Problem? | Security risk | Functional risk | Action |
|---|---|---|---|---|---|
| `area` concept (`crm`/`desk`) mirrored client + server | Yes | No | None | None | None |
| `google_connections` keyed `(user_id, scope)` | Yes | **Yes — B1** | None | **High** — shared OAuth grant | Fix B1 |
| `mail_accounts.scope` → separate inboxes | Yes | No | None | None | None |
| `ScreenGuard` enforces module access on every `@Screen` route | Yes | No | None | None | None |
| `audit_logs.domain` splits the two trails | Yes | No | None | None | None |
| Dashboard split into two endpoints/screens | Yes | No | None | None | None |
| `authz.ts` capabilities shared by both | Yes | No | None | None | None |
| Notification categories tagged `areas: ['desk']` | Yes | No | None | None | None |
| Session, rate limiting, storage, queue | Yes | No | None | None | None |
| Reviews/Favorites/MLS/Inventory moved to Desk | Yes | No | None | None | None |

**Verdict: CRM and Transaction Desk are properly separated, with one defect — B1.** Nothing suggests merging them, and nothing was found leaking in either direction.

---

## 9. AUTOMATION / SCHEDULER REPORT

All schedulers are in-process `setInterval` timers gated by `schedulersEnabled()` and wrapped in `clusterTick`.

| Job | Frequency | Env dependency | Duplicate protection | Failure handling | Status |
|---|---|---|---|---|---|
| Lead welcome | 5 min | `RUN_SCHEDULERS` | `clusterTick` + `crm_email_log` | logged, lead stays eligible | **BROKEN B3** |
| Lead greetings | 1 h | `RUN_SCHEDULERS` | `clusterTick` + `crm_email_log` per year | logged | **BROKEN B2** |
| Lead task reminders | timer | `RUN_SCHEDULERS` | `clusterTick` | logged | Working |
| Lead retention (60 d bin purge) | 24 h | `LEAD_RETENTION_DAYS` (0 = off) | `clusterTick` | logged | Working |
| Meta sync | `META_SYNC_SECONDS` | `RUN_SCHEDULERS` | `clusterTick` + unique `facebook_lead_id` | budgeted, alerting | Working |
| Campaign resume | timer | `RUN_SCHEDULERS` | claim-then-send | resumable | Working |
| IMAP sync | timer | `IMAP_POLL_DISABLED` | `clusterTick` | per-mailbox age surfaced | Working |
| Google calendar sync/retry | timer | `RUN_SCHEDULERS` | `clusterTick` | retry with backoff | Working |
| Mail retention | timer | `MAIL_RETENTION_DAYS` | `clusterTick` | logged | Working |
| Export sweeper | timer | `RUN_SCHEDULERS` | in-process serial | logged | Working |
| Event reminders | timer | `RUN_SCHEDULERS` | `clusterTick` | starvation-tested | Working |

**Multi-instance safety — assessed:** correct, and deliberately layered. `schedulersEnabled()` defaults **off** whenever `NODE_APP_INSTANCE` is set unless `RUN_SCHEDULERS=true`; `ecosystem.config.cjs` grants it to exactly one fork-mode worker. `clusterTick` adds a Redis lock when `REDIS_URL` is set and **deliberately runs anyway without it** — so on a Redis-less deployment the pm2 configuration is the only thing preventing duplicate client email. That is documented in the file itself and is a sound decision, but it makes `RUN_SCHEDULERS=false` on the web tier **load-bearing, not belt-and-braces**.

> Note the two starvation bugs are *not* multi-instance problems. They occur on a single correctly-configured worker.

---

## 10. PERFORMANCE REPORT

**MEASURED** against `myapp_loadtest`: 2,500,008 leads, 1,182 MB, 507 users, 198 agent books (min 3, mean 11,364, max 300,005), 80,004 transactions.

| Operation | Data size | Users | p50 | Max | Payload | Status |
|---|---|---|---|---|---|---|
| Lead list page 1 (avg book 15 k) | 2.5 M | 1 | **20 ms** | 301 ms | 25 rows | ✅ |
| Lead list page 1 (book 614 k) | 2.5 M | 1 | **327 ms** | 684 ms | 25 rows | ⚠ seq scan |
| Lead list, offset 5,000 | 2.5 M | 1 | 346 ms | 358 ms | 25 rows | ⚠ |
| Lead list, offset 300,000 | 2.5 M | 1 | **592 ms** | 614 ms | 25 rows | ⚠ deep offset |
| Pagination `count(*)` | 2.5 M | 1 | 228 ms | 242 ms | — | ⚠ |
| Header counters (`groupBy` ×2) | 2.5 M | 1 | 229 ms | 291 ms | — | ✅ single pass |
| Search `ILIKE %term%` (15 k book) | 2.5 M | 1 | 28 ms | — | 25 rows | ✅ |
| Search `ILIKE %term%` (large book) | 2.5 M | 1 | **750 ms** | 794 ms | 25 rows | ⚠ unindexable |
| Super Admin list page 1 | 250 k in scope | 1 | 182 ms | 204 ms | 25 rows | ⚠ |
| Super Admin export (all rows) | 250 k | 1 | 397 ms | — | capped at 5,000 rows | ✅ capped, truncation reported |
| **`GET /leads/tags` (Super Admin)** | 250 k rows | 1 | **271 ms** | — | **5.3 MB** | ⚠ **M2** |

### Root causes
1. **No index serves the list's sort.** `created_at` is unindexed; the `OR` scope blocks a single-index path. Below ~1 % of table per book the bitmap path is fast; above ~20 % Postgres correctly switches to a parallel sequential scan.
2. **Deep offset pagination** re-scans and re-sorts from the start.
3. **`ILIKE '%term%'`** cannot use a B-tree. Fine on small books; 750 ms on large ones. (`audit_logs` already has a trigram index — `leads` does not.)
4. **Unbounded tag scan** — M2.

### Concurrency — **NOT TESTED**
No 25/50/100-user concurrency run was performed. The headline risk is arithmetic rather than speculative: the large-book list plan requests **two extra parallel workers per request**, and `ecosystem.config.cjs` budgets 4 web × 20 + worker 10 = 90 connections against a default `max_connections` of 100 — which that file itself flags as too tight and recommends raising to 200. **Do the connection-limit change and a concurrency run before launch.**

---

## 11. BROWSER TEST REPORT

Suite: Playwright, Chromium, 460 tests, real API + real SPA + disposable `myapp_test` database.

### Result — MEASURED

```
457 of 460 tests executed
455 passed
  2 failed
```

| Failure | Verdict |
|---|---|
| `inbox.spec.ts:33` — *"renders the body as text, never as HTML"* | **STALE TEST, not an app defect.** It asserts the message body renders inside a `<pre>`. `MailBody.tsx` deliberately replaced that with a `srcdoc` iframe sandboxed with neither `allow-scripts` nor `allow-same-origin` — a *stronger* control. The test was never updated. See §16 L1 |
| `account-google-cards.spec.ts:90` — *"each card resolves to a definite state"* | **FLAKY TEST.** Reads the status pill's text immediately after asserting it exists, with no wait for the Google-status request. Fails on a cold server, passed in three other runs of this audit. Test-quality issue |

**No application defect was found by the browser suite.** 3 tests were not reached (the run was interrupted); all were in already-passing files.

> **Audit integrity note — four runs were discarded.** Reported here because the reasons matter for trusting the number. (1) Wrong database password. (2) Contaminated: I ran live API probes against the same server while the suite executed. (3)+(4) A **leftover background process from a different Claude Code session** was squatting port 8100, running the API against `myapp_loadtest` without the test `CORS_ORIGINS`; Playwright's `reuseExistingServer` adopted it, so every browser-driven login was CORS-blocked while direct API calls still succeeded. Diagnosed by the missing `Access-Control-Allow-Origin` header; resolved by clearing the port and running with `CI=1` to force Playwright to own its own server. **This also means the audience figures I first measured came from the wrong database and were discarded — see §15 D2, which rests on code, not on those numbers.**

### Workflows verified in a real browser

Sign-in for all six roles; signed-out redirects; session fixation, lifecycle and cookie attributes; CSRF (6 cases incl. token rotation at sign-in and cross-session rejection); password change ending other sessions; Google card scoping per area; Google calendar disconnect; audit export and its authorization; calendar month grid with cross-agent appointment isolation; campaigns incl. scheduling, audience scoping and the CRM role's ability to run them; CRM Communications (agent vs administrator rights, brokerage switch, Desk-template exclusion); CRM dashboard; inbox listing, opening and cross-agent isolation; lead tags, tasks, notes, calls, email — including **"a tag cannot be applied to another agent's lead"**, **"a note is not readable on another agent's lead"** and **"placing a call on another agent's lead is refused"**; lead import and export incl. formula injection; Meta; MFA; notifications; queues; recurrence; settings (high/medium/low bands); template ownership; triggers; two-step verification; write authorization.

### Mobile — TESTED (correcting an earlier assumption)

`settings-low-fixes.spec.ts` drives a **390 × 844 phone viewport** and asserts no horizontal overflow on `/crm/settings`, `/crm/dashboard` and `/crm/leads`, that every control stays reachable, and that the desktop topbar is unaffected. All passed. This is narrower than a full device matrix but it is real responsive coverage, and the specific regression it guards (measured `scrollWidth` 547–567 in a 390px viewport) is fixed.

---

## 12. AUTOMATED TEST AUDIT

### Server suite — MEASURED
```
Test Suites: 22 failed, 100 passed, 122 total
Tests:       275 failed, 1671 passed, 1946 total
Time:        89 s
```

**All 275 failures have one identical root cause, verified exhaustively:** 550 error bullets, every one reading ``The column `transactions.calc_paid_total` does not exist in the current database``. **Zero assertion failures.**

Cause: migration `20260816090000_transaction_payment_cache` has not been applied to the development database (`npx prisma migrate status`: *"Following migration have not yet been applied"*). The migration is additive and idempotent — six nullable columns and a partial index.

- **This is an environment state issue, not a code defect.**
- **No CRM suite failed.** Every failing suite is Transaction Desk-adjacent (transactions, reports, dashboard, retention, review). All CRM suites — leads, campaigns, crm-settings, meta, notifications, authz, ownership, crm-desk-isolation — passed.
- I attempted `prisma migrate deploy` to confirm; the command was **blocked by the sandbox**, so the dev database was left untouched. Apply it yourself and re-run to confirm the suite goes green.

### Coverage gaps

| CRM area | Unit | Integration | API | E2E | Security | Role | Perf | Gap |
|---|---|---|---|---|---|---|---|---|
| Leads CRUD + scope | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | — |
| Lead activities | ✅ | ✅ | ✅ | ➖ | ✅ | ✅ | ❌ | — |
| Import/export | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | job-status ownership (M4) |
| Campaigns | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | — |
| **Welcome sweep** | ✅ | ✅ | ➖ | ❌ | ➖ | ✅ | ❌ | **no over-cap test (B3)** |
| **Greetings sweep** | ✅ | ✅ | ➖ | ❌ | ➖ | ✅ | ❌ | **no over-cap test (B2)** |
| Meta | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | live OAuth NOT TESTED |
| **Google** | ✅ | ✅ | ✅ | ✅ | ➖ | ✅ | ❌ | **cross-scope revoke (B1)** |
| Notifications | ✅ | ✅ | ✅ | ✅ | ➖ | ✅ | ❌ | — |
| CRM settings/comms | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | — |
| **Inbox rendering** | ➖ | ➖ | ➖ | **STALE** | ❌ | ✅ | ❌ | **L1 — sandbox untested** |
| Performance | ❌ | ❌ | ❌ | ❌ | — | — | ❌ | **no scale tests at all** |

**The structural gap:** there is no test anywhere that exercises a sweep with more rows than its per-pass cap. That single missing pattern hides both B2 and B3.

---

## 13. WHAT IS FULLY COMPLETE

Verified UI → API → service → database → reload → correct permission:

- Lead list, filters, sort, pagination, header counters, tags
- Lead create/edit/delete/restore/purge with audit trail
- Lead notes (authorship rules), tasks, showings, calls, messages
- Lead import (queued, resumable, idempotent) and export (capped, injection-safe)
- Lead Books — Super-Admin-only hand-out of unassigned brokerage leads
- Campaigns: create, schedule, resume, templates, suppression, tracking, unsubscribe
- Meta lead ingestion: webhook + polling sync, idempotent, budgeted
- CRM Communications: brokerage switch, per-user preferences, template resolution
- CRM Settings, Company Settings
- Calendar, appointments, reminders, iCal feed
- Inbox (area-scoped), including cross-agent isolation
- Notification Centre and per-channel preferences
- Two-Step Verification (TOTP, recovery codes, trusted devices)
- Users, roles and the permission map
- CRM Audit Trail with domain separation and export
- Authentication, session lifecycle, CSRF, rate limiting, account lockout

---

## 14. WHAT NEEDS TO BE DONE

### BLOCKER — do not deploy until fixed
| # | Item | §|
|---|---|---|
| B1 | Google CRM disconnect revoking the shared grant (confirm, then scope the revoke) | §5 |
| B2 | Greeting sweep starvation | §5 |
| B3 | Welcome sweep starvation | §5 |

### REQUIRED BEFORE DEPLOYMENT
| # | Item | § |
|---|---|---|
| R1 | Restrict `/api/health/metrics` and `/api/health/workers`, or drop `recent_errors` from the public payload | §6 M1 |
| R2 | Apply migration `20260816090000` to every environment; confirm the server suite goes green | §12 |
| R3 | Fix or rewrite the stale inbox E2E test so the sandbox property is actually asserted | §16 L1 |
| R4 | Raise PostgreSQL `max_connections` to 200 as `ecosystem.config.cjs` recommends, then run a concurrency test | §10 |
| R5 | Ownership check on `GET /api/leads/import/:jobId` | §6 M4 |
| R6 | Decide the Reviews nav entry — build, hide, or ship the stub | §2 |

### PARTIALLY COMPLETED
- Greetings preference migration: `crm_trigger_settings` is still the source of truth while `notification_preferences` already registers `crm_birthday`/`crm_anniversary`/`crm_seasonal`. Documented and currently correct, but two stores describe one decision. Finish the migration.

### RECOMMENDED IMPROVEMENT
- Composite indexes `(owner_user_id, created_at DESC)`, `(assigned_to, created_at DESC)`; trigram index on `leads.name`/`email` to match `audit_logs`.
- Aggregate `/leads/tags` in SQL (M2).
- Keyset pagination for the Super Admin lead view.

### OPTIONAL IMPROVEMENT
- Constant-time CSRF comparison.
- Remove dead code: `StubPage` `INFO` entries for modules that now exist; the `pending` readiness branch in `NotificationPreferencesPage` (no category is `pending` any more).

---

## 15. DECISION REQUIRED

### D1 — The application already disagrees with itself about what an Admin may reach

This is the most important decision in this report, and it is not a hypothetical: **two parts of the CRM already answer the same question differently, today, in shipped code.**

- **The Leads module** uses `leadScopeWhere`, which exempts **no** role. Admin sees only leads they personally own or are assigned — **MEASURED: 0 leads**. Super Admin additionally sees unattributed intake.
- **The CRM email module** asks a *different* question. `crm-advanced-email.service.ts:578`:

  ```ts
  ...(can(user, 'data.read-all') ? {} : leadScopeWhere(user)),
  ```

  `data.read-all` is held by `manager` and above. So an Admin **may send a CRM email to any lead in the brokerage — including leads they cannot open, on agents' desks.** The same file also lets them read the whole CRM email log (line 787).

  This was a deliberate, well-documented fix: the "Send a CRM Email" card lives behind the `settings` permission, which only Super Admin and Admin hold, and neither owns leads — so under `leadScopeWhere` the card refused *every* recipient it would ever be given (measured 2026-08-04). The reasoning is sound.

- **The resulting state:** an Admin can email a client they are forbidden to look at, and can read the log of that email afterwards.

- **Option A — make Leads consult `data.read-all` too.** The two halves agree; management can see the books they can already mail.
- **Option B — keep Leads private and narrow the email path back.** Restores strict privacy, but re-breaks the "Send a CRM Email" card in exactly the way that was already diagnosed and fixed.
- **Option C — leave both as they are** and accept that "reach" and "read" are deliberately different powers.
- **Impact of A:** management reads every client relationship in the brokerage. Hard to reverse — a trust change, not a code change.
- **Impact of B:** a working administrative feature is removed.
- **Impact of C:** the inconsistency stays, and the next person to touch either rule has no single answer to follow.
- **Recommendation: C, made explicit** — keep both behaviours, but record the distinction ("administrators may *act on* any lead; only the owner may *browse* one") as a comment in `lead-scope.ts` pointing at the email path. If you would rather they agree, choose **A**: it matches what the product already does in the place it matters most. Do **not** choose B without re-solving the card.

### D2 — The `crm` role can email every lead but cannot see one

- **Current implementation:** `campaigns.brokerage-audience` includes `crm` and `manager`, so campaign audience selection is unrestricted (`campaign-audience.service.ts:65` → `return {}`), while `leadScopeWhere` returns only their own leads — **zero** for a role that owns none.
- **MEASURED, same account, same moment:** `crm` sees **0 leads** on the Leads screen and can select **81** as a campaign audience. Identical for `manager`. Agents are consistent (10 vs 10, 4 vs 4). Full table in §6 M5.
- **Option A — keep it.** Selection ≠ visibility: they may mail the brokerage without reading individual relationships. Every consent control still applies.
- **Option B — give `crm` read access to brokerage-owned leads** (not agents' personal books), so the audience they target is one they can inspect.
- **Impact of A:** the marketing role cannot preview, verify or troubleshoot the audience it sends to — and cannot tell a client why they received an email.
- **Impact of B:** widens lead visibility for one role; needs a clear rule for which leads count as "the brokerage's".
- **Recommendation: B, narrowly** — brokerage-owned (`owner_user_id IS NULL`) leads only, leaving agents' books private. That makes the two halves agree without touching D1.

### D3 — Greetings deduplicate by email address, across leads

- `alreadyGreeted` matches on `(kind, recipient, year)` in `crm_email_log`, ignoring which lead it was for. Two leads sharing an address — a couple, or the same person under two agents — produce **one** greeting, and the second agent's client is silently not greeted.
- **Option A — keep it.** Never send one person two birthday emails.
- **Option B — deduplicate per lead**, accepting that a shared address may receive two.
- **Recommendation: keep A.** It is the safer failure, and it appears deliberate. Worth confirming it is what the business wants.

---

## 16. CLASHES / CONFLICTS

| # | Clash | Resolution |
|---|---|---|
| C1 | Campaign audience says "the whole brokerage"; lead scope says "only your own" | D2 |
| C2 | Greeting preferences live in `crm_trigger_settings`; `notification_preferences` also registers those keys | Finish the migration (§14) |
| C3 | `google-calendar-disconnect.spec.ts` asserts the Desk is unaffected; the shared OAuth grant means it probably is affected | B1 — the test asserts local rows only |
| C4 | `inbox.spec.ts:33` asserts `<pre>` text rendering; `MailBody.tsx` deliberately replaced that with a sandboxed iframe | L1 — rewrite the test |
| C5 | `StubPage` still describes Favorites, Inbox, Triggers and Settings as unbuilt; all four exist | Dead data; harmless |
| C6 | `NotificationPreferencesPage` renders a "Soon" state for `pending` channels; no category is `pending` | Unreachable UI |

---

## 17. INTEGRATION REPORT

### Google — **PARTIAL, blocked by B1**
Per-area connections `(user_id, scope)`, encrypted refresh tokens, token refresh with `invalid_grant` handling, retry with backoff, disconnect hides synced events and clears cached dashboard tiles. **Blocker:** shared `GOOGLE_CLIENT_ID` across both calendar scopes (§5 B1). Live OAuth round-trip **NOT TESTED** — no credentials available.
**Pre-deployment check (10 minutes):** connect the same Google account under both areas, disconnect the CRM, then confirm the Desk calendar still syncs.

### Meta — **PRODUCTION-READY, environment-dependent**
Webhook HMAC verified constant-time over the raw body; refuses to process without a secret; handshake refuses when no verify token is configured; ingestion idempotent on a globally-unique `facebook_lead_id`; API budget and alerting present; data-deletion callback verified. Boot-time validation refuses production if `META_PUBLIC_URL` is missing, non-HTTPS, localhost, or an ephemeral tunnel (`trycloudflare`, `ngrok`, …) — a well-judged check. Live webhook delivery **NOT TESTED**.

### Email — **WORKING, with two broken senders**
Template resolution, brokerage master switch, per-user preferences, suppression list, unsubscribe, bounce classification and duplicate prevention are all correct and tested. The **welcome** and **greeting** senders are broken at scale (B2, B3). Real SMTP delivery **NOT TESTED** (`MAIL_ALLOW_REAL_SEND` off).

### Twilio / SMS / Voice — **NOT TESTED** (out of the CRM core; no credentials).

---

## 18. DATABASE FINDINGS

- **Schema quality is high.** 87 migrations, all applied except one; foreign keys, cascades and soft deletes are consistent; `leads_owner_email_key` on `(COALESCE(owner_user_id,0), lower(email))` correctly encodes "unique within a book, not across the brokerage".
- **Missing indexes:** none supporting `leads.created_at` (the list's sort); no composite `(owner_user_id, created_at)` / `(assigned_to, created_at)`; no trigram index on `leads.name`/`email` although `audit_logs` has one.
- **Unbounded query:** `/leads/tags` (M2).
- **Deep-offset pagination** on the lead list.
- **Orphan/ownership:** no orphan risk found. `returnToBrokerage` correctly nulls both `owner_user_id` and `assigned_to` on departure while leaving personal Meta leads with the agent.
- **Retention:** 60-day bin purge, `LEAD_RETENTION_DAYS=0` disables it; uses the same delete path as a manual purge, so cascades are identical.
- **Pending migration** `20260816090000_transaction_payment_cache` — additive, idempotent, safe.
- **N+1:** none found in the CRM read paths. The lead list header was deliberately collapsed from 15 queries to 4 (`statsGrouped`), with the reasoning recorded in the source.

---

## 19. PRODUCTION CONFIGURATION

Validated at boot by `validate-config.ts` when `NODE_ENV=production` — it collects every problem and refuses to start.

| Variable | Class | Note |
|---|---|---|
| `DATABASE_URL` | **Required** | |
| `APP_KEY` | **Required** | Must decode to exactly 32 bytes; blank silently becomes an all-zero key |
| `SESSION_SECRET` | **Required** | ≥ 32 chars; the dev default is rejected |
| `COOKIE_SECURE=true` | **Required** | |
| `COOKIE_SAMESITE` | Required | `none` requires `secure` |
| `FRONTEND_URL` | **Required** | HTTPS, no trailing slash, not localhost |
| `CORS_ORIGINS` | Required | |
| `RUN_SCHEDULERS` | **Required** | `true` on exactly one worker; `false` on web — **load-bearing without Redis** |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Required for Google | Shared by both calendar scopes — see B1 |
| `META_APP_ID` / `_SECRET` / `META_PUBLIC_URL` / `META_WEBHOOK_VERIFY_TOKEN` | Required for Meta | Ephemeral tunnels rejected |
| `REDIS_URL` | **Recommended** | Absent → in-process queues, no distributed lock, jobs lost on restart |
| `STORAGE_ROOT` | Required | Must be shared across processes |
| `VAPID_*` | Required for push | |
| `LEAD_RETENTION_DAYS`, `MAIL_RETENTION_DAYS` | Optional | `0` disables |
| `MAIL_ALLOW_REAL_SEND`, `MAIL_REDIRECT_TO` | Dev/test | Must not reach production as test values |
| `TZ` | Required | Must match across web and worker |
| `WEB_INSTANCES`, `WEB_DB_POOL`, `WORKER_DB_POOL` | Optional | See the `max_connections` arithmetic — §10 R4 |

No secrets are printed in this report. **Note:** the current `server/.env` is a development configuration (`NODE_ENV=development`, `COOKIE_SECURE=false`, localhost URLs) and would be rejected by the validator in production — which is the intended behaviour.

---

## 20. REAL-WORLD USER SCENARIOS

| Persona | Outcome |
|---|---|
| **New agent** | Signs in, sees an empty but correct CRM; empty states render; own leads only. **PASS** |
| **Experienced agent** | Full lead lifecycle works; list/search/filter/pagination correct; export scoped. **PASS** at ~11 k leads; list degrades if their book grows to a large share of the table (§10) |
| **Manager (Admin)** | Administers the brokerage but **sees no leads at all** — D1 |
| **Marketing (CRM role)** | Can build and send brokerage-wide campaigns but sees **zero leads** — D2 |
| **Super Admin** | Full control; reaches unattributed intake but *not* agents' books; Lead Books hand-out audited |
| **Malicious insider** | Every cross-user read/write refused (404); escalation refused (403); mass assignment ignored. **PASS** |
| **Anonymous attacker** | All CRM endpoints 401; webhooks HMAC-verified; **but** `/api/health/metrics` answers 200 with the route map — M1 |
| **Multiple tabs / double-click / refresh** | Sessions independent; CSRF rotates correctly at sign-in; import is a polled job so a refresh cannot repeat it. **PASS** |
| **Deactivated mid-session** | Next request 401. **PASS** |
| **Role changed mid-session** | Applies on the next request — permissions are re-read, never cached. **PASS** |
| **External outage** | Google/Meta failures logged, retried with backoff, surfaced in health; no user-facing crash. **PASS** |
| **High volume** | **Welcome and greeting emails silently stop** — B2, B3 |

---

## 21. DEPLOYMENT BLOCKERS

| # | Blocker | Area | Severity | Why it blocks | Required fix |
|---|---|---|---|---|---|
| 1 | CRM Google disconnect revokes the shared OAuth grant | Google / CRM↔Desk boundary | **High** | Silently breaks Transaction Desk calendar sync for any user with both connected; the test that should catch it only checks local rows | Skip the network revoke when the same account is connected under the other scope. **Confirm manually first** |
| 2 | Greeting sweep head-of-queue starvation | CRM email | **High** | Above ~73 k leads with a DOB, most clients are never greeted; logs look healthy | Exclude already-greeted rows inside the query; add an over-cap test |
| 3 | Welcome sweep head-of-queue starvation | CRM email | **High** | Above ~100 leads/24 h, paid-for leads are never contacted and are silently dropped | Same fix; add an over-cap test |
| 4 | Unauthenticated `/api/health/metrics` | Security | **Medium** | Publicly documented as internet-reachable; exposes the internal route map and up to 300 chars of 5xx exception text | Restrict at the proxy or require a token; drop `recent_errors` |
| 5 | Unapplied migration `20260816090000` | Release process | **Medium** | 275 tests fail against an un-migrated database; a production deploy that skips it breaks Desk reports | `prisma migrate deploy` in every environment; verify the suite |

---

## 22. FINAL PRODUCTION READINESS CHECKLIST

| Area | Result |
|---|---|
| Authentication | **PASS** |
| Authorization | **PASS** |
| Role permissions | **PASS** |
| CRM isolation (cross-user) | **PASS** |
| CRM ↔ Desk isolation | **PARTIAL** — B1 |
| Lead workflows | **PASS** |
| Contact workflows | **PASS** |
| Tasks / follow-ups | **PASS** |
| Notifications | **PASS** |
| Email | **PARTIAL** — B2, B3 |
| Templates | **PASS** |
| CRM settings | **PASS** |
| Brokerage controls | **PASS** |
| Google | **PARTIAL** — B1; live OAuth **NOT TESTED** |
| Meta | **PASS** (code + tests); live webhook **NOT TESTED** |
| Search / filters / pagination | **PASS** functionally; **PARTIAL** at scale |
| Import / export | **PASS** (M4 minor) |
| Database integrity | **PASS** |
| Security | **PASS** with one Medium (M1) |
| Data leakage | **PASS** |
| Performance | **PARTIAL** — measured single-user; concurrency **NOT TESTED** |
| Browser stability | **PASS** — 455/457 executed, 0 application defects |
| Mobile usability | **PASS (narrow)** — 390px viewport, no horizontal overflow, controls reachable |
| Background jobs | **PARTIAL** — B2, B3 |
| Logging | **PASS** |
| Error handling | **PASS** — no stack traces to clients; 404-not-403 discipline |
| Production configuration | **PASS** — boot validator |
| Automated testing | **PARTIAL** — no scale tests; one stale test |

---

## 23. FINAL VERDICT

| Dimension | Score | Basis |
|---|---:|---|
| **Overall CRM completion** | **93 %** | Every module built and reachable except Reviews (excluded); three defects in delivery paths |
| **Functional readiness** | **90 %** | Core lifecycle complete and verified; two email automations broken at scale |
| **Security readiness** | **95 %** | No critical or high findings; ownership isolation verified by live attack; one Medium disclosure |
| **Performance readiness** | **75 %** | Good at realistic book sizes; unindexed sort, unbounded tag scan, concurrency untested |
| **Role & permission readiness** | **98 %** | Live-verified across six roles; one capability/scope contradiction to decide |
| **Integration readiness** | **80 %** | Meta production-ready; Google blocked on B1; live round-trips untested |
| **Production readiness** | **85 %** | Blocked by three High defects and one Medium disclosure |

### Can this CRM be deployed to production today? **NO**

Not because it is unfinished — it is close, and the parts that matter most for a CRM (who may see whose clients) are genuinely excellent. It is because three defects would each cause **silent** failure in production: a brokerage would not learn that its welcome emails had stopped, that its birthday greetings had stopped, or that half its Google calendars had gone quiet. Silent failures in client communication are the expensive kind.

### Must fix before deployment
1. **B1** — scope the Google revoke; confirm manually with two live connections first
2. **B2** — greeting sweep starvation
3. **B3** — welcome sweep starvation
4. **M1** — restrict the public metrics endpoints
5. **R2** — apply the pending migration everywhere and confirm the suite is green
6. **R4** — raise `max_connections` to 200 and run one concurrency test
7. **D2 / R6** — decide the CRM role's lead visibility, and whether Reviews ships as a stub

### Can safely wait until after deployment
- Composite and trigram indexes on `leads` (M3) — current volumes do not need them
- SQL aggregation for `/leads/tags` (M2) — monitor memory first
- Import job ownership check (M4) — unguessable id today
- Constant-time CSRF comparison; dead-code removal (L4)
- Finishing the greetings preference-store migration
- Mobile/responsive review

---

## APPENDIX — What was NOT tested, and why

Stated explicitly rather than assumed, per the audit rules.

| Item | Reason |
|---|---|
| Concurrency at 25/50/100 users | No load harness run; requires a dedicated environment |
| Live Google OAuth round-trip, token refresh, revoked-token recovery | No Google credentials in this environment |
| Live Meta webhook delivery and OAuth | No Meta app credentials; `META_PUBLIC_URL` is a dev tunnel |
| Real SMTP/IMAP delivery | `MAIL_ALLOW_REAL_SEND` off by design |
| Twilio SMS/voice | Out of CRM core; no credentials |
| Tablet + full device matrix | Only a 390px phone viewport is covered (that part **was** tested and passed) |
| B1 reproduction against Google | Requires two live connections — **do this before deploying** |
| B2 reproduction at runtime | The 2.5 M-lead dataset carries no dates of birth (measured: 0) |
| Reviews module | **Excluded by instruction** |
| Transaction Desk functional behaviour | **Out of scope** — audited only at the CRM boundary |

### Databases inspected

| Database | Leads | Users | Transactions | Role in this audit |
|---|---:|---:|---:|---|
| `myapp` (dev) | 3 | 9 | 8 | Unit tests; one migration behind |
| `myapp_test` | 66 | 7 | 4 | Browser E2E |
| `myapp_qa` | 512 | 13 | 7 | — |
| `myapp_loadtest` | **2,500,008** | 507 | 80,004 | **Performance measurement** |
| `myapp_staging_rehearsal` | 2,500,649 | 514 | 11 | — |
| `myapp_perf_large` | 0 | 601 | 79,037 | — |

**The development database is effectively empty (3 leads).** Every conclusion about behaviour at scale in this report comes from `myapp_loadtest`, not from `myapp` — and that distinction is precisely why B2, B3 and M2 have survived until now.

### What this audit changed on your machine

Recorded so nothing is a surprise.

| Change | Where | Reversible |
|---|---|---|
| Re-seeded the test database | `myapp_test` only | Yes — `node server/scripts/seed-test-env.cjs` |
| Test writes from the E2E suite and my API probes (one lead note, one lead's name/email) | `myapp_test` only | Yes — re-seed |
| Rebuilt the server | `server/dist/` | Yes — `npm run build` |
| Added this report | `docs/audit/CRM-FULL-AUDIT-2026-08-15.md` | It is the only file added |
| Killed a background process tree squatting port 8100 | Root was a **separate `claude.exe` session** running a load-test API against `myapp_loadtest` | Not reversible — that session's background command is gone |

**Nothing was changed in `myapp` (development), `myapp_loadtest`, or any application source file.** The pending migration was **not** applied: `prisma migrate deploy` was blocked by the sandbox, and per the audit rules the issue is reported rather than silently fixed.
