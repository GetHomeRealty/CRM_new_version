# CRM — Complete Functional, Technical, Workflow, Security & Production-Readiness Audit

**Date:** 2026-08-07
**Scope:** CRM module only. Transactions / Transaction Desk are **OUT OF SCOPE – TRANSACTIONS MODULE** throughout.
**Method:** static read of the server (`server/src`, ~70k lines TS), the Prisma schema (3,190 lines), and the React client (`client/src`). Runtime behaviour was **not** exercised — every claim below is traceable to a file and line. Anything that could not be established from code is marked **UNVERIFIED – REQUIRES MANUAL TESTING**.

**Confidence legend used throughout:**
`VERIFIED` = read directly in code · `PARTIALLY VERIFIED` = inferred from two or more files · `UNVERIFIED` = needs a running system.

---

# PART 0 — HOW TO READ THIS REPORT

The codebase has been through several prior audits (`docs/audit/`), and it shows: the access-control layer, the tenancy layer, the campaign send loop and the notification dispatcher are unusually well reasoned and heavily commented with *why*. **Most of what follows is not "the code is bad".** It is:

1. a small number of **genuine defects** that survived the previous passes, mostly found by *cross-file* comparison (two files that each look right but disagree);
2. a large cluster of **fields and settings that are collected but drive nothing** — the single biggest honesty problem in the CRM;
3. **structural gaps** — no campaign editing, no lead merge, no auto-assignment, no timezone model, no campaign audit trail.

---

# PART 1 — COMPLETE CRM MODULE MAP

## 1.1 Area split

The application is split into two areas at the routing, permission and data level: `crm` and `desk`. The split is declared twice and the two copies are kept deliberately in step:

- server: [`server/src/common/domain.ts`](server/src/common/domain.ts) → `SCREEN_DOMAIN`
- client: [`client/src/desk/area.ts`](client/src/desk/area.ts) → `SCREEN_AREA`

### Screens the CRM owns

| Screen key | Label | Route | Server module | Status |
|---|---|---|---|---|
| `lead` | Lead | `/crm/lead`, `/crm/lead/:id` | `leads/` | Implemented |
| `campaigns` | Campaigns (+ Templates, Suppression List) | `/crm/campaigns?tab=` | `campaigns/` | Implemented |
| `meta` | Meta | `/crm/meta` | `meta/` | Implemented |
| `reviews` | Client Reviews | *(no route)* | *(none)* | **NOT IMPLEMENTED — stub** |

### Screens shared with the Desk, each with its own CRM view

| Screen key | Label | CRM route | Server module |
|---|---|---|---|
| `dashboard` | Dashboard | `/crm` | `dashboard/area-dashboard.service.ts` |
| `calendar` | Calendar | `/crm/calendar` | `calendar/` |
| `inbox` | Inbox | `/crm/inbox` | `inbox/` |
| `audit` | Audit Trail | `/crm/audit` | `audit-log/` |
| `triggers` | Triggers | `/crm/triggers` | `crm-settings/crm-triggers.service.ts` |
| `settings` | Settings → CRM Settings | `/crm/settings?tab=crm` | `crm-settings/` |
| `users` | Users | `/crm/users` | `users/` (Super Admin only) |
| `account` / `notifications` / `notification-center` | Personal screens | `/crm/account` etc. | `account/`, `notifications/` |

### Screens explicitly moved OUT of the CRM
`mls`, `favorites`, `inventory`, `transactions`, `invoice`, `reports`, `analytics`, `recycle-bin` — all `desk`. **OUT OF SCOPE – TRANSACTIONS MODULE.**

## 1.2 Server modules in CRM scope

| Module | Files | Lines | Purpose |
|---|---|---|---|
| `leads/` | 15 | 4,623 | Lead CRUD, activity (notes/tasks/showings/calls/emails/SMS), CSV import, export, transfer, recycle bin |
| `campaigns/` | 22 | 5,167 | Campaign send engine, audience resolution, templates, tracking, suppression, bounce handling |
| `meta/` | 18 | 4,181 | Facebook/Instagram lead-ads OAuth, webhook, poll sync, budget, alerts |
| `calendar/` | 21 | 4,622 | Events, recurrence, reminders, web push, holidays, AI suggestions, to-dos |
| `crm-settings/` | 7 | 2,112 | CRM settings, profile, email settings, advanced emails, referral codes, broadcasts, triggers |
| `notifications/` | 14 | 3,191 | Dispatcher, preferences, Notification Centre, CRM event notifier |
| `inbox/` | 12 | 2,467 | IMAP sync, mail list, retention |
| `email/` | 11 | 2,228 | Mail accounts, transactional templates, mailer |
| `sms/` | 6 | 543 | Twilio SMS send + webhooks |
| `google/` | 15 | 2,342 | Google OAuth, Calendar two-way sync, Gmail connect, iCal feeds |
| `audit-log/` | 6 | 1,233 | Audit trail read + export |
| `dashboard/` | 8 | 1,489 | CRM + Desk dashboards |
| `core/`, `auth/` | 55 | 9,350 | Tenancy, RBAC, sessions, MFA, throttling |

## 1.3 Roles

Six roles, ranked ([`server/src/core/authz.ts`](server/src/core/authz.ts)):

| Stored key | UI label | Rank |
|---|---|---|
| `admin` | Super Admin | 100 |
| `manager` | Admin | 80 |
| `accounting` | Accounting | 60 |
| `documentation` | Documentation | 60 |
| `crm` | CRM | 40 |
| `agent` | Agent | 20 |

Access is the **pair** of (module licensed to company × module assigned to user) × (screen permission at level `none < view < edit`), enforced in [`ScreenGuard`](server/src/auth/guards/screen.guard.ts). Named capabilities (`campaigns.brokerage-audience`, `leads.rewrite-identity`, `data.read-all`, …) sit on top for actions that do not follow the seniority ladder.

## 1.4 Integrations

| Integration | Direction | Auth | State |
|---|---|---|---|
| Meta lead ads | in (webhook + poll) | OAuth per user, HMAC webhook | Implemented, encrypted tokens |
| Google Calendar | two-way | OAuth per user per area, AES-256-GCM tokens | Implemented + retry sweep |
| Gmail (mail account) | out | OAuth | Implemented |
| IMAP/SMTP mail accounts | in/out | encrypted password | Implemented |
| Twilio SMS | out + status webhook | HMAC signature | Implemented |
| Twilio Voice (click-to-call, browser dialer) | out | HMAC | Implemented |
| Anthropic (AI email drafting, calendar suggestions) | out | API key | Implemented, feature-flagged |
| Web Push (VAPID) | out | VAPID keys | Implemented |

---

# PART 2 — ROLE-BY-ROLE PERMISSION AUDIT

## 2.1 Effective CRM permission matrix

From [`permission.service.ts`](server/src/auth/permission.service.ts) `compiledDefaults()` (database-backed, with the compiled map as fallback):

| CRM screen | Super Admin | Admin (`manager`) | Agent | CRM | Accounting | Documentation |
|---|---|---|---|---|---|---|
| dashboard | edit | edit | view | view | view | view |
| calendar | edit | edit | **edit** | view | view | view |
| inbox | edit | edit | view | view | view | view |
| lead | edit | edit | **edit** | **edit** | view | view |
| campaigns | edit | edit | **edit** | **edit** | view | view |
| meta | edit | edit | **edit** | view | view | view |
| reviews | edit | edit | view | **edit** | view | view |
| triggers | edit | edit | **edit** | **edit** | view | view |
| audit | edit | **view** | none | none | none | none |
| settings | edit | **view** | none | none | none | none |
| users | edit | **none** | none | none | none | none |

## 2.2 Data-visibility rules — verified at the query level

| Record type | Rule | Where enforced | Verified |
|---|---|---|---|
| Lead | Visible only to `owner_user_id` or `assigned_to`. **No role is exempt** — a manager cannot read an agent's book. Super Admin additionally sees `owner_user_id IS NULL` (unattributed intake). | [`common/lead-scope.ts`](server/src/common/lead-scope.ts) `leadScopeWhere` — used by list, get, update, delete, export, tags, tasks feed, showings feed, dashboard, calendar link validation, advanced email | VERIFIED |
| Lead activity (notes/tasks/showings/calls/emails/SMS/recordings) | Same rule, via `ResourceAccessService.assertLead`, which 404s both "missing" and "not yours" so ids cannot be enumerated | [`core/resource-access.service.ts`](server/src/core/resource-access.service.ts) | VERIFIED |
| Lead note edit/delete | Author-only to edit; author or `manager+` to delete | `assertNoteAuthor` | VERIFIED |
| Campaign | Private to `created_by_id`, **every role** | `CampaignsService.ownerScope` | VERIFIED |
| Campaign template | Built-ins (`user_id IS NULL`) shared, everything else private to its author **including from Super Admin** | `CampaignTemplatesService.visibleWhere` | VERIFIED — **but see F-01, which bypasses it** |
| Calendar event | Private to `user_id`, every role | `CalendarService.scopeWhere` | VERIFIED |
| Meta connection / forms / Meta leads | Private to the connecting user | `MetaController` (`user_id` on every query) | VERIFIED |
| Inbox mail | Private to `user_id`, further filtered by mail-account `scope` | `InboxController` + `InboxService` | VERIFIED |
| Suppression list | Whole brokerage for `admin`/`manager`/`crm`; own leads' addresses only for everyone else | `CampaignsService.listSuppressions` | VERIFIED |
| CRM email send log | All for `data.read-all` (manager+); own sends otherwise | `CrmAdvancedEmailService.listLog` | VERIFIED |
| Audit trail | Brokerage-wide for anyone with `audit: view` (Super Admin, Admin) | `AuditLogService` | VERIFIED — intentional |
| Notifications | Own only | `NotificationsController` | VERIFIED |

## 2.3 Identity-lock on brokerage-assigned leads

An agent working a lead they did **not** create cannot change `name`, `email`, `phone`, `lead_source`, `assigned_to`, and cannot delete it. Checked against *what would actually change*, not what was posted, so the full-form save still works. Governed by capability `leads.rewrite-identity` (manager+). `LeadsService.update` / `.remove` / `.bulkDelete`. VERIFIED.

## 2.4 URL / ID / parameter tampering — what was checked

| Attack | Result | Evidence |
|---|---|---|
| `GET /api/leads/:id` with another agent's id | 404 (`leadScopeWhere` inside the query) | VERIFIED |
| `POST /api/leads/:id/notes` etc. with another agent's lead id | 404 via `assertLead` — identical wording to a missing lead, so no enumeration oracle | VERIFIED |
| `GET /api/leads/:id/calls/:callId/recording` | `assertLead` first; audio served `inline` but the upload type is allowlisted + `X-Content-Type-Options: nosniff` | VERIFIED |
| `GET /api/campaigns/:id` for someone else's campaign | 404 (`ownerScope` in the query) | VERIFIED |
| `POST /api/calendar/events` with an arbitrary `lead_id` / `transaction_id` | Both validated **through the caller's scope**, with "does not exist" wording, closing the enumeration oracle | VERIFIED |
| `?lead=abc` on the inbox, `?user_id=abc` on the audit trail | Rejected with 400 rather than silently dropped (a dropped filter would return the whole set) | VERIFIED |
| Company id supplied by the client | Never consulted — the tenant comes from the session via `TenantContextMiddleware` + Prisma extension | VERIFIED |
| **`GET /api/campaigns/options` — other agents' private template bodies** | **LEAKED. See F-01.** | VERIFIED |
| **`POST /api/campaigns` with another agent's `template_id`** | **ACCEPTED. See F-01.** | VERIFIED |

## 2.5 Routes with no `@Screen` decorator

`ScreenGuard` returns `true` when a handler carries no `@Screen`. Two lead routes are in that state:

- `GET /api/leads/books`
- `POST /api/leads/transfer-ownership`

Both delegate to `LeadTransferService`, which performs its own Super-Admin check, so this is defence-in-depth rather than a hole — **but it also means module access (`crm` assigned + licensed) is not checked on those two routes**, because `ScreenGuard` does the module check inside the same block. See **F-09**.

---

# PART 3 — MODULE-BY-MODULE

## 3.1 LEADS

**Purpose.** The book of people the brokerage is in a relationship with, and the record of every contact with them. It is the CRM's centre of gravity.

**Roles.** Agent, CRM, Admin, Super Admin write; Accounting and Documentation read only (and cannot export — see below).

**Workflow.**
```
Intake (manual | CSV import | Meta webhook/poll)
  → lead row created, owner = creator, assigned_to optional
  → audit row "Lead created"
  → notifyNewLead (templated email, inbound sources only)
  → CrmEventNotifier.leadCreated → in-app + push + email (per preference)
  → [if assigned to someone else] leadAssigned notification
Working the lead
  → notes / tasks / showings / calls / emails / SMS, all scoped through assertLead
  → lead_status, lead_response, lead_conversion updated by hand
Follow-up
  → lead_tasks with due_date → LeadTaskReminderService sweep → lead_task_due notification
Closure
  → lead_status = 'closed' AND/OR lead_conversion = 'converted' (two independent fields, see F-14)
Deletion
  → soft delete → Recently Deleted (paginated) → restore or purge
```

**Dependencies.** `core/resource-access`, `notifications/`, `email/mailer`, `sms/twilio`, `meta/meta-lead-mapper` (phone normalisation), `campaigns/` (audience), `calendar/` (event `lead_id`), `audit-log/`.

**Statuses.**
- `lead_status`: `hot | warm | cold | mild | closed`
- `lead_response`: `active | inactive | not answering | not actively answering | always responding`
- `lead_conversion`: `converted | not-converted`
- `source` (provenance, system-written): `manual | import | facebook_meta`
- `lead_source` (channel, human-entered): `google ads | meta | website | refferal | linkedin | youtube`
- task: `pending | completed | cancelled`; showing: `scheduled | completed | cancelled`; call outcome: `connected | no answer | voicemail | wrong number | callback requested`

**Automation.** New-lead email (inbound sources); in-app/push/email notifications; task-due reminders; Meta dedupe on `facebook_lead_id` and `phone_normalized`; phone normalisation on save; unique index `(company_id, COALESCE(owner_user_id,0), lower(email))`.

**Classification: PARTIALLY COMPLETED.**
Working: CRUD, scoping, activity, import, export, recycle bin, transfer, tagging, notifications, click-to-call, SMS, AI email drafting, call recordings.
Missing: **lead merge, duplicate detection UI, auto-assignment/round-robin, lead scoring, any use of ~14 stored fields** (Part 4).

---

## 3.2 CAMPAIGNS

**Purpose.** Bulk marketing email to a lead segment, with tracking, bounce handling and CASL suppression.

**Roles.** Agent + CRM + Admin + Super Admin (`campaigns: edit`). `crm`, `manager` and `admin` additionally hold `campaigns.brokerage-audience`, letting them select across the brokerage; an agent is capped at their own book.

**Workflow.**
```
Pick a template (built-in or own)  → set audience filters → live preview (count + 5 samples)
  → POST /api/campaigns
     → resolveRecipients: scope → filters → unsubscribed=false → email shape → dedupe → suppression list
     → cap at MAX_RECIPIENTS (300)
     → campaign row + recipient rows (each with a 24-byte token) written BEFORE any send
     → [scheduled?] status='scheduled', dispatcher claims it atomically when due
     → deliver(): per-recipient claim (WHERE status='pending'), MX check, personalise, rewrite links,
       inject pixel + unsubscribe, send, mark, per-domain throttle (400ms)
     → bounce classification: hard → suppress + count; soft → retry ≤N with backoff; unknown → our fault
     → final status: completed | partial | failed  (sending while anything is deferred)
     → campaignCompleted / campaignFailed notification to the owner
Recipient side
  → open pixel → campaigns.opened; link click → campaign_clicks + campaigns.clicked
  → unsubscribe (GET link + RFC 8058 one-click POST) → email_suppressions + leads.unsubscribed
```

**Classification: PARTIALLY COMPLETED — with one security defect.**

Genuinely strong: the claim-before-send protocol, the campaign-level atomic claim for scheduled sends, per-domain throttling, the honest `partial` status, the bounce taxonomy, the tracking-health probe.

Gaps:
- **No campaign edit endpoint at all.** `POST` (create+send), `GET`, `DELETE`, `POST /:id/cancel`. A campaign cannot be edited, and a *draft* cannot be sent.
- **`cancelScheduled` sets `status: 'draft'` — and nothing can ever send a `draft`.** The resume sweep looks for `sending`; the dispatcher looks for `scheduled`. A cancelled campaign is a dead row with orphan recipient rows; the only exit is delete. **F-04.**
- **No audit-trail row is written for any campaign action** — not create, not send, not delete, not template CRUD, not suppression removal (that one only writes a `log.warn`). **F-05.**
- `MAX_RECIPIENTS = 300`, while the service's own comments reference a 512-lead brokerage list. A brokerage-wide send is impossible in one campaign.
- **F-01** (template leak) and **F-06** (vocabulary divergence) below.

---

## 3.3 META (Facebook / Instagram lead ads)

**Purpose.** Import lead-form submissions from each agent's own Meta account.

**Classification: COMPLETED.** This is the most complete integration in the CRM.

Verified: OAuth with signed single-use `state`; AES-encrypted tokens never returned to the browser; `x-hub-signature-256` HMAC on the webhook compared in constant time; long-lived token expiry tracking with a reconnect warning; per-app Graph budget (`meta_api_budget`) because Meta rate-limits per app not per user; paginated cursor walk; `META_FIELD_LIMITS` truncation so one over-long answer cannot lose a paid lead; `meta_raw` capped and retention-limited (90 days) for PIPEDA; a form can be held by exactly one agent; cross-book matching deliberately disabled; data-deletion callback; scheduled poll as a backstop for a dead webhook; webhook-health view.

Notes:
- Assignment is `assignee(ctx) = ctx.userId` — **always the connecting agent**. There is no routing rule engine.
- All Meta leads land as `lead_status: 'cold'`, `lead_source: 'meta'`, hardcoded.
- **F-11:** `parseSignedRequest` (data deletion) verifies with `webhookSecret()`, which falls back to `appSecret()`. Meta signs `signed_request` with the **app secret**. If `META_WEBHOOK_SECRET` is set to anything other than the app secret, every data-deletion request is silently rejected as invalid.

---

## 3.4 CALENDAR

**Purpose.** Appointments, showings, viewings, open houses, follow-ups, calls, inspections, closings, tasks — per user, per area.

**Classification: PARTIALLY COMPLETED.**

Working: CRUD with optimistic-concurrency `version`; recurrence (daily/weekly/monthly, `this`/`series` scopes with a real self-FK); conflict detection; Canadian statutory + festival holidays computed on request; two-way Google sync with a retry sweep and back-off; reminders at 24h and 1h with per-(event, lead-time) idempotency, retry, and three delivery channels; web push with VAPID; analytics; AI follow-up suggestions.

**F-02 — the timezone model is missing.** `date` is a `DATE` and `time` is a `VARCHAR(8)` — a naive wall-clock with no zone. Three places convert it to an instant using **the server process's local timezone**:
- `googlePayload()` → `new Date(\`${day}T${time}:00\`).toISOString()` ([`google-calendar-sync.service.ts:501-510`](server/src/google/google-calendar-sync.service.ts#L501-L510)). The `timeZone: tz` field alongside it is ignored by Google because `dateTime` already carries a `Z` offset.
- `applyGoogleEvent()` → `start.getFullYear()/getHours()` on the pulled instant (same file, ~L226).
- `EventReminderService.startOf()` → same construction.

`TZ=America/Toronto` is set in `.env.example` and the deployment guide, so the deployed system is *currently* correct. Two real consequences remain: (a) any container/host where `TZ` is unset or wrong silently shifts every appointment and every reminder by the offset, with no error anywhere; (b) CRM Settings offers agents `America/Vancouver`, `America/Edmonton`, `America/Halifax`, `America/St_Johns` and `UTC` as a personal timezone, and **that preference is read by nothing** — an agent in BC sees and syncs Toronto times.

**F-03 — the reminder sweep can silently skip appointments.** `dueEvents()` applies `take: MAX_PER_SWEEP` (200) in SQL **before** the in-JS band filter. On a brokerage with more than 200 reminder-enabled events inside the two-day window, the events past the 200th never receive a reminder — and nothing reports it.

---

## 3.5 CRM SETTINGS

**Purpose.** Personal profile; per-user or brokerage-wide preferences; brokerage email settings + trigger master switch; advanced one-off client emails; referral codes; staff broadcasts; integration status.

**Classification: PARTIALLY COMPLETED — a large proportion of this screen is non-functional.**

Working: personal profile (name/username/email/phone, with case-insensitive uniqueness and a namesake check); brokerage `auto_send_enabled` master switch (now actually enforced); the five advanced emails (wedding / seasonal / promotional / referral / custom), each gated on the sender's own trigger, restricted to real leads the caller may contact, opt-out-checked against *both* `email_suppressions` and `leads.unsubscribed`, sent from a CRM-scoped mailbox, and logged; referral codes validated against the table with usage counting under a `lt: max_usage` guard; broadcasts with a per-sender advisory lock, background delivery, progress and boot-time reconciliation.

Non-functional (detail in Part 4): `notifications` (6 toggles), `preferences` (5 values), `templates` (5 trigger templates incl. `daysBefore`), `emailSettings.replyTemplate / autoSync / autoResponder / forwardingAddress`, and `crm_email_settings.smtp_host / smtp_port / smtp_user / admin_email`.

**F-07 — the Integrations card reports Google Calendar as unavailable.** `CrmSettingsService.integrations()` returns, hardcoded:
> `google_calendar: { connected: false, detail: 'Not available — Google Calendar OAuth was not part of the migrated code and needs Google API credentials.' }`

There is a complete, working Google Calendar integration (`server/src/google/`, 15 files, two-way sync, retry sweep, per-area connections). The card is stale and actively tells administrators that a shipped feature does not exist. `WORKING BUT INCORRECT`.

**F-08 —** the same method counts `mail_accounts` **unscoped**, so any user with `settings: view` is shown the brokerage's total account count including other areas and other people's accounts.

---

## 3.6 INBOX

**Classification: PARTIALLY COMPLETED — read-only.**

The controller exposes exactly four operations: list, sync-one-account, get-one, mark-seen. **There is no reply, no forward, no compose, and no delete.** IMAP mail is pulled, linked to a lead where the address matches (`inbound_emails.lead_id`), retention-swept, and displayed. Outbound mail goes through entirely separate paths (lead email, campaigns, advanced emails). The CRM Settings screen's `replyTemplate` and `autoResponder` fields exist for a reply feature that does not.

---

## 3.7 NOTIFICATIONS

**Classification: COMPLETED.**

`NotificationDispatcher` is the single decision point: recipient → preference → channel. Three channels (`in_app`, `email`, `push`), 13+ categories, per-(user, category, channel) rows with *absence = enabled*. Idempotency via a unique `(user_id, dedupe_key)` and `createMany({skipDuplicates})` — deliberately, because a P2002 would abort the enclosing transaction and roll back the caller's real work. Readiness per (category, channel) is an honest `live | pending | unsupported` map rather than an aspirational one. Six CRM events are wired: `lead_new`, `lead_assigned`, `lead_meta`, `lead_task_due`, `campaign_completed`, `campaign_failed`.

**F-10 — campaign notification deep links are broken.** `CrmEventNotifier.campaignLink()` produces `/crm/campaigns/{id}`. The client route table registers `{ screen: 'campaigns', paths: [''] }` — there is **no `:id` route**; campaign detail is a modal on the list page. `/crm/campaigns/123` falls through `AreaFallback` to `StubPage`, which renders "Page — Coming soon." Every "Campaign finished" and "Campaign could not be completed" notification, in-app, by email and by push, links to a coming-soon page.

---

## 3.8 CRM DASHBOARD

**Classification: COMPLETED (with two presentation problems).**

Twelve aggregates in twelve queries (down from eighteen), all scoped through the *same* `liveLeadWhere` / `leadTaskScopeWhere` / `created_by_id` predicates the screens themselves use — the prior "tile says 512, screen says 0" class of bug has been closed and is regression-tested (`dashboard-parity.spec.ts`, `crm-dashboard-scope.spec.ts`). Cached 20s per (user, super-admin-flag), deliberately shorter than the 60s permission cache.

Problems:
- **"Leads by Stage" and "Lead Sources" tiles show `Object.keys(...).length` as the headline** — i.e. *how many distinct statuses exist* (typically 4 or 5), not a lead count. Read at a glance beside "Total Leads: 412", "Leads by Stage: 5" is misleading. `WORKING BUT INCORRECT (presentation)`.
- **The CRM dashboard has no filters and no date range at all.** Section 11 of the brief asks whether filters and date ranges work; there are none to work.

---

## 3.9 AUDIT TRAIL (CRM view)

**Classification: PARTIALLY COMPLETED.**

Reads `audit_logs` filtered by `domain` with three scopes (`default`/`area`/`shared`/`all`), with CSV/XLSX export at the same authorization as the listing, truncation reported in `X-Export-Rows` / `X-Export-Truncated`.

**What is actually written from the CRM:** Lead create/update/delete/bulk-delete/restore/purge/tag-delete/transfer; lead activity (email sent/failed, call placed, call deleted, recording attached, message deleted); Meta sync; CRM settings; CRM triggers (one row per switch, with old/new); AI disclosures.

**What is NOT written:** every campaign action; every campaign-template action; suppression removal; Meta connect/disconnect/form toggle; calendar events not linked to a transaction (`logToTransaction` returns early when `txnId` is null — so **CRM calendar changes are never audited**).

Consequently `auditDomain()` classifies the categories `Campaigns` and `Meta` as CRM, and the CRM audit filter offers them, but **no code path ever writes those categories** — two filter options that can never match anything. **F-05.**

---

# PART 4 — FIELD-BY-FIELD AUDIT

Legend: **FUNCTIONAL** / **PARTIAL** / **NOT FUNCTIONAL** / **NOT USED** / **DUPLICATE** / **LEGACY**.

## 4.1 `leads` (the core table)

| Field | Purpose | Input | Req. | What filling it does | Used where | Validation | Status |
|---|---|---|---|---|---|---|---|
| `id` | PK | auto | y | identity | everywhere | — | FUNCTIONAL |
| `name` | Who the lead is | text | **yes** | `{{LEAD_NAME}}`, search, export, notification wording, SMS/call TwiML | list, detail, campaigns, exports, audit | ≤255, required | FUNCTIONAL |
| `email` | Primary contact + dedupe key | email | **yes** | unique per book; campaign audience; lead email; suppression matching | everywhere | shape + ≤255 + per-book uniqueness (DB index + app check) | FUNCTIONAL |
| `phone` | Contact number | text | no | click-to-call, browser dialer, SMS destination, search | detail, SMS, voice | ≤64 | FUNCTIONAL |
| `phone_normalized` | Digits-only form | derived | no | Meta duplicate detection across formats | Meta sync | auto from `phone` | FUNCTIONAL |
| `lead_status` | Temperature | select | no | list filter, header counters, dashboard breakdown, **campaign audience** | list, dashboard, campaigns | vocabulary | FUNCTIONAL — but `closed` is unreachable from the campaign builder (**F-06**) |
| `lead_type` | Interest type | select | no | list filter, campaign audience | list, campaigns | vocabulary | FUNCTIONAL — `realtor` unreachable from campaigns (**F-06**) |
| `lead_source` | Channel (human-entered) | select | no | list filter, dashboard by-source, campaign audience | list, dashboard, campaigns | vocabulary | FUNCTIONAL — `website` unreachable from campaigns (**F-06**) |
| `source` | Provenance (system-written) | system | no | decides ownership on agent departure; `brokerageLeadWhere()` for transfers; drives the Meta panel | transfer, Meta panel | `manual｜import｜facebook_meta` | FUNCTIONAL |
| `client_type` | Buyer persona | select | no | list filter, campaign audience | list, campaigns | vocabulary | FUNCTIONAL |
| `lead_response` | Responsiveness | select | no | **list filter only** | list | vocabulary | PARTIAL — not a campaign filter, drives no automation |
| `lead_conversion` | Converted or not | select | no | **list filter only** | list | vocabulary | PARTIAL — no conversion report, no dashboard tile, no relationship to `lead_status='closed'` |
| `tags` | JSON array of labels | multi | no | list filter, campaign audience (`tags contains "X"`), bulk tag | list, campaigns | ≤50 tags, ≤64 chars each | FUNCTIONAL |
| `location` | Area of interest | text | no | search; **fallback for `{{PROPERTY_ADDRESS}}`** | list search, campaigns | ≤255 | FUNCTIONAL |
| `property` | Free-text property enquired about | text | no | search only | list search | ≤255 | PARTIAL |
| `notes` | Running summary | textarea | no | displayed only | detail | ≤20,000 | PARTIAL — **DUPLICATE** of the `lead_notes` table (dated, attributed, author-locked). Two note stores. |
| `gender` | Demographic | select | no | list filter only | list | vocabulary | PARTIAL — schema comment claims "segment campaigns"; it is not a campaign filter |
| `language` | Demographic | text/datalist | no | list filter only | list | ≤64 | PARTIAL — same |
| `religion` | Demographic | text/datalist | no | list filter only | list | ≤64 | PARTIAL — same. Also a **PIPEDA-sensitive category collected with no stated purpose** |
| `age` | Demographic | number | no | list filter (min/max) only | list | 0–120 | PARTIAL — **DUPLICATE** of `date_of_birth`; no code keeps them consistent |
| `date_of_birth` | Birthday | date | no | **nothing** | detail display | valid calendar date | **NOT FUNCTIONAL** — `birthdayWishes` was removed from `TRIGGER_KEYS`; no scheduler reads this column |
| `marriage_day` | Anniversary | date | no | **nothing** | detail display | valid calendar date | **NOT FUNCTIONAL** — `sendWeddingCongratulations` takes `weddingDate` from the request body and never reads this column |
| `property_preferences` | JSON array: budget, propertyType[], bedrooms, bathrooms, squareFootage, yearBuilt, lotSize, parking, locations[], features[] | rich form | no | **nothing beyond display** | detail display | array-of-objects | **NOT FUNCTIONAL** — no query, filter, campaign token, MLS match or automation reads it. Also **DUPLICATE** of the six token columns below |
| `property_address` | `{{PROPERTY_ADDRESS}}` | — | no | campaign personalisation | campaigns | ≤255 | **NOT FUNCTIONAL IN PRACTICE — no writer.** Not in the lead editor, not written by the Meta importer, not in the CSV import map. Only reachable by hand-crafted API call. Falls back to `location` |
| `property_price` | `{{PROPERTY_PRICE}}` | — | no | campaign personalisation | campaigns | ≤64 | **NOT FUNCTIONAL IN PRACTICE — no writer** |
| `bedrooms` | `{{BEDROOMS}}` | — | no | campaign personalisation | campaigns | ≤16 | **NOT FUNCTIONAL IN PRACTICE — no writer** (the editor's "Bedrooms" writes `property_preferences.bedrooms`, a different field) |
| `bathrooms` | `{{BATHROOMS}}` | — | no | campaign personalisation | campaigns | ≤16 | **NOT FUNCTIONAL IN PRACTICE — no writer** |
| `square_footage` | `{{SQUARE_FOOTAGE}}` | — | no | campaign personalisation | campaigns | ≤24 | **NOT FUNCTIONAL IN PRACTICE — no writer** |
| `key_features` | `{{KEY_FEATURES}}` | — | no | campaign personalisation | campaigns | ≤5,000 | **NOT FUNCTIONAL IN PRACTICE — no writer** |
| `assigned_to` | users.id working the lead | select | no | scope, notification, list filter, task assignment | everywhere | must be an existing user | FUNCTIONAL — **but see F-12**: not checked for `Active` status, `company_id`, or CRM module access |
| `owner_user_id` | Creator / brokerage-intake marker | system | no | scope; identity-lock; per-book email uniqueness | everywhere | — | FUNCTIONAL |
| `created_by` | Creator's name | system | no | display | detail | ≤255 | FUNCTIONAL (display) |
| `deleted_by` | Who binned it | system | no | recycle-bin display | recycle bin | ≤255 | FUNCTIONAL |
| `deleted_at` | Soft-delete marker | system | no | excludes from every live query | everywhere | — | FUNCTIONAL |
| `unsubscribed` / `unsubscribed_at` | CASL opt-out | system | no | excluded from every campaign audience; blocks one-off lead email; blocks advanced emails | campaigns, lead email, CRM emails | — | FUNCTIONAL |
| `message` | Meta free-text answers | Meta | no | Meta panel display | Meta screen, detail | ≤20,000 | PARTIAL (display only) |
| `budget` | Meta answer | Meta | no | Meta panel display | detail | ≤128 | PARTIAL (display only) — **DUPLICATE** of `property_preferences.budget` |
| `timeline` | Meta answer | Meta | no | display | detail | ≤128 | PARTIAL |
| `property_type` | Meta answer | Meta | no | display | detail | ≤128 | PARTIAL — **DUPLICATE** of `property_preferences.propertyType[]` |
| `custom_fields` | Unmapped Meta answers, JSON | Meta | no | **nothing** — never returned by `present()` | — | ≤20,000 | **NOT USED** — written, never read |
| `first_name` / `last_name` | Meta name parts | Meta | no | returned; notification wording via `nameOf()` | notifications | ≤128 | PARTIAL |
| `facebook_lead_id` | Meta submission id (unique) | Meta | no | dedupe on re-sync; notification dedupe key | Meta sync | unique | FUNCTIONAL |
| `facebook_form_id` / `facebook_page_id` | Meta provenance | Meta | no | Meta panel | detail | — | FUNCTIONAL (display) |
| `meta_page_name`, `meta_form_name`, `meta_campaign_id/_name`, `meta_adset_id/_name`, `meta_ad_id/_name` | Ad attribution | Meta | no | Meta panel display; `meta_campaign_id` is indexed | detail | — | PARTIAL — indexed for a report that does not exist; **no campaign-ROI report reads them** |
| `meta_created_at` / `meta_imported_at` | Submission vs import time | Meta | no | display | detail | — | FUNCTIONAL (display) |
| `meta_raw` | Untouched Graph payload | Meta | no | re-mapping/audit; capped at 20k chars; cleared after 90 days | — | — | FUNCTIONAL |
| `company_id` | Tenant | system | y | Prisma tenant extension | everywhere | — | FUNCTIONAL |

## 4.2 `lead_notes` / `lead_tasks` / `lead_showings` / `lead_calls` / `lead_messages` / `lead_emails`

All FUNCTIONAL. Notable field-level points:
- `lead_notes.pinned` — FUNCTIONAL (orders the list).
- `lead_tasks.assigned_to` — FUNCTIONAL, resolved to a name; note the reminder sweep and the dashboard both scope tasks **through the parent lead**, not through this column (documented, and the source of a previously-fixed tile/panel mismatch).
- `lead_calls.duration` / `outcome` / `notes` — FUNCTIONAL but **manually entered**; Twilio's status callback writes `status` and `provider_sid`, not `duration`. **UNVERIFIED whether duration is ever populated automatically.**
- `lead_messages.status` — the controller comment says "Set by hand — there is no delivery receipt", but `sms-public.controller.ts` *does* map Twilio status callbacks. **Stale comment**; behaviour is FUNCTIONAL when `TWILIO_PUBLIC_URL` is set.
- `calendar_events.reminder_sent` — LEGACY. Superseded by `calendar_event_reminders`; kept in step "so the column stops being a lie".
- `calendar_events.google_calendar_id`, `last_synced_to_google` — the schema doc-comment still says "nothing writes them yet". **Stale**: `google-calendar-sync.service.ts` writes both.

## 4.3 `crm_settings` (per user or global) — the largest non-functional cluster

| Field group | Keys | Status | Evidence |
|---|---|---|---|
| `notifications` | `emailAlerts`, `smsAlerts`, `leadNotifications`, `showingReminders`, `marketUpdates`, `documentAlerts` | **NOT FUNCTIONAL** | Repo-wide grep: these keys appear only in `crm-settings.constants.ts`, `crm-settings.service.ts` (store/validate) and `client/src/types/crmSettings.ts`. **No sender consults them.** The real preference store is the `notification_preferences` table + `NotificationDispatcher`. Two competing notification-preference systems, one of which does nothing. |
| `preferences` | `language`, `timeZone`, `currency`, `dateFormat`, `theme` | **NOT FUNCTIONAL** | No consumer anywhere. `timeZone` is the painful one — see **F-02**. `theme` does not switch the UI theme. `currency`/`dateFormat` do not affect any rendering. |
| `templates` | `birthdayWishes{enabled,daysBefore,template}`, `weddingGreetings`, `seasonalWishes`, `promotionalOffers`, `referralCodes` | **NOT FUNCTIONAL** | Stored and rigorously validated (`daysBefore` 0–365). `CrmAdvancedEmailService` builds every body from **hardcoded HTML** and never reads this JSON. `daysBefore` schedules nothing — there is no birthday scheduler. |
| `emailSettings.signature` | signature | **FUNCTIONAL** | Read by `CrmSettingsController.signature()`, sanitised, appended to all five advanced emails. Own → brokerage fallback. |
| `emailSettings.replyTemplate` | reply boilerplate | **NOT FUNCTIONAL** | Nothing reads it. There is no reply feature (Inbox is read-only). |
| `emailSettings.autoSync` | "Auto Sync" toggle | **NOT FUNCTIONAL** | Own comment admits it "records intent". IMAP polling (`imap-sync.service.ts`) runs on a global interval and does not consult it. |
| `emailSettings.autoResponder{enabled,message}` | auto-reply | **NOT FUNCTIONAL** | No consumer. |
| `emailSettings.forwardingAddress` | forwarding | **NOT FUNCTIONAL** | Validated as an email, then never read. |

## 4.4 `crm_email_settings` (brokerage row)

| Field | Status | Evidence |
|---|---|---|
| `auto_send_enabled` | **FUNCTIONAL** | Master kill switch, enforced first in `CrmAdvancedEmailService.dispatch()` |
| `template_toggles` | **FUNCTIONAL** | Brokerage defaults for the 5 triggers, inherited by users who have set nothing |
| `smtp_host` | **NOT FUNCTIONAL** | Validated hard (length, per-label hostname regex) — then never dialled. The service's own comment: *"nothing dials this value, because sending goes through `mail_accounts`."* |
| `smtp_port` | **NOT FUNCTIONAL** | Same |
| `smtp_user` | **NOT FUNCTIONAL** | Same |
| `admin_email` | **NOT FUNCTIONAL** | Stored; no code reads it |

## 4.5 `campaigns`

| Field | Status | Note |
|---|---|---|
| `name`, `subject`, `content`, `template_id`, `template_name`, `category` | FUNCTIONAL | Content is snapshotted at send so a delayed send delivers what was approved |
| `audience` | FUNCTIONAL | JSON snapshot of the filter, shown on the detail modal |
| `tags` | **NOT USED** | Accepted from the request, stored, never read back or filtered on |
| `status` | FUNCTIONAL | Actual values: `draft｜scheduled｜sending｜partial｜completed｜failed`. **Schema doc-comment lists only 4 and omits `scheduled` and `partial`** — stale |
| `total/sent/failed/opened/clicked/unsubscribed/bounced` | FUNCTIONAL | Note: the CRM dashboard's Campaigns tile shows `sent/opened/failed` only; `clicked`, `bounced` and `unsubscribed` never reach a dashboard |
| `tracking_base_url` | FUNCTIONAL | Persisted so a resume builds identical URLs |
| `scheduled_for` | FUNCTIONAL | UTC instant; past times treated as "now" |
| `created_by`, `created_by_id` | FUNCTIONAL | `created_by_id` is the authorization scope |

## 4.6 `campaign_recipients`

All FUNCTIONAL: `token` (24-byte, unguessable), `vars` (resolved personalisation, snapshotted), `status`, `error`, `opened/opened_at`, `clicked_at`, `unsubscribed/_at`, `bounced`, `bounce_type` (`hard|soft|unknown`), `retry_count`, `next_retry_at` (indexed `(status, next_retry_at)` for the sweep).

## 4.7 `calendar_events`

Everything is FUNCTIONAL except:
- `attendees` (VarChar 255, free text) — display only; no invitations sent, no linkage to users or leads. **PARTIAL**
- `contact_phone` / `contact_email` — display only; no click-to-call, no email from the event. **PARTIAL**
- `property_details` — display only. **PARTIAL**
- `reminder_sent` — **LEGACY** (see 4.2)

---

# PART 5 — BUILT BUT NOT USED / LOOKS COMPLETE BUT ISN'T

## 5.1 Built but not used

| Item | Where | Supposed to do | Why unused | Works? | Recommendation |
|---|---|---|---|---|---|
| CRM Settings → Notifications (6 toggles) | `crm_settings.notifications` | Control which alerts you get | Superseded by `notification_preferences` | Stores/reads correctly, drives nothing | **Remove from the UI.** Link to Notification Preferences instead |
| CRM Settings → Preferences (5 values) | `crm_settings.preferences` | Locale, timezone, currency, date format, theme | Never implemented | Stores correctly | **Connect `timeZone` (see F-02) or remove all five** |
| CRM Settings → Trigger templates (5 × copy + `daysBefore`) | `crm_settings.templates` | Per-trigger wording and scheduling | Bodies are hardcoded HTML | Stores/validates correctly | **Connect to `CrmAdvancedEmailService.shell()` or remove** |
| CRM Email Settings → SMTP host/port/user/admin email | `crm_email_settings` | Configure the CRM mail server | Sending goes through `mail_accounts` | Stores + validates | **Remove.** They imply a second mail configuration that does not exist |
| `emailSettings.replyTemplate / autoSync / autoResponder / forwardingAddress` | `crm_settings` | Inbox behaviours | Inbox is read-only | Stores | **Remove until the Inbox can reply** |
| `leads.custom_fields` | DB | Preserve unmapped Meta answers | Never returned by `present()` | Written | **Connect** — surface on the Meta panel of the lead detail |
| `leads.date_of_birth`, `leads.marriage_day` | DB + editor | Time greeting emails | No scheduler | Stored + displayed | **Connect** (a birthday/anniversary sweep is ~50 lines given the existing dispatcher) or drop from the editor |
| `leads.property_address/price/bedrooms/bathrooms/square_footage/key_features` | DB + campaign tokens | Personalise campaigns | **No UI writes them** | Read path works | **Connect** — add a "Campaign personalisation" section to the lead editor |
| `campaigns.tags` | DB | Label campaigns | Never read | Written | **Remove or connect to a campaign filter** |
| `TAG_OPTIONS` (8 hardcoded tags) | `campaign.constants.ts` | Tag picker | Merged with the live registry in the UI, so it injects 8 phantom tags that may match no lead | — | **Remove** — the `lead_tags` registry is the real source |
| `meta_campaign_id/_name`, `adset`, `ad` (indexed) | DB | Ad attribution reporting | No report exists | Written + indexed | **Build the report** — this is the highest-value unused data in the CRM |
| `reviews` screen permission + sidebar entry | permission catalog + `DeskLayout` | Client Reviews | Never built | — | **Hide the nav entry** until built |

## 5.2 Looks complete but isn't

| Appearance | Reality | Severity |
|---|---|---|
| CRM Settings shows an SMTP host/port/user form | Nothing dials it; mail goes through `mail_accounts` | P2 |
| CRM Settings shows six notification toggles | Drive nothing | P2 |
| CRM Settings shows a timezone selector | Drives nothing; calendar uses server `TZ` | P1 |
| CRM Settings → Integrations says "Google Calendar: Not available" | A full two-way Google Calendar sync ships and works | P2 |
| Sidebar shows "Client Reviews" | Opens a "Planned module" stub | P3 |
| Campaign notification says "Open it" | Links to a coming-soon page | P2 |
| Lead editor has Bedrooms/Bathrooms/Sq-Ft fields | They write `property_preferences` JSON, **not** the campaign token columns of the same name. `{{BEDROOMS}}` still sends blank | P2 |
| Campaign builder's Status dropdown | Cannot target `closed` leads; Source cannot target `website`; Type cannot target `realtor` | P2 |
| "Cancel" on a scheduled campaign | Leaves an unsendable `draft` with orphan recipient rows | P2 |
| Campaign template privacy ("private to the author, including from Super Admin") | The builder's own options endpoint lists **every** agent's templates including full body | **P0/P1** |
| Audit Trail offers "Campaigns" and "Meta" as CRM categories | Nothing ever writes them | P2 |
| Lead detail shows a rich Property Preferences block | Drives no matching, filtering, campaign or automation | P3 |

---

# PART 6 — FINDINGS REGISTER

### F-01 — Campaign templates leak across agents (and can be sent by anyone) · **P0**
`CampaignTemplatesService` documents and enforces that a template with a non-null `user_id` is *"private to them **whatever the viewer's role**"*, and a prior audit measured and fixed a Super Admin editing an agent's draft. Two other paths never got the filter:

1. [`campaigns.controller.ts:34-38`](server/src/campaigns/campaigns.controller.ts#L34-L38) — `GET /api/campaigns/options` selects `campaign_templates` with `where: { is_active: true, deleted_at: null }` and **no owner scope**, returning `id, name, subject, category, **content**`. Every agent's campaign-builder dropdown therefore contains every other agent's private, unsent template **including the full body**.
2. [`campaigns.service.ts:205`](server/src/campaigns/campaigns.service.ts#L205) — `createAndSend` resolves the template with `findFirst({ where: { id, deleted_at: null } })`, no owner scope. Any agent can send a colleague's private template to their own audience.

**Cause:** the scope rule lives in `CampaignTemplatesService.visibleWhere()`; these two queries hit Prisma directly and never call it.
**Fix:** inject `CampaignTemplatesService` (or export `visibleWhere`) and apply it in both places. One-line change each; add a spec beside `template-attachment-access.spec.ts`.
**Complexity:** Low.

### F-02 — No timezone model; the personal timezone setting drives nothing · **P1**
See §3.4. Event instants are constructed from a naive `date` + `time` in the **server process's** local zone in `googlePayload()`, `applyGoogleEvent()` and `EventReminderService.startOf()`. `TZ=America/Toronto` is documented, so the current deployment is correct — but (a) an unset/wrong `TZ` shifts every appointment and reminder silently, and (b) CRM Settings offers five other timezones that are read by nothing.
**Fix (staged):** (1) assert `TZ` at boot in `validate-config.ts` alongside the other production checks — cheap, closes the silent-failure mode; (2) store a real brokerage timezone in company settings and format with `Intl.DateTimeFormat`/a tz library rather than `new Date(string)`; (3) either honour `preferences.timeZone` per user or remove the control.
**Complexity:** (1) Low, (2)+(3) High.

### F-03 — Reminder sweep silently drops appointments past 200 · **P1**
[`event-reminder.service.ts:137-149`](server/src/calendar/event-reminder.service.ts#L137-L149): `take: MAX_PER_SWEEP` (200) is applied in SQL *before* the JS band filter. Over 200 reminder-enabled events in the two-day window ⇒ the tail never gets a reminder, with no log and no counter.
**Fix:** page the query, or filter the band in SQL, or at minimum log when the row count hits the cap.
**Complexity:** Medium.

### F-04 — Cancelling a scheduled campaign produces an unsendable draft · **P2**
[`campaigns.service.ts:461-479`](server/src/campaigns/campaigns.service.ts#L461-L479) sets `status: 'draft'`, `scheduled_for: null`. Nothing sends a `draft`: `CampaignResumeService` looks for `sending`, `dispatchScheduled` for `scheduled`, and there is no update endpoint. The row and its recipients are stranded.
**Fix:** either add a "send now / reschedule" action for `draft`, or make cancel delete the campaign, or rename the state to `cancelled` and say so on screen.
**Complexity:** Low–Medium.

### F-05 — Campaigns write nothing to the audit trail · **P1**
No `audit_logs` row is written for campaign create/send/delete, template create/edit/delete, or suppression removal (that one writes only `log.warn`). Sending marketing mail to hundreds of clients is the single highest-consequence CRM action and it leaves no trail. Under CASL the record is most of the defence. The `auditDomain()` map even reserves the categories `Campaigns` and `Meta` — the trail's UI offers them, and nothing ever writes them.
**Fix:** reuse `LeadAuditService.record` (or a sibling) at four call sites: `createAndSend`, `remove`, `cancelScheduled`, `removeSuppression`, plus the three template mutations.
**Complexity:** Low.

### F-06 — Two divergent copies of the lead vocabulary · **P2**
| Vocabulary | `leads/lead.constants.ts` | `campaigns/campaign.constants.ts` |
|---|---|---|
| `LEAD_STATUS` | hot, warm, cold, mild, **closed** | hot, warm, cold, mild |
| `LEAD_TYPE` | … , **realtor** | … (no realtor) |
| `LEAD_SOURCE` | google ads, meta, **website**, refferal, linkedin, youtube | google ads, meta, refferal, linkedin, youtube |

The campaign builder's dropdowns come from the campaigns copy, so **no campaign can be targeted at closed leads, website leads, or realtor leads** — and nothing tells the user those segments are missing.
**Fix:** delete the campaigns copy and import from `lead.constants.ts`.
**Complexity:** Low.

### F-07 — CRM Settings reports Google Calendar as unavailable · **P2**
See §3.5. Hardcoded `connected: false` with a message stating the integration "was not part of the migrated code", while `server/src/google/` implements it fully.
**Fix:** read `google_connections` for `(user, 'crm')` the way `MetaConnectionService` is read three lines above.
**Complexity:** Low.

### F-08 — Integrations card counts every mail account in the brokerage · **P3**
`this.prisma.mail_accounts.count()` with no `user_id` and no `scope` filter, shown to anyone with `settings: view`.
**Fix:** scope to the caller and to `scope: 'crm'`.
**Complexity:** Low.

### F-09 — Two lead routes bypass module-access enforcement · **P3**
`GET /api/leads/books` and `POST /api/leads/transfer-ownership` carry no `@Screen`, and `ScreenGuard` performs the *module* check (CRM assigned + licensed) inside the same block it skips. A Desk-only Super Admin can call both. Authorization itself is enforced in `LeadTransferService`, so this is not an access hole — it is an enforcement gap that will matter when the subscription model is used.
**Fix:** add `@Screen('lead', 'view')` / `@Screen('lead', 'edit')`.
**Complexity:** Low.

### F-10 — Campaign notification deep links are dead · **P2**
See §3.7. `/crm/campaigns/{id}` has no route.
**Fix:** either register a `:id` route that opens the detail modal, or change `campaignLink()` to `/crm/campaigns` (list) — the second is a one-line honest fix.
**Complexity:** Low.

### F-11 — Meta data-deletion callback verifies against the wrong secret · **P2**
`parseSignedRequest` uses `webhookSecret()`, which is `META_WEBHOOK_SECRET || FACEBOOK_WEBHOOK_SECRET || appSecret()`. Meta signs `signed_request` with the **app secret**. Unset webhook secret ⇒ works by accident; set to a different value ⇒ every deletion request is rejected as invalid, and Meta's app-review requirement is silently unmet.
**Fix:** use `appSecret()` explicitly in `parseSignedRequest`.
**Complexity:** Low.

### F-12 — Lead assignment does not check the assignee is usable · **P2**
[`leads.service.ts:1086`](server/src/leads/leads.service.ts#L1086): `users.findFirst({ where: { id: uid } })` — no `status: 'Active'`, no `company_id`, no CRM-module check. A lead can be assigned to a deactivated account, which then receives no notification (`NotificationDispatcher.recipient` drops Inactive users) and can never open it. The lead effectively disappears from everyone but its owner.
**Fix:** add `status: 'Active'` and a `user_modules` check; the options endpoint already filters to Active, so this only closes the direct-API path.
**Complexity:** Low.

### F-13 — One-off lead email ignores the suppression list · **P2**
`LeadActivityService.sendEmail` checks `lead.unsubscribed` but **not** `email_suppressions`. `CrmAdvancedEmailService.optedOut()` correctly checks both and explains exactly why: *"An address may carry one without the other."* A hard-bounced or unsubscribed address that was never flagged on the lead row can still be emailed one-to-one from the lead screen.
**Fix:** call the same two-source check.
**Complexity:** Low.

### F-14 — Two independent "this lead is done" fields · **P3**
`lead_status = 'closed'` and `lead_conversion = 'converted'` are set independently, neither implies the other, and no report or dashboard reads `lead_conversion`. There is no conversion-rate metric anywhere in the CRM.
**Fix:** decide which is authoritative; add a conversion tile/report.
**Complexity:** Low (decision) / Medium (report).

### F-15 — SMS has no opt-out enforcement · **P2**
`LeadActivityService.addMessage` sends via Twilio with no check of `leads.unsubscribed` or `email_suppressions`, and nothing records a STOP reply as an opt-out (the constant map only *explains* Twilio error `21610`). Carrier-level STOP handling applies for US/CA numbers, and a Twilio Messaging Service handles opt-outs if configured — but with a bare `TWILIO_FROM_NUMBER` the application has no record. CASL covers SMS.
**Fix:** refuse to send to `unsubscribed` leads; on error `21610`, write an opt-out record.
**Complexity:** Low.

### F-16 — Campaign audience resolution loads every matching lead into memory · **P2 (performance)**
`resolveRecipients` issues `findMany` with **no `select` and no `take`**, then filters in JS and caps at `MAX_RECIPIENTS` afterwards. For a `campaigns.brokerage-audience` holder on a 40,000-lead database with a loose filter, that is the whole table — every column including `meta_raw` (up to 20 KB each) — pulled into Node. And `preview()` does exactly the same work just to show a count and five names, **on every keystroke-debounced filter change** in the builder.
**Fix:** `select` only the ~10 needed columns; add a `take` above `MAX_RECIPIENTS`; make `preview` a `count()` plus a `take: 5`.
**Complexity:** Low. **Highest value-per-line fix in the report.**

### F-17 — `campaigns.get` returns every recipient row · **P3 (performance)**
The detail modal loads all recipients and filters client-side. At the 300 cap that is tolerable; if the cap is ever raised it is not.

### F-18 — `deleteTag` removes a shared registry entry for the whole brokerage · **P3**
Any user with `lead: edit` (every agent) can `DELETE /api/leads/tags?tag=X`, which removes the tag from **their own** leads (correctly scoped) and deletes the registry row **for everyone**. Documented as deliberate; it is still an agent-level action with brokerage-wide effect on campaign segmentation. Audited, at least.
**Fix:** require `data.read-all` to delete a registry entry, or make it a soft "retire".

### F-19 — `tagLeads` performs N sequential updates outside a transaction · **P3**
`leads.service.ts` loops `prisma.leads.update` per lead. `deleteTag` right above it was rewritten to batch by tag-set inside a transaction precisely because of this; `tagLeads` was not. A failure mid-loop leaves a partial result and the returned count is right but the state is not atomic.

### F-20 — `{{AGENT_PHONE}}` ignores the phone the agent entered in CRM Settings · **P3**
`CampaignsService.agentPhone()` states *"Users have no phone column"* and resolves through the `agents` roster by name, then the brokerage number. `users.phone` **does** exist, is edited in CRM Settings → Personal Information, and **is** used by click-to-call (`initiateCall` reads `user.phone`). So the same number is authoritative for voice and ignored for campaigns.
**Fix:** prefer `users.phone`, fall back to the roster.

### F-21 — Stale documentation that will mislead the next reader · **P3**
- `calendar_events` schema comment: *"`google_calendar_id` / `last_synced_to_google` … nothing writes them yet"* — both are written.
- `campaigns.status` schema comment lists 4 states; 6 exist.
- `calendar_events.type`/`status` schema comments predate `inspection`, `closing`, `no-show`.
- `leads.gender/language/religion` comment: *"used to segment campaigns"* — they are not campaign filters.
- `LeadsController.addMessage`: *"The server does not send it"* — it does, when `send: true`.
- `StubPage.INFO` still describes `triggers`, `settings`, `inbox` and `favorites` as unbuilt.

---

# PART 7 — WORKFLOW TRACE RESULTS

| Workflow | Result |
|---|---|
| Manual lead → assign → notify → follow-up → close | **Works end to end.** Weak point: assignment notification only fires when `assigned_to` actually changed (correct); the previous assignee is never told (deliberate) |
| CSV import → dedupe → tag → campaign | **Works.** 50,000-row cap, 500-row batches each in its own transaction, `skipDuplicates` backed by a real unique index, per-field truncation, pollable job with progress. Strong |
| Meta lead → webhook → lead → notify | **Works.** Idempotent across webhook + poll via `dedupeKey: meta-lead:{metaLeadId}:{user}` |
| Meta lead → auto-assign to the right agent | **NOT IMPLEMENTED** — always the connecting agent |
| Website lead → CRM | **NOT IMPLEMENTED** — `lead_source: 'website'` exists as a *label*; there is no website intake endpoint, form or webhook |
| Google Ads lead → CRM | **NOT IMPLEMENTED** — `lead_source: 'google ads'` is a label only; the Google module is Calendar + Gmail, not Ads |
| Campaign build → preview → send → track → unsubscribe | **Works**, with F-01/F-04/F-05/F-06/F-16 attached |
| Campaign → schedule → cancel → resend | **BREAKS at "resend"** (F-04) |
| Appointment → Google → reminder → push | **Works**, with F-02/F-03 attached |
| Lead → appointment | **Works** — `calendar_events.lead_id`, scope-validated |
| Lead → duplicate detection → merge | **NOT IMPLEMENTED.** Duplicates are *prevented* per book by a unique index and reported as a validation error, but existing duplicates cannot be found or merged |
| Inbound email → thread → reply | **BREAKS at "reply"** — Inbox is read-only |
| Agent departs → leads reassigned | **Partially implemented.** `transfer-ownership` hands **unowned** brokerage leads to somebody (Super Admin only, audited). It deliberately cannot move an agent's own book, and `source = 'facebook_meta'` leads are excluded as personal. See `docs/AGENT-DEPARTURE-POLICY.md` |

---

# PART 8 — DATABASE & DATA INTEGRITY

**Good:**
- Every CRM table carries `company_id` and is filtered by a Prisma client extension; `tenancy.spec.ts` enforces the invariant.
- The functional unique index `(company_id, COALESCE(owner_user_id,0), lower(email))` is documented at length in the schema *because Prisma cannot express it*, and `leads-email-uniqueness.spec.ts` asserts it exists **in the connected database** — so a schema-only rebuild fails a test rather than production.
- Case-insensitive unique indexes on `users.email` / `users.username`, likewise undeclarable and likewise asserted.
- Cascades are deliberate and documented: lead purge cascades activity but `campaign_recipients.lead_id` is `SetNull` so campaign history survives; `calendar_events.recurrence_id` is `SetNull` so deleting a series detaches rather than deletes.
- Index coverage on the CRM hot paths is good: `leads(owner_user_id)` was added specifically because the `assigned_to OR owner_user_id` scope filter could not use either index alone.

**Risks:**

| Issue | Detail | Severity |
|---|---|---|
| `leads.tags` is a JSON array in a TEXT column | Filtering is `contains '"Tag"'` — a full scan, unindexable. At 40k+ leads every tag filter and every tag-targeted campaign scans the table | P2 |
| `leads.property_preferences` is JSON in TEXT | Unqueryable by design; would need JSONB to be useful | P3 |
| Duplicate/parallel fields | `age` vs `date_of_birth`; `notes` vs `lead_notes`; `budget` vs `property_preferences.budget`; `property_type` vs `property_preferences.propertyType`; `bedrooms`/`bathrooms`/`square_footage` columns vs the same keys inside `property_preferences` | P2 |
| Two notification-preference stores | `crm_settings.notifications` (dead) vs `notification_preferences` (live) | P2 |
| Two lead vocabularies | F-06 | P2 |
| `crm_broadcasts`, `crm_referral_codes`, `crm_email_log` unscoped on read | Any `settings: view` holder sees all of them | P3 |
| Hardcoded brand strings | `'Get Home Realty'` and `'info@gethomerealty.ca'` in `campaign-audience.service.ts`; `'Announcement from Get Home Realty'` and `'Sent to all active users of Transaction Desk'` in `crm-settings.service.ts`; `'GHR-'` referral prefix | P3 |
| Hardcoded statuses | Meta leads always `lead_status: 'cold'`, `lead_source: 'meta'` | P3 |
| `TENANT_ID` constant | `crm_email_settings` and `crm_trigger_settings` are looked up by the compile-time `TENANT_ID` rather than the request's tenant. Correct today (single brokerage); a landmine for the multi-tenant story the schema is being shaped for | P2 |
| Orphan risk | Cancelled campaigns keep `pending` recipient rows for ever (F-04) | P3 |

---

# PART 9 — SECURITY AUDIT

## 9.1 What was verified as sound

| Control | Implementation | Verdict |
|---|---|---|
| Authentication | Server-side sessions in Postgres (`connect-pg-simple`), `httpOnly`, `secure`, `sameSite`, `rolling` expiry, `trust proxy 1` | Sound |
| CSRF | Global `CsrfGuard` (Sanctum double-submit), safe methods exempt | Sound |
| MFA | TOTP + recovery codes + trusted devices + policies, `mfa-crypto.ts`, dedicated specs | Sound |
| Brute force | Per-account lockout (`account-lockout.service.ts`) that an attacker cannot escape by changing IP, layered under per-IP and per-identity throttles | Sound — the reasoning about NAT-shared office IPs is correct and unusual |
| Rate limiting | One global bucket keyed by user id (IP for anonymous), per-endpoint; strict overrides via `@Throttle` on sign-in, settings writes, broadcasts, Meta sync | Sound |
| Secrets at rest | `APP_KEY` AES-256; Meta tokens, Google refresh tokens, IMAP passwords all encrypted; boot refuses a production start with a bad/absent key | Sound |
| Webhook auth | Meta `x-hub-signature-256` and Twilio `X-Twilio-Signature`, both `timingSafeEqual`, both computed over the **raw** bytes (`rawBody: true` in `main.ts`) | Sound |
| Headers | `helmet` with `crossOriginResourcePolicy: cross-origin` (justified for the tracking pixel and logos), HSTS, nosniff, CSP | Sound |
| CORS | Explicit origin allowlist + credentials; production boot validates it | Sound |
| Production config | `assertProductionConfig` refuses to start on weak `SESSION_SECRET`, non-secure cookies, `SameSite=None` without `Secure`, bad `APP_KEY`, ephemeral tunnel URLs | Sound — better than most |
| IDOR | Systematically closed: every lead activity endpoint calls `assertLead`; both "missing" and "forbidden" answer an identical 404 so ids cannot be probed; calendar `lead_id`/`transaction_id` validated through the caller's scope | Sound, with the exception below |
| File upload | Call recordings allowlisted to 10 audio MIME types, 8 MB cap, served `inline` with `nosniff`, DB `CHECK` ensuring exactly one of disk/blob | Sound |
| XSS | Signatures and custom email bodies sanitised (script/iframe/object/embed/on* /javascript:) rather than escaped; broadcast bodies escaped; notification titles/bodies escaped; React escapes by default | Sound |
| SQL injection | Prisma everywhere; two `$executeRaw` uses are parameterised tagged templates | Sound |
| Data export restriction | Lead export requires `lead: **edit**`, not `view` — an explicit decision that "trusted to look" ≠ "trusted to extract". Accounting and Documentation lose export by design | Sound and unusually thoughtful |
| AI privacy | `ai-disclosure.service.ts` writes an `AI`-category audit row (domain `common`) for every provider call, so "what have we sent to AI vendors, and about whom" is answerable | Sound |

## 9.2 Remaining security risks

| # | Risk | Severity |
|---|---|---|
| F-01 | Cross-agent disclosure of private campaign template bodies + ability to send them | **P0** |
| F-09 | Two lead routes skip module-access enforcement | P3 |
| F-11 | Meta data-deletion verified against a possibly-wrong secret | P2 |
| F-12 | Leads assignable to deactivated/foreign accounts via direct API | P2 |
| F-13 | One-off lead email bypasses the suppression list (compliance) | P2 |
| F-15 | SMS has no application-level opt-out (compliance) | P2 |
| F-05 | No audit trail for mass email (compliance evidence) | P1 |
| — | `GET /api/leads/options` returns **every active user** (id, name, role) to anyone with `lead: view`. Needed for the assignee dropdown; still a full staff roster to the lowest-privileged role | P3 |
| — | `crm_broadcasts`, `crm_referral_codes` readable unscoped by any `settings: view` holder | P3 |
| — | Any `settings: edit` holder can email **every active user** in the brokerage (broadcast). Rate-limited and audited; `manager` holds `settings: view` so cannot. Correct today, fragile if `settings: edit` is ever granted more widely | P3 |

**UNVERIFIED – REQUIRES MANUAL TESTING:** actual session fixation behaviour on privilege change; CSP report-only vs enforce in the deployed build; whether `COOKIE_DOMAIN` is set correctly for the production host; penetration testing of the Meta OAuth `state` replay window.

---

# PART 10 — PRODUCTION READINESS

## 10.1 What is already production-shaped

- Long work is **off the request thread**: CSV import (job + polling), campaign delivery, broadcasts, exports.
- **Interrupted work is reconciled at boot**: `reconcileInterruptedBroadcasts()` closes rows stuck in `sending`; `CampaignResumeService` resumes `sending` campaigns from the `pending` recipients only.
- **Multi-process safety** is real, not aspirational: atomic `UPDATE … WHERE status = ?` claims at both campaign and recipient level, an in-process `delivering` set, `RUN_SCHEDULERS` defaulting to *off* under pm2 (the asymmetric-failure argument is correct), `clusterTick` via Redis with a documented fail-open.
- **Retry with back-off** for soft bounces, Google pushes, calendar reminders, and Twilio.
- **Health endpoints** including `GET /api/health/workers`, which reports a stale scheduler within minutes.
- **Structured logging** with a per-request correlation id; a global error filter that logs without changing the wire shape.
- Graceful shutdown handlers (IMAP sockets, Prisma, session pool).
- Documented DR (`docs/DISASTER-RECOVERY.md`), operations (`docs/OPERATIONS.md`) and deployment (`docs/VPS-DEPLOYMENT.md`) runbooks.

## 10.2 Production risk register

| # | Risk | Module | Prob. | Impact | Production consequence | Prevention | Solution | Pri |
|---|---|---|---|---|---|---|---|---|
| R1 | Audience resolution loads the whole lead table | Campaigns | **High** | High | Node heap spike / OOM on a brokerage-wide preview; the builder does this per filter change | Load test at 40k leads | `select` + `take`; `count()` for preview (**F-16**) | P1 |
| R2 | Reminder sweep caps at 200 rows before filtering | Calendar | Med | High | Agents silently miss appointment reminders as volume grows | Alert when the cap is hit | Page the query (**F-03**) | P1 |
| R3 | `TZ` unset or wrong on the host | Calendar | Low | **Critical** | Every appointment and reminder shifts by hours; Google copies shift too; no error anywhere | Assert `TZ` at boot | **F-02** step 1 | P1 |
| R4 | Tag filtering is an unindexable substring scan on TEXT | Leads/Campaigns | High | Med | Every tag filter and tag-targeted campaign full-scans `leads` | — | Normalise tags to a join table, or JSONB + GIN | P2 |
| R5 | Campaign delivery is 400 ms/recipient in-process | Campaigns | High | Med | 300 recipients ≈ 2 min held in the API process; a deploy mid-send leaves rows `sending` (detectable, not auto-recovered per-recipient) | — | Move delivery onto the existing `QueueModule` (BullMQ driver already present) | P2 |
| R6 | No audit trail for mass email | Campaigns | High | High | A CASL complaint cannot be answered from the system | — | **F-05** | P1 |
| R7 | Meta Graph app-level rate limit | Meta | Med | Med | Lead sync stops brokerage-wide | `meta_api_budget` already caps collective spend at 600/hr | Already mitigated; monitor `meta_sync_history` | P3 |
| R8 | SMTP provider daily send limits | Campaigns/Broadcast | Med | Med | A broadcast to hundreds of staff plus campaigns can trip a Gmail/M365 daily cap; classified `unknown` bounce, address untouched (correct) | — | Document per-account limits; consider a transactional ESP | P2 |
| R9 | Campaign open tracking silently zero | Campaigns | Med | Low | `CAMPAIGN_PUBLIC_URL` unset/private/ephemeral ⇒ every campaign reports 0 opens and reads as a dead list | **Already mitigated** — `tracking-health` actively fetches the pixel and detects private hosts, tunnels and plain http | Keep the banner visible | P3 |
| R10 | `email_suppressions` grows unbounded and is checked with `IN (…)` per send | Campaigns | Low | Low | Slow parameter list at scale | Indexed unique on `email` | Batch or use a join | P3 |
| R11 | `campaign_recipients` grows without retention | Campaigns | Med | Low | Table growth; `(status, next_retry_at)` index already added for the sweep | — | Add a retention policy for completed campaigns | P3 |
| R12 | Cancelled campaigns leave permanent `pending` recipients | Campaigns | Med | Low | The retry sweep repeatedly considers rows that will never send | — | **F-04** | P2 |
| R13 | In-process schedulers under pm2 without `RUN_SCHEDULERS` | All | Low | High | Duplicate sends, or no sweeps at all | Default is off under a process manager; `/api/health/workers` reports staleness | Already mitigated; keep the health check alerted | P2 |
| R14 | `meta_raw` up to 20 KB per lead | Meta | Med | Low | Row bloat; pulled into memory by R1 | 90-day retention already implemented | Keep retention on | P3 |
| R15 | Lead detail loads **all** notes, tasks, showings, calls, messages and emails in one query | Leads | Med | Med | A long-lived lead's detail payload grows without bound | — | Paginate the activity panels the way the dashboard feeds already are | P2 |
| R16 | Google Calendar API quota | Calendar | Low | Med | Sync stalls; already has back-off, attempt caps and a retry sweep | Already mitigated | Monitor `google_sync_error` | P3 |

**UNVERIFIED – REQUIRES MANUAL TESTING:** backup schedule and restore drill; monitoring/alerting wiring (the health endpoints exist — whether anything watches them is outside the code); connection-pool sizing under real concurrency; actual behaviour of the BullMQ driver in production (the in-process driver is the default path).

---

# PART 11 — UI / UX PROBLEMS

| Problem | Where | Severity |
|---|---|---|
| "Leads by Stage" / "Lead Sources" tiles headline a *count of categories*, not a lead count | CRM Dashboard | P2 |
| CRM Dashboard has no filters and no date range | CRM Dashboard | P3 |
| Campaign notification "Open it" → coming-soon page | Notifications | P2 |
| "Client Reviews" in the sidebar → "Planned module" stub | Sidebar | P3 |
| Lead editor's Bedrooms/Bathrooms/Sq-Ft do not populate the identically-named campaign tokens | Lead editor | P2 |
| Campaign builder cannot target `closed` / `website` / `realtor` segments, silently | Campaign builder | P2 |
| "Cancel" on a scheduled campaign has no follow-up action | Campaigns | P2 |
| CRM Settings shows an SMTP form, six notification toggles, five preferences and five trigger templates that do nothing | CRM Settings | P2 |
| CRM Settings says Google Calendar is unavailable when it is not | CRM Settings | P2 |
| Two "notes" concepts on the lead screen (the `notes` textarea vs Notes history) with only a help-text distinction | Lead editor | P3 |
| Inbox offers no reply, while CRM Settings offers a "reply template" and an "auto-responder" | Inbox / Settings | P2 |
| `MAX_RECIPIENTS = 300` is only discovered *after* building an audience | Campaign builder | P3 |

**Positive UX notes worth preserving:** the export endpoint reports `truncated` rather than silently capping; the recycle bin is paginated rather than silently capped at 200; the tracking-health banner; validation that refuses an unusable value instead of silently substituting a default (`timeZone: 'Mars/Olympus'` used to store `America/Toronto` and answer 200); the duplicate-broadcast guard with a per-sender advisory lock.

**Not assessed:** mobile/responsive behaviour, keyboard accessibility, screen-reader support — **UNVERIFIED – REQUIRES MANUAL TESTING.**

---

# PART 12 — ERROR HANDLING

| Failure | Behaviour | Verdict |
|---|---|---|
| SMTP down mid-campaign | Per-recipient classification; "no active SMTP account" short-circuits the remaining recipients rather than hammering; counted as `unknown`, **not** as a bounce, so a bad password does not look like a dead list | Excellent |
| Server restart mid-campaign | Recipients are claimed before sending, so the worst case is one message *not* sent rather than one sent twice; `CampaignResumeService` picks it up | Excellent |
| Server restart mid-broadcast | `reconcileInterruptedBroadcasts()` at boot marks it `partial`/`failed`, keeping the real counters | Excellent |
| Google unreachable | Never fails the calendar save; `google_sync_error` + attempts + back-off; a retry sweep recovers | Excellent |
| Meta token expired | Code 190/463/467 → `markTokenDead`, UI reconnect banner, one alert per 24h | Excellent |
| Notification channel fails | Per-channel result; never propagates to the caller's business operation; in-app dedupe uses `ON CONFLICT DO NOTHING` specifically so a duplicate cannot abort the caller's transaction | Excellent |
| Invalid data submitted | 422 with `{message, errors}` throughout; several previously-500 paths (over-length names, NUL bytes, bad ports) were converted to clean 400/422 | Good |
| Duplicate submission | Lead email P2002 → a 422 that distinguishes "in your recycle bin" from "just created by another request"; broadcasts guarded by an advisory lock; campaign recipients by a conditional claim | Excellent |
| Concurrent calendar edit | `version` column, refused as a conflict | Good |
| Audit write fails | Swallowed and logged — a business action never fails because auditing did | Reasonable, but it means **audit gaps are invisible**. `observability/audit-health.ts` exists; **UNVERIFIED** whether anything alerts on it |
| Campaign delivery throws | Caught, status → `partial`, owner notified without technical detail (which stays in the log) | Excellent |
| Client loses connection | **UNVERIFIED** |

---

# PART 13 — FINAL REPORT

## A. Executive summary

The CRM is a **substantially complete, well-engineered product with a small number of real defects and one large honesty problem.**

The engineering quality of the core is high and, in places, unusually so: the authorization model is expressed as capabilities rather than role comparisons; lead privacy is enforced *inside the queries* by a single shared predicate that the dashboard and the screens both call; the campaign send loop claims each recipient before sending because a duplicate in a client's inbox is treated as worse than a missed send; notification idempotency uses `ON CONFLICT DO NOTHING` specifically so a duplicate cannot roll back the caller's real work. Multi-process safety, retry/back-off, boot-time reconciliation and production config validation are all present and correct.

Against that, three things stand out:

1. **One P0.** The campaign builder's options endpoint and the send path both bypass the template ownership rule that the templates service documents and enforces everywhere else — leaking every agent's private template bodies to every other agent, and letting anyone send them (**F-01**).
2. **A large "collected but does nothing" surface.** Roughly **20 fields and 4 whole settings sections** are stored, validated, displayed and drive nothing: six campaign-personalisation columns with no writer in the UI, five brokerage SMTP fields nothing dials, six notification toggles superseded by a different table, five user preferences (including a timezone that the calendar ignores), and five trigger templates whose text is never used. This is the single biggest gap between what the CRM appears to do and what it does.
3. **Structural absences**, each of which will be read as a bug by users: no campaign editing, no path out of a cancelled campaign, no lead merge, no auto-assignment, no website/Google-Ads intake, a read-only Inbox, no audit trail for mass email, and no timezone model.

### Overall completion — derived, not asserted

Weighted by the code actually present against what each module needs to be operationally complete:

| Module | Weight | Completion | Basis |
|---|---|---|---|
| Leads (core + activity) | 25% | 85% | Everything works; no merge, no auto-assign, ~14 dead fields |
| Campaigns | 20% | 70% | Send engine excellent; no edit, no draft path, no audit, one P0, vocabulary split |
| Meta | 10% | 95% | Complete; only the data-deletion secret and no assignment routing |
| Calendar | 15% | 80% | Complete feature set; no timezone model, sweep cap |
| CRM Settings | 10% | 45% | Advanced emails + triggers + broadcasts work; four sections are inert |
| Notifications | 8% | 90% | Complete; one broken deep link |
| Inbox | 5% | 50% | Read-only |
| Dashboard | 5% | 85% | Correct and scoped; two misleading tiles, no filters |
| Audit trail | 2% | 70% | Reads well; campaigns and CRM calendar unaudited |

**Weighted CRM completion: ≈ 78%.**
Weighted by *functioning* rather than *present* code — i.e. discounting every stored-but-inert field — the honest figure is **≈ 74%**.

### Overall functionality status
**PARTIALLY COMPLETED — operationally usable today for lead management, Meta intake, calendar and campaigns, with the P0 closed.**

### Major risks
P0 template disclosure; no audit trail for mass email (CASL evidence); memory/scan behaviour of audience resolution at brokerage scale; timezone fragility; reminder sweep cap.

### Major missing features
Campaign editing · lead merge/duplicate management · auto-assignment · website & Google Ads intake · Inbox reply · conversion reporting · Meta ad-attribution reporting · Client Reviews.

### Production readiness
**Ready for a controlled production run** once P0 and P1 are closed, on a host with `TZ` set and `RUN_SCHEDULERS` correct. The operational scaffolding (health checks, reconciliation, retries, structured logs, DR docs) is already better than typical for this stage. What is not proven from code alone: backups, restore drills, and whether anything is actually watching the health endpoints.

### Recommended priority
`F-01` → `F-16` → `F-05` → `F-02(step 1)` → `F-03` → then the dead-field cleanup, which is mostly deletion and will make the product read honestly.

## B. Module completion matrix

| Module | Status | % | Working | Partial | Broken | Missing | Security risk | Production risk |
|---|---|---|---|---|---|---|---|---|
| Leads — core | PARTIAL | 90 | CRUD, scope, search, filters, export, bin, transfer | ~14 inert fields | — | merge, auto-assign, scoring | Low (F-12) | Med (R15) |
| Leads — activity | COMPLETED | 95 | notes, tasks, showings, calls, SMS, email, recordings, AI drafts | call `duration` manual | — | — | Low (F-13, F-15) | Low |
| Leads — import | COMPLETED | 95 | batched, transactional, resumable, capped, truncating | — | — | scheduled/recurring import | Low | Low |
| Campaigns — send | PARTIAL | 75 | audience, personalise, track, bounce, retry, schedule | — | cancel→draft dead end | edit, A/B, drip | **P0 (F-01)** | **High (R1, R5)** |
| Campaigns — templates | PARTIAL | 80 | CRUD, attachments, ownership | — | — | — | **P0 (F-01)** | Low |
| Campaigns — suppression | COMPLETED | 90 | list, scoped, remove, auto-suppress | — | — | — | Low | Low |
| Meta | COMPLETED | 95 | OAuth, webhook, poll, budget, health, deletion | — | — | assignment routing | Low (F-11) | Low (R7) |
| Calendar | PARTIAL | 80 | CRUD, recurrence, conflicts, holidays, Google, reminders, push | attendees/contact fields display-only | — | timezone model | Low | **High (R2, R3)** |
| CRM Settings | PARTIAL | 45 | profile, master switch, 5 advanced emails, referral codes, broadcasts | — | Google card wrong | — | Low (F-08) | Low |
| Triggers | COMPLETED | 95 | per-user, 3-level resolution, fail-closed, per-switch audit | — | — | — | Low | Low |
| Notifications | COMPLETED | 90 | dispatcher, 3 channels, prefs, centre, dedupe | — | campaign deep link | — | Low | Low |
| Inbox | PARTIAL | 50 | list, sync, read, lead-link, retention | — | — | reply/compose/delete | Low | Low |
| Dashboard | COMPLETED | 85 | 12 scoped aggregates, cached, parity-tested | 2 misleading tiles | — | filters, date range | Low | Low |
| Audit trail | PARTIAL | 70 | read, filter, export, truncation reporting | — | — | campaign + CRM calendar coverage | Low | **Med (R6)** |
| Client Reviews | NOT IMPLEMENTED | 0 | — | — | — | everything | — | — |

## C. Complete / partial / pending

### COMPLETED
Lead CRUD + privacy scoping · lead activity (6 kinds) · CSV import · lead export (with truncation reporting) · recycle bin · brokerage lead transfer · tagging · Meta integration (OAuth, webhook, poll, budget, health, data deletion) · campaign send engine · bounce classification + suppression · campaign tracking (open/click/unsubscribe) · scheduled campaigns with atomic claiming · campaign templates + attachments · CRM triggers (per-user, 3-level) · 5 advanced client emails · referral codes · staff broadcasts · notification dispatcher + preferences + centre · calendar CRUD + recurrence + conflicts + holidays · Google Calendar two-way sync + retry · appointment reminders (email + push + in-app) · web push · CRM dashboard · audit trail read/export · click-to-call · browser dialer · SMS send + status · AI email drafting · AI calendar suggestions.

### PARTIALLY COMPLETED
Campaigns (no edit, no draft path, no audit, vocabulary split, P0) · CRM Settings (4 inert sections, wrong Google status) · Inbox (read-only) · Calendar (no timezone model, sweep cap) · Audit trail (campaigns and CRM calendar unaudited) · Lead management (~14 inert fields, no merge, no auto-assign) · Dashboard (2 misleading tiles, no filters).

### PENDING (not started)
Client Reviews · lead merge / duplicate management · auto-assignment (round-robin, territory, load) · lead scoring · website intake endpoint · Google Ads intake · Inbox reply/compose · conversion reporting · Meta ad-attribution reporting · campaign A/B testing · drip sequences · SMS campaigns · a real automation/rules engine (the "Triggers" screen is five email on/off switches, not a trigger engine).

### BUILT BUT NOT USED
See §5.1 — 13 items.

### BUILT BUT NOT FUNCTIONAL
`crm_settings.notifications` · `crm_settings.preferences` · `crm_settings.templates` · `emailSettings.replyTemplate/autoSync/autoResponder/forwardingAddress` · `crm_email_settings.smtp_*` + `admin_email` · `leads.date_of_birth` · `leads.marriage_day` · `leads.property_preferences` (beyond display) · the six campaign-token columns (no writer) · `leads.custom_fields` · `campaigns.tags` · `TAG_OPTIONS`.

### BROKEN
F-01 (template scope) · F-03 (reminder cap) · F-04 (cancel→draft) · F-06 (vocabulary split) · F-07 (Google card) · F-10 (campaign deep link) · F-11 (deletion secret) · F-13 (suppression bypass) · F-15 (SMS opt-out) · F-20 (`{{AGENT_PHONE}}`) · dashboard tiles headlining category counts.

### OUT OF SCOPE – TRANSACTIONS MODULE
`transactions/` (34 files) · `invoices/` · `reports/` · `documents/` · `fintrac/` · `workflows/` (edit & delete requests) · `marketing-inventory/` · `mls/` · `favorites/` · `recycle-bin/` (Desk) · `quick-actions/` · Analytics · Desk dashboard · `transaction_reviews` and everything hanging off it · commission engine.

## D. Critical issues priority matrix

| Pri | Issue | Module | Impact | Cause | Solution | Complexity |
|---|---|---|---|---|---|---|
| **P0** | F-01 template disclosure + cross-send | Campaigns | Every agent's private drafts readable and sendable by every other agent | Two queries hit Prisma directly instead of `visibleWhere()` | Apply the scope in `options()` and `createAndSend`; add a spec | **Low** |
| P1 | F-16 audience loads the whole lead table | Campaigns | OOM/latency at brokerage scale; runs on every preview | No `select`, no `take` | `select` 10 columns; `take`; `count()` for preview | **Low** |
| P1 | F-05 no audit trail for mass email | Campaigns | No CASL evidence | Never wired | 4 `audit.record` calls | **Low** |
| P1 | F-02 no timezone model | Calendar | Silent hours-wide shift if `TZ` wrong; personal tz setting inert | Naive date+time strings | Assert `TZ` at boot now; real tz handling later | Low → High |
| P1 | F-03 reminder sweep cap | Calendar | Missed appointment reminders | `take` before filter | Page the query | Medium |
| P2 | F-04 cancel→unsendable draft | Campaigns | Stranded campaign + orphan rows | No draft send path | Add send/reschedule, or delete on cancel | Low–Med |
| P2 | F-06 two lead vocabularies | Campaigns | 3 segments untargetable, silently | Duplicated constants | Import from `lead.constants.ts` | **Low** |
| P2 | F-07 Google card says unavailable | CRM Settings | Admins told a shipped feature doesn't exist | Stale hardcode | Read `google_connections` | **Low** |
| P2 | F-10 dead campaign deep link | Notifications | Every campaign notification leads nowhere | No `:id` route | Point at the list, or add the route | **Low** |
| P2 | F-11 wrong secret for Meta deletion | Meta | App-review obligation silently unmet | `webhookSecret()` vs `appSecret()` | Use `appSecret()` | **Low** |
| P2 | F-12 assignable to inactive users | Leads | Leads vanish onto dead accounts | No status/module check | Add `status: 'Active'` | **Low** |
| P2 | F-13 lead email skips suppression | Leads | CASL exposure | Only `unsubscribed` checked | Reuse `optedOut()` | **Low** |
| P2 | F-15 SMS has no opt-out | Leads/SMS | CASL exposure | Never implemented | Check `unsubscribed`; record `21610` | **Low** |
| P2 | Dead fields & settings (20+) | Leads / CRM Settings | Users configure things that do nothing | Migrated shells never wired | Connect or delete — mostly delete | Medium |
| P2 | Six campaign tokens have no writer | Leads/Campaigns | Personalisation always blank | Not in the editor | Add a section to the lead editor | **Low** |
| P2 | R4 tag filtering full-scans | Leads/Campaigns | Slow filters and sends at scale | JSON in TEXT | Join table or JSONB+GIN | Medium |
| P2 | R15 unpaginated lead activity | Leads | Growing detail payload | No pagination | Paginate the panels | Medium |
| P3 | F-08, F-09, F-14, F-17..F-21 | various | Minor | — | see each | Low |
| P3 | Dashboard tiles headline category counts | Dashboard | Misleading at a glance | Presentation choice | Show a real total | **Low** |
| P3 | Hardcoded brand strings | Campaigns/Settings | Wrong on rebrand/resale | Hardcoded | Read company settings | Low |
| P3 | `TENANT_ID` constant lookups | CRM Settings | Multi-tenant landmine | Single-tenant assumption | Use request tenant | Medium |

## E. Recommended development roadmap

### Phase 1 — Critical fixes *(no dependencies; ~2–4 days)*
| Task | Problem | Solution | Outcome |
|---|---|---|---|
| Scope campaign templates in both bypass paths | F-01 P0 disclosure | Apply `visibleWhere()`; spec it | Template privacy actually holds |
| Bound audience resolution | F-16 | `select` + `take`; `count()` preview | The builder stops being able to OOM the API |
| Audit every campaign action | F-05 | 4 `audit.record` calls | CASL questions answerable |
| Assert `TZ` at boot | F-02 step 1 | Add to `validate-config.ts` | The silent-shift failure mode becomes a failed deploy |
| Page the reminder sweep | F-03 | Remove the pre-filter cap | No missed reminders |
| Suppression check on lead email + SMS | F-13, F-15 | Reuse `optedOut()` | One opt-out rule across all five send paths |
| Assignee must be Active | F-12 | Add the filter | Leads cannot vanish |
| Meta deletion secret | F-11 | Use `appSecret()` | Meta obligation met |

### Phase 2 — Core CRM completion *(depends on Phase 1)*
Unify the lead vocabulary (F-06) · resolve the cancelled-campaign dead end (F-04) · add campaign editing for `draft`/`scheduled` · add a campaign detail route (F-10) · fix the Google Calendar integration card (F-07) · **the dead-field decision pass**: for each of the ~20 inert fields, connect or delete — specifically, add a "Campaign personalisation" section to the lead editor (six tokens), surface `custom_fields` on the Meta panel, and remove the SMTP form, the six notification toggles, the four inert email settings, and the five trigger templates (or wire them into `shell()`) · fix the two dashboard tiles.

### Phase 3 — Automation & integrations *(depends on Phase 2)*
Lead auto-assignment (round-robin / territory / load) · website intake endpoint (signed, rate-limited, `lead_source: 'website'`) · lead merge + duplicate detection · birthday/anniversary sweep using `date_of_birth`/`marriage_day` and the trigger templates (this alone makes four dead fields live) · Inbox reply (which makes `replyTemplate` and `autoResponder` meaningful) · Meta ad-attribution report over the six indexed `meta_*` columns · conversion reporting over `lead_conversion`.

### Phase 4 — Performance & scalability
Move campaign delivery onto `QueueModule`/BullMQ (R5) · normalise `leads.tags` (R4) · paginate lead-detail activity (R15) · retention policy for `campaign_recipients` (R11) · raise `MAX_RECIPIENTS` once delivery is queued · load-test the leads list, campaign preview and dashboard at 40k leads / 100 concurrent users.

### Phase 5 — UI/UX
Remove the Client Reviews nav entry until built · resolve the two-notes confusion · surface `MAX_RECIPIENTS` in the builder before the audience is built · add filters and a date range to the CRM dashboard · show `clicked`/`bounced`/`unsubscribed` on the Campaigns tile · mobile/responsive and accessibility pass (currently unassessed).

### Phase 6 — Production hardening
Wire alerting to `/api/health/workers` and `observability/audit-health.ts` · verify backup + a real restore drill · replace hardcoded brand strings with company settings · replace `TENANT_ID` constant lookups with the request tenant · a full real timezone model (F-02 steps 2–3) · penetration test focused on the Meta/Twilio webhook paths and the OAuth `state` window.

---

## Audit rule compliance

Every classification above was reached by reading the implementation, not the UI. Where a field appears in the interface, the server write path *and* the read path were traced before it was called functional. Where a behaviour could not be established from code — runtime timezone, backups, monitoring, mobile, call duration capture, client-side disconnect handling — it is marked **UNVERIFIED – REQUIRES MANUAL TESTING** rather than guessed. Transactions, Transaction Desk, invoices, documents, reports, FINTRAC, MLS, inventory and commissions were excluded from every count, percentage and finding.
