# Transaction Desk — Functional, Workflow & Role-Based Access Audit

**Audited:** 2026-08-14 · branch `version_3`
**Scope:** Transaction Desk / Transaction Management only (`/desk/*`). CRM modules (Leads, Campaigns,
Meta, CRM Dashboard/Calendar/Inbox/Settings/Triggers/Communications, Client Reviews) are excluded and
mentioned only where Transaction Desk behaviour depends on them.
**Method:** source-code reading. Every claim below names the file it came from. Where the
implementation does not answer a question, the report says **Unable to verify from the current
implementation** rather than guessing.

---

## 1. Executive Summary

The Transaction Desk is the back-office half of Get Home Realty's in-house system. It is not a
generic "transaction management" product: it is a purpose-built **deal file + commission engine +
compliance record** for an Ontario brokerage, and the code shows exactly that emphasis. A deal is
created by an agent or the office, carries a brokerage-issued **trade number**, accumulates
**clients, conditions, co-operating brokerage, lawyers, statuses and documents**, and the server —
never the browser — computes **commission, splits, HST, trust amounts and invoices** from it
(`server/src/transactions/commission.service.ts`, `README.md` "Backend-authoritative").

Three things distinguish this implementation:

1. **A review loop, not just an audit log.** Every field an agent changes is written to
   `audit_logs` with `source: 'Agent'`, surfaced to the office as "Agent changes to review", and can
   be **approved or rejected with a written reason**. A rejection becomes a row in
   `transaction_reviews` with its own lifecycle (Open → Corrected → Resolved), its own conversation
   thread, its own escalation ladder (1 day / 3 days / 1 week → the office), and its own dashboard
   widgets and exports.
   (`transactions/transaction-review.service.ts`, `review-sla.service.ts`, `review-thread.service.ts`)
2. **Progressive locking tied to lifecycle.** `DFT` and `Closed` lock direct editing; an Admin must
   raise an **edit request** that only a Super Admin approves. Deletion is an approval chain
   (agent requests → Admin forwards → Super Admin approves). Money sections re-lock once a deal is
   Closed *and* the agent commission is paid.
   (`transactions/transactions-write.service.ts:294-339`, `workflows/*`)
3. **Automated chasing.** A nightly/hourly sweep chases listing expiry (10-day countdown),
   auto-expires listings, and chases missing buyer/seller lawyer details on a weekday-anchored
   cadence that tightens as closing approaches. Every reminder is claimed by a unique row so it
   cannot double-send. (`transactions/reminder-sweep.service.ts`, `reminder-schedule.ts`)

**Overall state:** the Transactions, Documents, Review, Reports, Invoice, Recycle Bin and Audit Trail
modules are implemented and working. Analytics and the Transaction Desk Inbox are thin. Triggers is a
surfacing screen over two existing mechanisms rather than a rules engine (the screen says so itself).

**The material problems found** (detail in §31). The four marked **FIXED** were corrected on
2026-08-14 — see §31 for what changed and how it is tested; the rest remain open:

- **SEC-1 — FIXED — queued exports ran as `role: 'admin'`.** An agent can queue "Download All Transactions";
  the background worker rebuilds the requesting user with a hard-coded admin role, so the generated
  workbook contains the **whole brokerage's** deals and commission data, and the agent downloads it.
  (`reports/export-job.service.ts:201`)
- **SEC-2 — FIXED — transaction reads were authentication-only.** `GET /api/transactions`,
  `GET /api/transactions/:id`, the documents list/downloads, the FINTRAC identification read and the
  chat all carry no `@Screen('transactions', …)`. A role whose permission map says
  `transactions: 'none'` (the `crm` role) is refused nothing at the API.
- **SEC-3 — FIXED — agent scoping keyed on the agent's *name string*, not their user id**
  (`common/transaction-scope.ts`). Two staff with the same name share each other's deals.
- **SEC-4 — FIXED — `/api/agent-commissions` and `/api/agent-loans` were authentication-only**, so
  any signed-in user could read every agent's split and loan balance. Now behind `transactions:view`
  and scoped to the caller's own row for agents. (`server/src/agents/*`)
- **FUNC-1 — the `mandatory` document flag is wiped on every documents load**
  (`documents/documents.service.ts:93`), yet the dashboard tile "mandatory missing" and the reports'
  `missing_mandatory` still read it. Both are structurally always 0.
- **DEAD-1 — `pending_delete` is never set to `true` anywhere**, so the "deleted documents / review
  deleted" panel and `POST /api/documents/:id/restore` cannot ever act on anything.

---

## 2. What Transaction Desk Was Built For

### The business problem

A brokerage in Ontario has to do five things per deal, and doing them in spreadsheets and email is
where brokerages lose money and fail RECO audits:

| Problem | What this application does about it |
|---|---|
| **Commission is complicated and wrong by hand** — percentage or flat, listing vs co-op splits, HST, pre-HST/post-HST adjustments, team splits, referral deductions, preconstruction paid in terms | `CommissionService` computes every variant server-side and every screen renders the answer. The split percentage per agent comes off `users.profile` (`agent_comm_pct` / `lease_comm_pct`), with an automatic **split upgrade** once an agent passes a closed-deal threshold (`transactions-write.service.ts:488-506`). |
| **Agents change deal facts after the office has processed them** | Every agent save is tagged `source: 'Agent'` and queued for review. The office marks reviewed or rejects with a reason; a rejection is re-put-back automatically where the field allows it, and where it does not the record says so and the agent is told to correct it. |
| **Documents go missing and nobody notices until the audit** | Each deal seeds a document checklist by transaction type, tracks Received/Pending and Valid/Invalid per document, records who reviewed it and why it failed, supports per-client uploads (FINTRAC ID), and drives reminder emails, a RECO-readiness flag, and six documentation reports. |
| **Closing dates and listing expiries slip** | Hourly sweep: 10-day listing-expiry countdown, automatic Active→Expired, and lawyer-detail chasing on a weekday ladder (weekly from 30 days out → Mon/Thu from 15 → Mon/Wed/Fri from 7). |
| **No accountability trail** | Field-level audit of the whole deal graph (scalars, clients, conditions, team members, brokerage, statuses, JSON activity blocks), plus a separate decision record for every review. |

### What happens to a transaction, end to end

An agent (or the office) creates a deal; the system assigns a trade number, sets `comm_status:
Pending` / `valid_status: Pending`, writes "Record created" to the audit trail, and — for invoiceable
types other than Preconstruction — **auto-generates the co-op commission invoice**. Documents are
seeded on first open. The agent fills in clients, conditions, lawyers and uploads documents; each
upload emails the deals desk. The office validates the documents (Valid/Invalid + remarks), reviews
the agent's field changes, completes the financial and admin-activity sections (payments, CTA to BA,
adjustments, referrals), issues the Trade Sheet / Notice of Sale / Deposit Receipt / Lawyer
Statement, sends and collects the invoice, and finally sets the deal to a terminal status
(`Closed`, `Sold`, `Leased`, `Mutual Release`, `DFT`, `Void`, `Terminated`, `Expired`). Closing is
blocked while any review item is unresolved unless an administrator overrides it **with a written
reason that is itself audited**. Deleting is soft; the Recycle Bin can restore the deal and the
invoices that went down with it.

### What it is *not*

There is **no offer/negotiation workflow, no e-signature, no MLS write-back, no client portal, no
payment gateway**, and no status/date/deadline **rules engine** — the Triggers screen states this
plainly ("Not built yet", `client/src/desk/DeskTriggersPanel.tsx:185-193`).

---

## 3. Transaction Desk Architecture

```
client/src/
  App.tsx                 route table; one SCREENS entry per screen, mounted per area
  desk/area.ts            SCREEN_AREA — which screen belongs to crm | desk | both
  desk/DeskLayout.tsx     sidebar (NAV), area switcher, the two notification bells
  desk/guards.tsx         RequireScreen — client-side screen gate
  context/AuthContext.tsx can(screen, level), isSuperAdmin, isAdminOrAbove, modules

server/src/
  core/authz.ts           ROLE_RANK + CAPABILITIES — the authorization vocabulary
  auth/permission.service.ts  SCREENS × ROLES → none|view|edit  (+ per-user overrides)
  auth/guards/            AuthGuard · ScreenGuard · AdminGuard · CsrfGuard
  core/area.guard.ts      refuses ?area=… the caller may not open
  core/module-access.service.ts  licence (subscriptions) AND assignment (user_modules)
  core/resource-access.service.ts  per-record ownership ("may this person reach this deal?")
  common/transaction-scope.ts      the agent visibility predicate, written once
  common/domain.ts        crm | desk | common — audit domains and screen ownership
```

**Three independent gates, in order:**

1. **Module** — is Transaction Management licensed (`subscriptions`) *and* assigned to this user
   (`user_modules`)? Enforced by `ScreenGuard` for any route carrying `@Screen`, and by `AreaGuard`
   for any route taking `?area=`. Both default **open** when the tables are empty.
2. **Screen permission** — `transactions|invoice|reports|…` at `none|view|edit`, role defaults
   overlaid with `user_permissions` rows. Enforced by `ScreenGuard`, i.e. **only where `@Screen` is
   present** (see SEC-2).
3. **Record ownership** — `transactionScopeWhere()` in list queries and
   `ResourceAccessService.assertTransaction()` on individual records. Applies to the `agent` role
   only; every other role sees the brokerage's deals by design
   (`common/transaction-scope.ts:14-21`).

---

## 4. Confirmed Modules

Derived from `client/src/App.tsx` (`SCREENS`), `client/src/desk/area.ts` (`SCREEN_AREA`) and
`client/src/desk/DeskLayout.tsx` (`NAV`), filtered to `desk` and `both`.

### Screens with a sidebar entry

| # | Module | Route | Nav gate | Page |
|---|---|---|---|---|
| 1 | Dashboard | `/desk/dashboard` | `dashboard:view` | `DeskDashboardPage.tsx` |
| 2 | Analytics | `/desk/analytics` | `analytics:view` | `AnalyticsPage.tsx` |
| 3 | Calendar (+ To-Do list) | `/desk/calendar` | `calendar:view` | `CalendarPage.tsx` |
| 4 | Inventory (marketing stock) | `/desk/inventory` | `inventory:view` | `InventoryPage.tsx` |
| 5 | Inbox | `/desk/inbox` | open (personal) | `InboxPage.tsx` |
| 6 | MLS (+ Favorites section) | `/desk/mls`, `/desk/mls/:id` | `mls:view` | `MlsModulePage.tsx` |
| 7 | **Transactions** | `/desk/transactions`, `/:id` | `transactions:view` | `TransactionsPage.tsx`, `TransactionDetailPage.tsx` |
| 8 | Invoice | `/desk/invoice` | `invoice:view` | `InvoicePage.tsx` |
| 9 | Reports | `/desk/reports`, `/:reportType` | `reports:view` | `ReportsPage.tsx`, `ReportDetailPage.tsx` |
| 10 | Audit Trail | `/desk/audit` | `audit:view` | `AuditLogPage.tsx` |
| 11 | Users (shared) | `/desk/users` | **Super Admin** | `UsersPage.tsx` |
| 12 | Settings | `/desk/settings` | `settings:view` **or** Super Admin | `SettingsPage.tsx` |
| 13 | Triggers | `/desk/triggers` | `triggers:view` | `TriggersPage.tsx` → `DeskTriggersPanel.tsx` |
| 14 | Recycle Bin | `/desk/recycle-bin` | **Super Admin** | `RecycleBinPage.tsx` |
| 15 | Settings (agent's own) | `/desk/account` | agents only | `AccountSettingsPage.tsx` |

### Sub-screens reachable only by link

| # | Screen | Route | Source |
|---|---|---|---|
| 16 | Bulk Import | `/desk/transactions/import` | `BulkImportPage.tsx` |
| 17 | Download Centre (export queue) | `/desk/transactions/downloads` | `DownloadCentrePage.tsx` |
| 18 | Notification Centre | `/desk/notification-center` | open, personal |
| 19 | Notification Preferences | `/desk/notifications` | open, personal |
| 20 | Favorites (legacy route) | `/desk/favorites` | kept working; UI entry lives under MLS |

### Modal workflows inside the Transaction Detail screen

Team Split · Financial · Legal & Documents (`DocsModal`) · Lawyer Details · Admin Activities ·
Adjustment · Agent FAQ Center · Audit Trail (per deal) · Chat · Invoice / Invoice Editor / Invoice
Preview · Trade Sheet · Notice of Sale · Deposit Receipt · Lawyer Statement · Commercial Lease card ·
Form 630 · Review History panel · Confirm dialogs.

### Backend-only capabilities (no dedicated screen)

| Capability | Location |
|---|---|
| Documents engine (seeding, per-client files, validation, reminders) | `server/src/documents/*` |
| Edit-request & delete-request approval workflows | `server/src/workflows/*` |
| Review lifecycle, threads, SLA ladder, review export | `server/src/transactions/transaction-review*.ts`, `review-*.ts` |
| Reminder sweep (listing expiry, auto-expire, lawyer details) | `server/src/transactions/reminder-sweep.service.ts` |
| Quick Actions send (Notice of Sale, Deposit Receipt, Trade Sheet) | `server/src/quick-actions/*` |
| FINTRAC client identification + AI ID extraction | `server/src/fintrac/*` |
| Bulk export / export queue / bulk import | `server/src/reports/bulk-export*.ts`, `export-job.service.ts`, `transaction-import.service.ts` |
| Trade number & invoice number allocation | `transactions/trade-number.service.ts`, `invoices/invoice.numbers.ts` |
| Chat + @mentions on a deal | `transactions/messages.service.ts`, `mention.service.ts` |

---

## 5. Role Architecture

**Stored role → UI label → rank** (`server/src/core/authz.ts:25-32`, `auth/permission.service.ts:42-49`):

| Stored | UI label | Rank |
|---|---|---|
| `admin` | **Super Admin** | 100 |
| `manager` | **Admin** | 80 |
| `accounting` | Accounting | 60 |
| `documentation` | Documentation | 60 |
| `crm` | CRM | 40 |
| `agent` | **Agent** | 20 |

Predicates: `isSuperAdmin` = rank ≥ 100 · `isAdminOrAbove` = rank ≥ 80 · `isAgent` = role string
`'agent'` exactly.

**Capabilities** (`authz.ts:52-124`) — named actions with a minimum rank:

| Capability | Minimum |
|---|---|
| `documents.override-valid` (replace/delete a document marked Valid) | Super Admin |
| `transactions.approve-edit` | Super Admin |
| `transactions.override-lock` | Super Admin |
| `users.administer` | Super Admin |
| `documents.administer` (restore a document) | Admin |
| `transactions.decide-deletion` | Admin |
| `notifications.administer` | Admin |
| `data.read-all` | Admin |
| `company.read-banking` (brokerage bank/HST details on printed documents) | Accounting |

**Screen permission defaults** (`auth/permission.service.ts:104-194`), Transaction Desk screens only:

| Screen | Super Admin | Admin | Accounting | Documentation | CRM | Agent |
|---|---|---|---|---|---|---|
| dashboard | edit | edit | view | view | view | view |
| analytics | edit | edit | view | view | view | view |
| calendar | edit | edit | view | view | view | **edit** |
| inventory | edit | edit | view | view | view | view |
| inbox | edit | edit | view | view | view | view |
| mls / favorites | edit | edit | view | view | view | view |
| **transactions** | edit | edit | **edit** | **edit** | **none** | **edit** |
| **invoice** | edit | edit | **edit** | **none** | **none** | **none** |
| reports | edit | edit | view | view | view | view |
| **audit** | edit | **view** | **none** | **none** | **none** | **none** |
| **users** | edit | **none** | none | none | none | none |
| **settings** | edit | **view** | **none** | **none** | **none** | **none** |
| triggers | edit | edit | view | view | edit | **edit** |

Super Admin is above the map entirely — `effectiveFor()` returns every screen at `edit` regardless of
what is stored (`permission.service.ts:198-212`). Per-user overrides live in `user_permissions` and
are applied on top of the role default.

---

## 6. Super Admin Capabilities

A Super Admin (`role = 'admin'`) can, verified in code:

- **See everything.** No `transactionScopeWhere` clause is added for non-agents, so every deal,
  document, invoice, report, review and audit entry in the brokerage is readable.
- **Create / edit / delete transactions**, including editing a deal in `Closed` status — the only
  role that can (`transactions-write.service.ts:294-296`).
- **Edit a DFT deal directly**, and **approve or reject** an Admin's edit request
  (`workflows/edit-requests.service.ts:77-95`, guarded by `AdminGuard` *and* `isSuperAdmin`).
- **Approve a deletion request** — the only role that can actually delete via the workflow
  (`delete-requests.service.ts:69-93`).
- **Override review-blocked closing** with a written reason (audited as "Review requirement
  overridden", `transactions-write.service.ts:318-338`).
- **Replace or delete a document marked `Valid`** (`documents.service.ts:318-320`).
- **Delete condition documents** (`canDeleteConditionDocs={isSuperAdmin}` in
  `TransactionDetailPage.tsx:1366`).
- **Access the Recycle Bin** — the only role. Restore or permanently destroy transactions,
  documents, invoices, invoice payments and deleted admin/adjustment rows; read the deletion log
  (`recycle-bin/recycle-bin.service.ts:35-37`).
- **Manage users** (`AdminGuard` on the whole `users` controller), including each agent's commission
  split profile, which is what the deal financials read.
- **Manage roles & permissions** and the module licence (`Settings → Roles & Permissions`).
- **Manage Transaction Desk Settings** — mail accounts (SMTP/IMAP), email templates, and therefore
  the Desk message triggers; `email.controller.ts` is `AuthGuard + AdminGuard` throughout.
- **Manage Company Settings** — brokerage identity, HST number, banking, currency, default tax rate,
  invoice prefix and next invoice number, default terms, lawyer-reminder cadence.
- **Read the Audit Trail** and export it to CSV/XLSX.
- **Edit money sections after close-and-pay** — Team Split, Adjustments, referrals stay editable for
  a Super Admin only (`TransactionDetailPage.tsx:630-638`).

---

## 7. Admin Capabilities

An Admin (`manager`) runs the desk day to day: full read/write on transactions, documents, invoices,
reports, analytics, calendar, inventory and MLS; reviews and rejects agent changes; sends document
reminders; issues Trade Sheets, Notices of Sale, Deposit Receipts and Lawyer Statements; records
invoice payments; forwards or rejects deletion requests; and reads (but cannot export-configure) the
Audit Trail.

**Where Admin differs from Super Admin — every case:**

| Action | Super Admin | Admin |
|---|---|---|
| Edit a `Closed` transaction | Allowed | **Not allowed** — must ask a Super Admin; there is no request path for Closed (`transactions-write.service.ts:294`, `edit-requests.service.ts:33`) |
| Edit a `DFT` transaction | Allowed directly | **Not allowed** — must raise an edit request |
| Approve/reject an edit request | Allowed | **Not allowed** (`edit-requests.service.ts:78`) |
| Approve a deletion request | Allowed | **Not allowed** — may only **forward** it upward, or reject it |
| Recycle Bin (view / restore / permanent delete) | Allowed | **Not allowed** — 403 "Only a Super Admin can access the Recycle Bin." |
| Replace/delete a document marked `Valid` | Allowed | **Not allowed** |
| Delete condition documents | Allowed | **Not allowed** (UI gate) |
| Users screen / create-edit-delete users | Allowed | **Not allowed** — `users: 'none'` and `AdminGuard` on the API |
| Roles & Permissions tab | Allowed | **Not allowed** (gated on `users` permission) |
| Transaction Desk Settings tab (mail accounts, templates) | Allowed | **Not allowed** — tab is `superAdmin`, API is `AdminGuard` |
| Audit Trail | `edit` | **`view`** |
| Company Settings | Read + write | **Read only** by default (`settings: 'view'`; write needs `settings:'edit'`) |
| Money sections after Closed **and** agent paid | Editable | **Locked** |

**Frontend/backend agreement:** correct in all the above. One near-miss worth noting — the Desk
Triggers panel computes `canEdit = can('settings','edit') || isSuperAdmin` for the reminder cadence,
but the **message-trigger on/off buttons are not gated by `canEdit` at all**
(`DeskTriggersPanel.tsx:168`). In practice this is harmless because `GET /api/email-templates` is
`AdminGuard`, so a non-Super-Admin gets an empty list and the buttons never render. It is a latent
mismatch, not a live one.

---

## 8. Agent Capabilities

Answers to the specific questions asked, each verified:

| Question | Answer | Evidence |
|---|---|---|
| Sees only their own transactions? | **Their own + deals they are split into as a team member.** A deal with **no** agent is administrator-only even if team rows exist. | `common/transaction-scope.ts`, `transactions.service.ts:61-76` |
| Can see another agent's transactions? | No, through the list or the detail endpoint. **But see SEC-1** — a queued export escapes this. | `transactions.service.ts:269-279` |
| Brokerage-wide transactions? | No. | as above |
| Can edit another agent's transaction? | Only if listed on it with `access: 'full'`; a `docs`-access split member is view-only. | `transactions-write.service.ts:279-291` |
| Can view invoices? | No — `invoice: 'none'`. The dashboard withholds invoice figures entirely (`invoices: null`). | `permission.service.ts:173-193`, `dashboard/area-dashboard.service.ts:282-337` |
| Can create invoices? | No. |  |
| Can access reports? | **Yes**, `reports: 'view'`, hard-scoped to their own name — the agent filter is overwritten server-side and the search haystack excludes agent names. | `reports/reports.service.ts:285-315` |
| Can access analytics? | Yes; the data is their own deals only (the underlying list is scoped). | `AnalyticsPage.tsx`, `transactions.service.ts` |
| Can access the audit trail? | No — `audit: 'none'`; `/api/audit-logs` is `@Screen('audit','view')`. They *do* see their own deal's audit through the deal screen only if not an agent — the per-deal **Audit Trail button is hidden for agents** (`TransactionDetailPage.tsx:1106`), though `audit_logs` are still present in the transaction payload. | |
| Recycle Bin? | No — Super Admin only, enforced in the service. | |
| Transaction settings? | No — `settings: 'none'`. They get their own `/desk/account` page. | |
| Triggers? | **Yes, read-only.** `triggers: 'edit'` opens the screen; the cadence field is disabled (`canEdit` false) and the template list comes back empty (AdminGuard). | |
| Connect their own email? | Yes, under My Settings; accounts are per-user and scoped `crm`/`desk`. | `email/mail-account.service.ts`, `IntegrationsPanel` |
| See another user's inbox? | No — every inbox query is `user_id`-scoped. | `inbox/inbox.service.ts` |
| See another user's calendar? | No — "A calendar is private to its owner, for EVERY role." | `calendar/calendar.service.ts:88-92` |
| Upload documents? | Yes, on deals they can reach. Uploading over an existing file creates a **new version row** rather than replacing (agents only). | `documents.service.ts:345-353` |
| Delete documents? | **No** — "Only an administrator can delete documents." They can delete individual *files* inside a multi-file document. | `documents.service.ts:468` |
| Submit transactions? | There is no discrete "submit". Creating/saving *is* submission; the office is notified through the review queue and document-upload emails. | |
| Reopen transactions? | No. | |
| Modify completed transactions? | No — `Closed` is Super-Admin-only for everyone. | |
| See commission information? | Partly. `commission`/`financial` blocks are serialised for everyone who can read the deal, and the dashboard shows the agent their **own T4A** figures. Brokerage gross, external referral and client referral tiles are hidden from agents. | `transaction.resource.ts`, `DeskDashboardPage.tsx:118-139` |
| Change financial information? | **No.** 26 commission/adjustment fields are stripped from an agent's payload server-side (`AGENT_LOCKED`). | `transactions-write.service.ts:57-67, 285` |
| Administrative actions? | No: cannot review/reject changes, send document reminders, delete, approve, or manage users/settings. | |

**Additional agent-specific behaviour:**

- Deleting is replaced by **Request Deletion** with a mandatory reason
  (`TransactionsPage.tsx:184-193`, `delete-requests.service.ts:19-46`); only for deals where they are
  the named agent (a split member cannot request deletion).
- An agent's own bell polls document-review and change-review notifications
  (`DeskLayout.tsx:203-216`).
- `activity_tracker` writes from an agent are reduced to the single `batch_review_email` flag
  (`transactions-write.service.ts:286-290`).
- An agent editing a field that was previously rejected automatically moves that review item to
  **Corrected** (`transactions-write.service.ts:407-409`).

---

## 9. Complete Role × Permission Matrix

Legend: ✔ allowed · ✖ refused · ◐ conditional (condition named) · — not applicable.
"Rule" names the enforcement point.

### Navigation & module access

| Item | Super Admin | Admin | Agent | Rule |
|---|---|---|---|---|
| Open the Transaction Desk area at all | ✔ | ✔ | ✔ | `subscriptions.transaction_enabled` AND `user_modules('desk')` — `ScreenGuard` + `AreaGuard` |
| Sidebar entry visibility | all | all but Users/Recycle Bin/Desk Settings | Dashboard, Analytics, Calendar, Inventory, Inbox, MLS, Transactions, Reports, Triggers, Settings(own) | `DeskLayout.tsx` NAV filters |
| Direct URL to a hidden screen | ✔ | ◐ blocked by `RequireScreen` | ◐ blocked by `RequireScreen` | client gate only — the API gate is per-endpoint |

### Transactions

| Action | Super Admin | Admin | Agent | Rule / endpoint |
|---|---|---|---|---|
| List transactions | ✔ all | ✔ all | ◐ own + split | `GET /api/transactions` — **AuthGuard only** |
| View one transaction | ✔ | ✔ | ◐ own + split | `GET /api/transactions/:id` — **AuthGuard only** + `authorizeAgentAccess` |
| Create transaction | ✔ | ✔ | ✔ | `POST /api/transactions` `@Screen('transactions','edit')` |
| Create on behalf of another agent | ✔ | ✔ | ✖ (creator's name is forced) | `transactions-write.service.ts:104-116` |
| Edit transaction (normal status) | ✔ | ✔ | ◐ owner or `access:'full'` split member | `PUT /api/transactions/:id` |
| Edit financial fields | ✔ | ✔ | ✖ stripped | `AGENT_LOCKED` |
| Edit when status = `DFT` | ✔ | ◐ needs approved edit request | ✖ | `transactions-write.service.ts:297-304` |
| Edit when status = `Closed` | ✔ | ✖ | ✖ | `transactions-write.service.ts:294` |
| Change status | ✔ | ✔ | ✔ (own) | `statuses[]` in the PUT body |
| Close with unresolved reviews | ◐ reason required | ◐ reason required | ◐ reason required | 422 + `review_override_reason` |
| Delete transaction (soft) | ✔ | ✔ | ✖ | `DELETE /api/transactions/:id`; agents refused in service |
| Request deletion | — | — | ✔ own only | `POST /api/transactions/:id/delete-requests` |
| Forward a deletion request | ✔ | ✔ | ✖ | `isAdminOrAbove` |
| Approve a deletion request | ✔ | ✖ | ✖ | `isSuperAdmin` |
| Reject a deletion request | ✔ | ✔ | ✖ | `isAdminOrAbove` |
| Raise an edit request | ✔(n/a) | ✔ | ◐ only `scope:'financial'` | `edit-requests.service.ts:29-34` |
| Approve/reject an edit request | ✔ | ✖ | ✖ | `AdminGuard` + `isSuperAdmin` |
| Restore a transaction | ✔ | ✖ | ✖ | Recycle Bin |
| Permanently delete | ✔ | ✖ | ✖ | Recycle Bin |
| Bulk import | ✔ | ✔ | ✔ | `@Screen('transactions','edit')` |
| Bulk export (live) | ✔ all | ✔ all | ◐ own | `bulk-export.service.ts:83-91` |
| Queue a background export | ✔ | ✔ | ⚠ **runs as admin** | `export-job.service.ts:201` — **SEC-1** |
| Deal chat: read/post | ✔ | ✔ | ◐ own + split | `ResourceAccessService.assertTransaction` |
| @mention someone | ✔ | ✔ | ◐ only people who can reach the deal | `mention.service.ts` |

### Review of agent changes

| Action | Super Admin | Admin | Agent |
|---|---|---|---|
| See "Agent changes to review" banner + bell | ✔ | ✔ | ✖ |
| Mark reviewed (optional note) | ✔ | ✔ | ✖ (`isAdminOrAbove`) |
| Reject a change (reason mandatory) | ✔ | ✔ | ✖ |
| Bulk reject / bulk resolve | ✔ | ✔ | ✖ |
| Read the deal's review history | ✔ | ✔ | ◐ own deal, read-only |
| Post on a review thread | ✔ | ✔ | ◐ own deal |
| Export review history (xlsx/pdf) | ✔ | ✔ | ◐ own deal |
| Reminder history (`/transactions/reminders/history`) | ✔ | ✔ | ✖ explicit `isAdminOrAbove` |

### Documents

| Action | Super Admin | Admin | Agent |
|---|---|---|---|
| List documents | ✔ | ✔ | ◐ own + split |
| Download a document / validation file / ZIP | ✔ | ✔ | ◐ own + split |
| Upload a document file | ✔ replaces | ✔ replaces | ◐ **adds a version**, previous kept |
| Upload per-client file (FINTRAC) | ✔ | ✔ | ✔ |
| Delete an individual file | ✔ | ✔ | ✔ |
| Add a document row | ✔ | ✔ | ✔ |
| Set Status / Validation / Remarks / Drive flag / reminder bell | ✔ | ✔ | ✖ (agent path only writes `agent_accepted`) |
| Mark a document Accepted / Not Accepted | ✔ | ✔ | ✔ |
| Delete a document row | ✔ | ✔ | ✖ |
| Replace/delete a document marked `Valid` | ✔ | ✖ | ✖ |
| Delete a condition document | ✔ | ✖ | ✖ |
| Send document reminders (per deal) | ✔ | ✔ | ✖ |
| Send documentation reminders (from Reports) | ✔ | ✔ | ◐ own deals only |
| Set "Ready for RECO Audit" | ✔ | ✔ | ✖ |

### Invoice

| Action | Super Admin | Admin | Accounting | Documentation | Agent |
|---|---|---|---|---|---|
| List / view invoices | ✔ | ✔ | ✔ | ✖ | ✖ |
| Create manual invoice | ✔ | ✔ | ✔ | ✖ | ✖ |
| Generate from a transaction | ✔ | ✔ | ✔ | ✖ | ✖ |
| Edit invoice | ✔ | ✔ | ✔ | ✖ | ✖ |
| Send / resend (marks `sent_at`) | ✔ | ✔ | ✔ | ✖ | ✖ |
| Record payment / delete payment | ✔ | ✔ | ✔ | ✖ | ✖ |
| Record reminder | ✔ | ✔ | ✔ | ✖ | ✖ |
| Delete invoice (reason required) | ✔ | ✔ | ✔ | ✖ | ✖ |
| Restore / permanently delete | ✔ | ✖ | ✖ | ✖ | ✖ |
| Manage customers | ✔ | ✔ | ✔ | ✖ | ✖ |

*(Invoice list/detail carry **no ownership scoping at all** — anyone holding `invoice:view` sees every
invoice in the brokerage. Only the permission default keeps agents out.)*

### Reports / Analytics / Dashboard

| Action | Super Admin | Admin | Agent | Rule |
|---|---|---|---|---|
| Report catalogue (20 reports) | ✔ | ✔ | ✔ | `@Screen('reports','view')` |
| Run a report brokerage-wide | ✔ | ✔ | ✖ forced to own name | `sanitize()` |
| Filter by another agent | ✔ | ✔ | ✖ | `sanitize()` |
| Export XLSX / PDF | ✔ | ✔ | ◐ own data | same scoping as the run |
| Expand a deal's documents | ✔ | ✔ | ◐ own | `documentsFor()` |
| Preview / send documentation reminders | ✔ | ✔ | ◐ own deals | `document-reminder.service.ts` |
| Desk dashboard tiles | brokerage | brokerage | own deals | `area-dashboard.service.ts:273` |
| Dashboard invoice tiles | ✔ | ✔ | ✖ (`invoices: null`) | `mayReadInvoices` |
| Commission tiles | brokerage gross + referrals | brokerage gross + referrals | own T4A only | `dashboard.service.ts`, `DeskDashboardPage.tsx:131-138` |
| Review widgets / error charts | brokerage | brokerage | own | `transaction-review.service.ts:503` |
| Analytics screen | brokerage | brokerage | own | list scoping |

### Calendar / Inbox / Settings / Triggers / Audit / Recycle Bin

| Action | Super Admin | Admin | Agent | Rule |
|---|---|---|---|---|
| Desk calendar events (own) | ✔ | ✔ | ✔ | `calendar: user_id` — **nobody sees anyone else's** |
| Link an event to a transaction | ◐ any deal | ◐ any deal | ◐ own + split | `transactionScopeWhere` in `validate()` |
| To-Do list | own | own | own | `todos: user_id + domain` |
| Desk Inbox | own mailbox | own mailbox | own mailbox | `inbound_emails.user_id` + account `scope:'desk'` |
| Trigger cadence (lawyer reminders) | ✔ | ◐ needs `settings:'edit'` | ✖ read-only | `PUT /api/company-settings` `@Screen('settings','edit')` |
| Switch a Desk message trigger on/off | ✔ | ✖ | ✖ | `AdminGuard` on `/api/email-templates` |
| Audit Trail read | ✔ | ✔ | ✖ | `@Screen('audit','view')` |
| Audit Trail export | ✔ | ✔ | ✖ | same guard as the listing |
| Recycle Bin (all six tabs) | ✔ | ✖ | ✖ | `isSuperAdmin` in the service |

---

## 10. Dashboard

**Frontend:** `client/src/desk/DeskDashboardPage.tsx` · **Backend:** `GET /api/dashboard/desk`
(`dashboard/dashboard.controller.ts:41`, `dashboard/area-dashboard.service.ts:269-371`) and
`GET /api/dashboard/commissions` (`dashboard/dashboard.service.ts`), plus
`GET /api/dashboard/reviews` and `/review-errors`.

| Tile | Data source | Scope |
|---|---|---|
| Total Deals | `count(transactions where deleted_at null)` | Agent: `agent = own name`. Everyone else: brokerage |
| Validation | `groupBy valid_status` | same |
| Commission Status | `groupBy comm_status` | same |
| Closings Ahead (+ this month, + past-closing unpaid) | `closing_date` ranges; overdue = past closing with `comm_status ≠ 'Paid'` | same |
| Documents Outstanding (pending / invalid / mandatory missing) | `documents` joined through `transactions: { is: live }` | same |
| Invoices · Billed · Collected · Outstanding | `invoices` count + `_sum(total, amount_paid, balance_due)` | **withheld entirely** unless the caller holds `invoice:view`; an agent who does hold it sees only invoices attached to their own deals |
| Desk Calendar (today / next 30 days) | `calendar_events` where `user_id` + `domain in (desk, null)` + status ≠ cancelled | **personal for every role** |
| Todo List | `todos` where `user_id` + `domain in (desk, null)` | personal |
| Pipeline / Paid / Pending / Upcoming Commissions / Overall | `dashboard.service.commissions()` — per-member T4A from the commission breakdown, bucketed by "paid in admin_activities" / closed / open | Agent: own name only. Others: every member |
| External Referral / Client Referral | `adjustments.ext.amount`, `adjustments.client_rows[].amount` | hidden from agents |
| Review widgets (open / corrected / overdue / by agent / by reviewer / resolution time) | `transaction_reviews` aggregates | Agent: `agent_name = own`. Others: brokerage |
| Recurring-error charts | `transaction_reviews` grouped by `field_label`, 12-month window | same |

**Filters / date ranges:** none. The screen has no controls — it is a fixed snapshot. The CRM
dashboard is cached per user; the Desk dashboard deliberately is **not**, because its invoice section
depends on a permission checked per request (`area-dashboard.service.ts:129-134`).

**Finding (FUNC-3):** the Desk dashboard's agent predicate is `{ agent: user.name }` only
(`area-dashboard.service.ts:273`), while the Transactions list also includes deals the agent is
*split into*. A split-only agent therefore sees deals in the list that their dashboard does not
count.

---

## 11. Transactions — Deep Review

### 11.1 Creation

**Who:** anyone with `transactions: 'edit'` — Super Admin, Admin, Accounting, Documentation, Agent.
**How:** `+ Add Transaction` on `/desk/transactions` (`AddTransactionModal.tsx`) →
`POST /api/transactions` → `TransactionsWriteService.store()`.

**Transaction types** (`server/src/reference/transaction.constants.ts`) — 12:

Residential Buying · Residential Lease · Residential Sale Listing · Residential Lease Listing ·
Preconstruction · Referral · Commercial Property Buying · Commercial Property Lease · Commercial
Property Sale Listing · Commercial Property Lease Listing · Business Buying · Business Sale.

Sub-classifications that drive behaviour: `LISTING_TYPES` (4), `SECURED_DEAL_TYPES` (5, start with no
status), `INVOICEABLE_TYPES` (7).

**Mandatory fields:** `type`, `property`, `status` always; plus `comm_type`, `comm_value`, `price`,
`offer_date`, `closing_date` for non-listing types (`transactions-write.service.ts:96-103`).
**Optional:** deposit, MLS type/number, listing contract/expiry dates, primary agent, team members.

**Validation & defaults:**
- **Duplicate guard** for non-listing types: same `type` + `price` + `offer_date` with a *fuzzy*
  property match (directional tokens and unit numbers must match exactly; then normalised equality,
  word-prefix subset, or PHP `similar_text` ≥ 85 %) → 422 naming the existing trade number.
- **Trade number** allocated per type: Residential Buying `001`–`099`, Residential Lease `100`–`999`,
  everything else from `200836` upward, skipping numbers already used *including soft-deleted rows*
  (`trade-number.service.ts`).
- Listings force `price = 0`, `deposit = 0`, `comm_type = '%'`, `comm_value = 0`, and null offer /
  closing dates; non-listings null the listing contract/expiry dates.
- `comm_status = 'Pending'`, `valid_status = 'Pending'`.
- Default status: listings & Business Sale → `Active`; secured deal types → **none** (the user
  picks); everything else → `Open`.

**Agent association:** if the creator is an agent, `agent` is forced to their own name. A non-agent
may set `primary_agent` and `team_members[]`; supplying either makes it a **team deal** — the primary
gets `access: 'full'`, additional members default to `docs` access. `agent_user_id` is resolved from
the name at creation (`PersonResolver`) so later lookups do not depend on an editable string.

**Side effects on create:** audit row "Record created"; team rows + per-term rows; **auto-generated
commission invoice** when the `transaction_desk_v2` feature flag is on (default true), the type is
invoiceable and is not Preconstruction — best-effort, never blocks the create; a lawyer-detail nudge
if buyer/seller lawyer details are missing on a Buying/Lease deal.

### 11.2 Information captured

From `transaction.resource.ts` and `schema.prisma:2272-2400`, grouped as the UI groups them:

- **Basic Information** — type, property address, assigned agent (+ `agent_user_id`), price, deposit,
  conditional-offer flag, inter-board flag.
- **Dates** — offer, closing, listing contract, listing expiry.
- **Property / MLS** — `mls_type`, `mls_num`, `mls_verified`, inter-board listings (name, board id,
  verified).
- **Clients** — name, email, phone, ordered (`clients` table). Buyer/seller/tenant/landlord are not
  separate tables; they are clients on the deal, differentiated by transaction type.
- **Co-operating brokerage** — name, address, email, invoice email, agent email, phone, plus a
  list of listing agent names (`brokerages` + `brokerage_agents`).
- **Lawyers** — a general set (`lawyer_*`) plus **buyer** and **seller** sets, each name / email /
  phone / address.
- **Commission** — `comm_type` (% or Fixed), `comm_value`, derived `comm_pct` / `comm_amt`;
  listing vs co-op percentages and flats; `trust_payable`; three adjustment pairs
  (commission / listing / co-op, each before-HST and after-HST with an enable flag);
  `comm_status`, `comm_paid_status`, `commission_agent`.
- **Preconstruction** — `precon_listing_type`, `precon_term_count`, `precon_net_of_hst`,
  `precon_comm_pct`, `precon_comm_amt_manual`, `precon_details_of_terms`, plus `precon_terms[]`
  (term number, %, closing date) and builder details (name, vendor, project, address, office email,
  invoice email, phone).
- **Team split** — `team_members` (name, `user_id`, split, `agent_pct`, `brok_pct`, `is_primary`,
  `access`, `scope`) and `team_member_terms` for preconstruction.
- **Conditions** — type (Financing / Home Inspection / Sale of Property / Status Certificate Review /
  Custom), custom name, deadline, status.
- **Statuses** — many-to-one rows in `transaction_statuses` (a deal can hold several).
- **JSON blocks** — `admin_activities` (agent payments, CTA-to-BA, client payment, void cheque, per
  term), `activity_tracker`, `adjustments` (adjustment rows, advance payments, client referrals,
  external referral), `commercial_lease`, `notice_of_sale`, `trade_sheet_data`.
- **Compliance** — `valid_status`, `reco_audit_ready`, `reco_audit_remarks`, `agent_review_at`.
- **Reporting extras (nullable on legacy rows)** — `payment_type`, `listing_price`, `lead_source`,
  `lead_assigned_date`, `lead_converted_date`, `review_email_sent_at`, `review_received_at`,
  `gift_coupon_value`, `gift_coupon_issued_at`.
- **Derived, never stored** — `commission` summary, `financial` breakdown, `statuses`,
  `my_team_access`, `unread_messages`, `edit_locked`, `agent_changes`, `delete_request`,
  `invoice_admin`.

There is **no free-text "notes" field on the transaction**. The equivalents are the per-deal **chat**
(`transaction_messages`), document `remarks`, and audit `details`.

### 11.3 Statuses and the state machine

Vocabulary per type (`reference/transaction.constants.ts:statusOptionsFor`):

| Family | Statuses |
|---|---|
| Referral | Open · Closed |
| Listings + Business Sale | Active · Sold Conditional / Lease Conditional · Sold / Leased · Closed · Mutual Release · DFT · Void · Suspended · Terminated · **Expired** |
| Secured deal types (Res Buying/Lease, Comm Buying/Lease, Business Buying) | Secured Firm · Secured Conditional · Closed · Mutual Release · DFT · Void |
| Everything else | Open · Closed · Mutual Release · DFT · Void |

| Status | Meaning | Entered by | Effects |
|---|---|---|---|
| **Open** | Live non-listing deal (also the display fallback when no status rows exist) | default on create | none |
| **Active** | Live listing | default for listings | Notice of Sale / Lawyer Statement / Trade Sheet hidden; document checklist narrows to listing agreement, MLS data sheet, client photo, FINTRAC |
| **Secured Firm / Secured Conditional** | Firm or conditional secured deal | chosen manually | — |
| **Sold Conditional / Lease Conditional** | Listing under conditional offer | manual | hides Notice of Sale / Lawyer Statement |
| **Sold / Leased** | Listing sold or leased | manual | clears `mls_verified`; document checklist relaxes |
| **Mutual Release** | Deal released | manual | forces the checklist to APS/lease + Mutual Release + Deposit Receipt and auto-creates the missing rows |
| **Void** | Deal void | manual | documents-only mode; checklist narrows to the agreement |
| **Terminated** | Listing terminated | manual | hides Admin / Financial / Agent FAQ and the Team Split |
| **Suspended** | Listing suspended | manual | no coded effect found |
| **Expired** | Listing past its expiry date | **automatic** — on read (`applyExpiry`) and by the nightly sweep | replaces all status rows; terminal, so it fires once |
| **DFT** | "Deal Fell Through" | manual | sets `comm_status`, `comm_paid_status`, `valid_status` all to `N/A`; **locks editing** — Super Admin direct, Admin by approved edit request |
| **Closed** | Completed | manual | **locks editing to Super Admin only**; triggers the agent **split upgrade** check; blocked while review items are open unless overridden with a reason |

Statuses are a **set**, not a single value: `syncStatuses` replaces all rows with the submitted list,
so `Closed` + `DFT` can coexist. There is no server-side legality check on transitions — any listed
status may be applied by anyone with edit rights. Automation is confined to the four cases above
(Expired, DFT field-forcing, Sold clearing `mls_verified`, Closed split-upgrade).

**Realistic flow as implemented:**

```
                 ┌────────────► Void / Mutual Release / Terminated / Suspended
                 │
Create ──► Open / Active / Secured ──► (Sold|Leased Conditional) ──► Sold / Leased ──► Closed
                 │                                                                       │
                 └──► DFT (locked, needs approval to edit)                                └─► split upgrade,
                                                                                             money sections re-lock
Listings only:   Active ──(expiry date passes)──► Expired      [automatic]
Any status:      soft delete ──► Recycle Bin ──► restore | permanent delete
```

### 11.4 Editing

- Only "present" keys are applied (Laravel `validated()` semantics), so a partial PUT never nulls
  what it omits.
- **Agents**: must be the named agent or a `full`-access team member; the `agent` field is pinned to
  their own name (owner) or dropped (member); 26 financial keys are removed; `activity_tracker` is
  reduced to one boolean.
- **DFT**: needs an `approved` edit request, which is consumed (`status → applied`) on the save.
- **Closed**: Super Admin only, no request path.
- **Financial-scoped edit requests** are auto-consumed when any `FINANCIAL_FIELDS` key is written.
- **Lifecycle locks layered in the UI** (`TransactionDetailPage.tsx:618-641`): once `Closed` **and**
  the agent commission is paid, Team Split is hidden and Adjustments are read-only except for a Super
  Admin; once a Notice of Sale has been sent, agents cannot add/remove/rename team members.
- Every save diffs a **full snapshot** of the deal graph and writes one audit row per changed field,
  tagged `Agent` or `Manual`. An agent's save additionally moves matching rejected review items to
  **Corrected**.
- Rows removed from `admin_activities` and `adjustments` are captured into `trashed_row_items`
  so they can be restored from the Recycle Bin.
- Moving `closing_date` or `listing_expiry_date` releases the day's reminder claim so the new date
  can be chased immediately.
- **Auto-save** is on whenever a manual Save would have been permitted — same gate, so it can never
  write where Save is refused (`TransactionDetailPage.tsx:647-651`).

### 11.5 Deletion

- **Soft delete only** from the application: `transactions.deleted_at` is stamped, and **every live
  invoice on the deal is stamped with the same instant** so the pair can be un-done exactly
  (`transactions-write.service.ts:811-815`).
- Agents cannot delete; they raise a request. Admins/Super Admins delete directly; the approval
  workflow ends in the same soft delete.
- Deleted deals go to **Recycle Bin → Transactions** (Super Admin only), where they can be restored
  (bringing back only invoices deleted in that same instant) or **permanently deleted**
  (`prisma.transactions.delete` — cascades to documents, clients, conditions, audit rows, invoices,
  reviews, reminders, statuses, team members via `onDelete: Cascade`).
- The permanent delete is logged as a module-level audit row ("Transaction permanently deleted"), but
  the deal's own `audit_logs` are cascaded away with it.

---

## 12. Transaction Lifecycle Workflow

### STEP 1 — Agent enters an accepted deal
**Actor:** Agent · **Action:** `+ Add Transaction`, fills type/property/price/dates/commission.
**System:** duplicate check → trade number → row created with Pending statuses → audit "Record
created" → invoice auto-generated (invoiceable, non-precon) → lawyer-detail nudge if applicable.
**Database:** `transactions`, `transaction_statuses`, `audit_logs`, `team_members` (if team),
`invoices` + `invoice_line_items`.
**Notification:** lawyer-detail email to the agent if buyer/seller lawyer details are missing.
**Next:** the deal is live and appears in the agent's list.

### STEP 2 — Details completed
**Actor:** Agent (own fields) / Admin (everything) · **Action:** clients, conditions, co-op
brokerage, lawyers, MLS number, team split.
**System:** snapshot diff → one audit row per changed field, `source: 'Agent'` for an agent.
**Database:** `clients`, `conditions`, `brokerages` + `brokerage_agents`, `inter_board_listings`,
`team_members`, `audit_logs`.
**Notification:** none directly; the Admin bell count rises.
**Next:** the office sees "N changes to review".

### STEP 3 — Documents uploaded
**Actor:** Agent · **Action:** Legal & Docs → upload.
**System:** first open seeds the checklist for the type; an agent's upload over an existing file
creates a **new version row** (`Document version added (previous kept)`); `docsValidation.sync`
recomputes `valid_status`; the deals desk is emailed a copy of the upload.
**Database:** `documents` (`file_path`, `files` JSON, `status: 'Received'`), `audit_logs`,
`transactions.valid_status`.
**Notification:** `document.agent_upload` email to the desk; the agent's bell tracks review updates.
**Next:** awaiting document review.

### STEP 4 — Office reviews documents
**Actor:** Admin / Super Admin · **Action:** set Validation = Valid/Invalid with remarks, tick the
reminder bell, set "Ready for RECO Audit".
**System:** audit rows per changed field; when any validation changed → one `DocReview` audit row
summarising "N valid · M invalid (titles)", an **outcome email to the agent**, and a **push
notification** (category `document_review`).
**Database:** `documents`, `transactions.reco_audit_ready/remarks`, `audit_logs`.
**Next:** invalid documents are chased.

### STEP 5 — Office reviews the agent's field changes
**Actor:** Admin / Super Admin · **Action:** "Mark reviewed" (optional note) or "Reject" (reason
required; single or bulk).
**System:** on review — all unhandled `source:'Agent'` rows set `handled = true`,
`agent_review_at` stamped, a `Reviewed` row written. On rejection — the old value is put back where
the field allows it (statuses, mapped scalar columns, brokerage fields, client/condition/inter-board
rows); where it cannot be, the record says "value kept — agent to correct". Either way a
`transaction_reviews` row is created, a message is posted to the deal chat, and the agent is emailed.
**Database:** `audit_logs.handled`, `transactions.agent_review_at`, `transaction_reviews`,
`transaction_messages`.
**Notification:** email + in-app + push (`transaction_approvals`).
**Next:** the item is **Open** until the agent corrects it; the SLA ladder starts.

### STEP 6 — Agent corrects
**Actor:** Agent · **Action:** edits the rejected field, replies on the review thread.
**System:** the matching Open review moves to **Corrected**; `first_response_at` is stamped on the
first reply or correction, whichever came first.
**Next:** the office resolves it (bulk resolve → **Resolved**).

### STEP 7 — Financial processing
**Actor:** Admin / Accounting · **Action:** Financial modal (splits, adjustments), Admin Activities
(agent payments, CTA to BA, client payment, void cheque), Adjustment modal (advances, client
referrals, external referral).
**System:** `syncClientPayment` and `syncAdjustmentStatuses` derive trust receivable/payable and
adjustment statuses from the commission breakdown; removed rows are captured to `trashed_row_items`.
**Database:** `transactions.admin_activities/activity_tracker/adjustments`, `trashed_row_items`,
`audit_logs`.
**Next:** documents can be issued.

### STEP 8 — Documents issued
**Actor:** Admin · **Action:** Trade Sheet / Notice of Sale / Deposit Receipt / Lawyer Statement /
Invoice.
**System:** each has its own mail event and stamps the deal (`trade_sheet_sent_at`,
`notice_of_sale.sent_at`, `invoices.sent_at`).
**Notification:** `trade_sheet.send`, `notice_of_sale.send`, `deposit_receipt.send`, `invoice.send`.
**Next:** once a Notice of Sale is sent, team membership locks for non-admins.

### STEP 9 — Invoice collected
**Actor:** Admin / Accounting · **Action:** Send → Record payment(s).
**System:** `InvoiceCalculator.recalculate` recomputes sub-total, tax, total, amount paid, balance
and status (Draft → Unpaid → Partially Paid → Paid); "Overdue" is derived on read, never stored.
**Database:** `invoices`, `invoice_payments`, `invoice_line_items`, `audit_logs` (module + deal).
**Next:** the deal can be closed.

### STEP 10 — Closing
**Actor:** Admin (or Super Admin) · **Action:** set status `Closed`.
**System:** refuses with 422 + the list of unresolved review items unless
`review_override_reason` is supplied (which is audited); runs the **agent split upgrade** if the
agent's profile defines a threshold and it has been met; money sections re-lock once the agent
commission is also paid.
**Next:** editing is Super-Admin-only from here.

### Terminal branches

| Branch | Path |
|---|---|
| **Cancelled / collapsed** | status → `Void`, `Mutual Release`, `Terminated`, or `DFT` (which N/As the commission fields and locks editing) |
| **Expired** | automatic for listings past `listing_expiry_date` |
| **Deleted** | agent requests → Admin forwards/rejects → Super Admin approves → soft delete (+ invoices) → Recycle Bin |
| **Restored** | Super Admin restores from the Recycle Bin; matching invoices return; audit "Record restored" |
| **Destroyed** | Super Admin permanent delete; cascade; module-level audit row survives |

---

## 13. Documents

**Backend:** `server/src/documents/*` · **Frontend:** `DocsModal.tsx` (opened from the deal, or via
`?open=docs` from the notification bell).

**Seeding.** On the first `GET /api/transactions/:id/documents`, a checklist is created from
`DocumentDefaultsService.defaultsFor(type)`. Every load then normalises the set: strips legacy
`123 (Title)` prefixes, renames "Agreement of Purchase…" → "Agreement to Lease" on lease deals,
renames `Fintrac` → `FINTRACK`, ensures a "RECO Guide" row, adds Mutual Release / Void paperwork when
those statuses are present, and syncs one document row per condition (creating and hard-deleting as
conditions change).

**Per-document fields:** title · `mandatory` · `is_condition` + `condition_id` · `manual` ·
`kind` (single vs **per_client**) · deadline (from the condition) · `status` (Pending | Received) ·
`validation` (Pending | Valid | Invalid) · `drive_uploaded` (Yes/No) · `reminder` bell ·
`agent_accepted` (Accepted | Not Accepted) · `remarks` · main file · **validation attachment** ·
`files[]` (per-client uploads) · position.

**Upload rules.**
- 20 MB per file; stored under `storage/app/documents/<txnId>/<random>.<ext>` with a random name.
- A document marked **Not Accepted** refuses uploads (422).
- A document marked **Valid** refuses replacement or deletion unless the caller is a Super Admin.
- **Agents never overwrite**: uploading over an existing main file creates a new document row with
  the same title, status `Received`, validation `Pending` — versioning by accretion, previous kept.
  Admins overwrite and the old file is unlinked from disk.
- Per-client documents compute `status` from coverage: `Received` only when every client on the deal
  has a file.

**Review workflow.** Admin sets `validation` and `remarks`. When any validation changed in a save,
the system writes a `DocReview` audit row, emails the agent the outcome, and pushes a notification.
`DocsValidationService.sync` rolls the per-document validations up into `transactions.valid_status`.

**Missing-document behaviour.** Documents flagged with the reminder bell and still `status ≠
Received` or `validation = Invalid` are chased by `POST /transactions/:id/documents/send-reminders`
(admins only; 422 if nothing is flagged or no agent email is on file). The email lists each document
and, for invalid ones, the **reason in red** from `remarks`. Reports adds bulk chasing across deals
with a preview and a `document_reminders` log.

**Deletion.** Admin removes a row → soft delete (`deleted_at`), files kept on disk. Condition rows and
`pending_delete` rows are excluded from removal. Agents may delete individual files inside a
multi-file document but not the document itself. Super Admin can permanently delete from the Recycle
Bin, which unlinks every file.

**Download.** `GET /api/documents/:id/file`, `/files/:index`, `/validation-file`, and
`/transactions/:id/documents/download-all` (ZIP). All go through `ResourceAccessService` — which
restricts **agents only**.

**Audit.** Every document action writes an audit row under section "Legal & Documents": Document
added / uploaded / replaced / version added / removed / deleted / restored / file removed /
Validation attachment uploaded/removed / "— Title|Status|Validation" updates / Acceptance updates /
Documents reviewed / Reminder sent / Ready for RECO Audit.

**Two defects here** — see §31: the `mandatory` flag is wiped on every load, and `pending_delete` is
never set, which makes the deleted-documents panel and the document restore endpoint unreachable.

---

## 14. Calendar (Transaction Desk)

**Frontend:** `CalendarPage.tsx`, `EventEditorModal.tsx`, `MiniCalendar.tsx`, `TodoList.tsx`,
`CalendarAnalyticsPanel.tsx` · **Backend:** `server/src/calendar/*`.

- **Purpose:** each user's own working diary inside the Desk, with appointments optionally linked to
  a deal.
- **Event types:** viewing · meeting · open-house · follow-up · call · showing · **inspection** ·
  **closing** · task. **Statuses:** scheduled · completed · cancelled · **no-show** · rescheduled.
- **Transaction link:** `transaction_id` on the event, validated against `transactionScopeWhere` —
  an agent cannot attach an event to a deal they cannot open, and creating/updating/deleting a linked
  event writes an audit row on that deal.
- **Recurrence:** daily / weekly / monthly with interval, until-date or count; the first occurrence
  carries the rule and is the series id; edits and deletes take `scope=this|series` where *series*
  means this occurrence **and later ones only**.
- **Overlap detection** with a "Book anyway" override, naming the clashing appointment and the
  clashing dates for a repeat.
- **Optimistic locking** — the client sends the version it read; a stale save is refused with 409 and
  the current state, and the check is repeated inside the write itself (`updateMany` with the version
  in the WHERE).
- **Holidays** — Canadian statutory holidays and festivals computed on request per province, never
  stored.
- **Reminders** — `calendar_event_reminders` + `event-reminder-scheduler.service.ts`; delivered as
  email, in-app and web push (`calendar_reminders` category).
- **Google Calendar** — `google_connections` carry a `scope` of `crm` or `desk`; events created in
  the Desk are mirrored to the Desk-connected calendar only, best-effort and non-blocking. Connect /
  disconnect is per area under that area's Settings → Integrations.
- **AI suggestions** — `POST /calendar/events/:id/suggestions` (needs `calendar:edit`, POST
  deliberately so a prefetch cannot spend the AI budget).
- **To-Do list** — `todos`, per user, stamped with the area; the Desk list and the CRM list are
  separate.
- **Analytics** — per-user completion/cancellation/no-show rates over a date range.

**Separation from the CRM Calendar:** enforced two ways — `calendar_events.domain` (`desk` | `crm`;
`null` for pre-split rows, visible in both) and the `?area=` parameter checked by `AreaGuard`. The
answer to the question asked: **yes, they are logically and technically separate.**

**Data isolation:** absolute. `scopeWhere()` is `{ user_id }` for every role — an Admin or Super
Admin cannot see an agent's calendar, and there is no admin override anywhere in the module.

---

## 15. Analytics

**Frontend:** `client/src/desk/AnalyticsPage.tsx` (86 lines) · **Backend:** none of its own — it
calls `GET /api/transactions` (unpaged) and aggregates **in the browser**.

| What exists | Detail |
|---|---|
| Total Commission (incl. HST) | sum of `commission.total` |
| Paid / Pending | sum of `commission.amount` split by `commission.paid` |
| Commission by Closing Month | bar list keyed on `closing_date` (falling back to `offer_date`) |
| Top Agents by Commission | table: agent, deal count, commission |
| By Transaction Type | table: type, deal count, commission |

**Filters:** none. **Date range:** none. **Agent filter:** none. **Export:** none. **Charts:** one
CSS bar list; no charting library.

**Role differences:** entirely a consequence of the underlying list scope — an agent sees their own
deals, everyone else sees the brokerage. Note that the `crm` role holds `analytics: 'view'` by
default and the underlying endpoint is not screen-guarded, so that role can read brokerage-wide
commission-by-agent figures despite `transactions: 'none'` (see SEC-2).

**Assessment:** *implemented but thin.* It is the least developed Desk module and duplicates figures
the Dashboard and Reports compute server-side with proper decimal arithmetic.

---

## 16. Transaction Desk Inbox

**Frontend:** `client/src/desk/InboxPage.tsx` · **Backend:** `server/src/inbox/*`.

**Where credentials come from:** `mail_accounts`, one row per connected address per user, holding
IMAP host/port/user/password and SMTP settings, encrypted with the Laravel-compatible crypt service.
Accounts are created under **Settings → Integrations** (Super Admin) or an agent's own **My
Settings**, and each carries `scope = 'crm' | 'desk' | null`.

**Does the Desk have separate mail settings?** **Yes.** The scope column is the separation, and the
Settings screen shows only the current area's integrations by design.

**How mail is fetched:** `ImapSyncService` polls on a timer (one process only, `clusterTick`), plus
`POST /api/account/inbox/sync/:accountId?area=desk` on demand — which refuses an account belonging to
the other area, and only ever looks up accounts owned by the caller.

**What the screen actually does:**

| Feature | State |
|---|---|
| Inbox list (30/page, newest first) | ✔ |
| Unread filter + unread badge (per area) | ✔ |
| Open a message (marks it seen) | ✔ |
| Mark read / unread | ✔ |
| Auto-refresh every 30 s, paused when the tab is hidden | ✔ |
| Names the mailbox being read and whether auto-sync is on | ✔ |
| Link to a matched CRM lead | ✔ (cross-area link only) |
| **Sent · Drafts · Compose · Reply · Forward · Delete · Archive · Search · Attachments** | **Not implemented** — no endpoints, no UI |

**Which mailbox is shown:** the account marked **primary** for this area; if none is marked, every
account the area can see. Falling back to a `scope: null` primary only if the area has no primary of
its own.

**Cross-contamination check — the critical question:**

| Risk | Verdict | Evidence |
|---|---|---|
| Shared mailbox rows | **No.** Every read filters `user_id` **and** the area's account scope, including `get` and `markSeen` by id. | `inbox.service.ts:63-65, 167-193` |
| Shared tokens/credentials | **No.** One `mail_accounts` row per account, each with its own scope; Google connections likewise carry a scope. | `schema.prisma:1803`, `google_connections` |
| Shared settings | **No.** Settings → Integrations renders only the current area's tab. | `SettingsPage.tsx:54-78` |
| Wrong API called | **No.** `?area=` is mandatory in practice and checked by `AreaGuard`. | `inbox.controller.ts` |
| Unread badge leakage | **Fixed** — the badge counts this area's unread only. | `inbox.service.ts:105-108` |
| Same address connected to both areas | Two separate `mail_accounts` rows with different scopes; their messages never mix. | by construction |
| Pre-split accounts (`scope: null`) | **Visible from both areas by design** — the documented "never lose an existing record" rule. This is the one place a message can appear in both inboxes, and it is deliberate. | `inbox.service.ts:64` |

**Conclusion:** the separation is real and enforced server-side, not by UI filtering.

---

## 17. Invoice Module

**Frontend:** `InvoicePage.tsx`, `InvoiceEditorModal.tsx`, `InvoicePreviewModal.tsx`, `InvoiceDoc.tsx`
· **Backend:** `server/src/invoices/*`.

**Who creates:** anyone with `invoice: 'edit'` — Super Admin, Admin, Accounting.

**Automatic generation:** yes. On transaction create, when the `transaction_desk_v2` flag is on, the
type is invoiceable and is not Preconstruction, a co-op commission invoice is generated inside a
transaction and is best-effort (a failure never blocks the deal). `POST
/api/transactions/:id/invoices` generates on demand — 200 + `existing: true` if invoices already
exist, 201 otherwise, 422 for a non-invoiceable type. **Preconstruction generates one invoice per
term.**

**Numbering:** transaction-generated → `GHR-<trade_no>` (+ `_Term n`); manual → `invoice_prefix` +
`next_invoice_no` from Company Settings, counter incremented on allocation.

**Content:** customer (id or free-text name/address/city/province/postal/country/phone/email —
defaulted from the co-op brokerage), property reference, invoice date, terms + derived due date,
trade number, listing agent(s), co-op salesperson, subject, line items (description, qty, rate,
amount, taxable), discount, tax rate (per-invoice override or the company default), notes, terms &
conditions, signature path, broker name, commission received date/via, reminders log, auto-reminder
config.

**Totals:** computed by `InvoiceCalculator.recalculate` on every create, update and payment change —
sub-total, tax total, total, amount paid, balance due, and the stored status.

**Statuses:** `Draft` · `Unpaid` · `Partially Paid` · `Paid` · `Void`; **`Overdue` is derived on
read** (past due date with a balance) and never stored. The transaction's `invoice_admin` block
exposes a second derived view — `Pending to Raise` / `Draft` / `Sent` / `Paid` / `Void`.

**Lifecycle:**

```
(auto or manual) ──► Draft/Unpaid ──► Send (stamps sent_at) ──► Record payment(s)
                                                     │                  │
                                              Record reminder      Partially Paid ──► Paid
                                                                        │
                                            past due + balance ──► displays Overdue
Delete (reason required) ──► Recycle Bin ──► restore | permanent delete (line items + payments purged)
```

**Sending:** `POST /api/invoices/:id/send` stamps `sent_at` and writes an audit row. **The actual
email dispatch is a no-op** — `emailInvoice()` has an empty body with a comment saying delivery "is
handled by the mail module"; no call is made (`invoices.service.ts:313-316`). The
`invoice.send` / `invoice.reminder` / `invoice.overdue` mail templates exist in the registry. See
INCOMPLETE-1.

**PDF:** produced **client-side** (`InvoicePreviewModal` + `InvoiceDoc` + `desk/pdf.ts` /
`printDoc.ts`). There is no server-side invoice PDF endpoint.

**Payment tracking:** `invoice_payments` (paid_on, amount, method, reference), soft-deletable and
restorable from the Recycle Bin, with totals recomputed on every change.

**Connection to transactions:** `invoices.transaction_id`; deleting the deal deletes its invoices with
the same timestamp; restoring reverses exactly that set. The deal screen shows invoice number, sent
status, commission-received date and method.

**Connection to reporting:** invoice figures feed the Dashboard tiles (permission-gated) and the
`CommissionAnalytics` panel on the Invoice screen. The 20 named reports read transactions, not
invoices.

**Scoping gap:** `InvoicesService.index()` and `show()` apply **no ownership filter at all**. Only the
screen permission stands between a role and every invoice in the brokerage.

---

## 18. Reports

**Frontend:** `ReportsPage.tsx` (category cards) → `ReportDetailPage.tsx` ·
**Backend:** `server/src/reports/*`; catalogue in `report-registry.ts`.

**All 20 reports:**

| Category | Reports |
|---|---|
| Deal Reports | Yearly Deal & Commission Summary · Team Split Deals · Sales Statement · Deal List & Price Comparison |
| Commission Reports | Brokerage Split Ratio Commission · Brokerage Lead Conversion |
| Payment Reports | Agent Advance Payment · Agent Paid – Brokerage Receivable Pending · Agent Partial Payment & Balance Due · Transaction Payment Status |
| Agent Reports | Agent Loan |
| Client and Referral Reports | Client Cashback Payment · Referral Payment |
| Review and Marketing Reports | Google Review & Gift Coupon |
| Documentation and Compliance Reports | Deal Documentation Status · RECO Audit Readiness · Amendment Documentation · Conditional Offers and Expiry · Pending and Invalid Documents · Documentation Reminder and Follow-Up |

**Filters available** (per report, declared in the registry): free-text search · deal type
(multi) · agent (multi) · payment type (multi) · closing year · offer-date range · closing-date range
· payout status · RECO ready · reminder type · sent-date range · status · split ratio (multi,
data-derived) · sections (for section-grouped reports) · match mode.

**Features:** server-side pagination (25/50/100/200, max 200), server-side sorting with a stable
secondary sort, **Customize Fields** (column selection, mandatory columns always re-appended),
decimal-safe totals and averages computed over the **complete filtered set** rather than the visible
page, applied-filter chips carried into exports, section subtotals, row expansion to a deal's
documents (pending / invalid / valid kept separate), and bulk **documentation reminders** with a
preview showing recipients, applicable document counts and duplicate warnings.

**Export:** **XLSX and PDF** (`POST /api/reports/:type/export/xlsx|pdf`), branded with the company
name, generated from the same computation as the on-screen run so the two cannot disagree. **CSV is
not offered here** — CSV exists on the transactions bulk-export routes instead.

**Role restrictions:** `@Screen('reports','view')` on the whole controller. Agents are hard-scoped in
`sanitize()`: their agent filter is overwritten with their own name, they cannot search on agent
names, and the applied-filter chip reads "*name* (your data)". Reminder history and the documents
expansion reuse the same scope, so an agent cannot read another agent's reminder log.

---

## 19. Settings (Transaction Desk)

Route `/desk/settings`. Tabs shown from the Desk (`SettingsPage.tsx:54-78`):

### Transaction Desk Settings — **Super Admin only**

| Section | Contains | Stored in | Used by |
|---|---|---|---|
| Integrations | Mail accounts (SMTP send + IMAP inbound, primary flag, test send), Google Calendar connection, other Desk integrations | `mail_accounts` (scope `desk`), `google_connections` (scope `desk`) | Desk Inbox, every outbound email, calendar mirroring |
| Templates | Every Desk mail template — subject, HTML body, active flag, attachments | `email_templates`, `email_template_attachments` | The Desk message triggers (§20) |

Both are behind `AdminGuard` on `/api/mail-accounts` and `/api/email-templates`, i.e. Super Admin.

### Company Settings — `settings:view` to open, `settings:edit` to write

| Field group | Fields | Consumed by |
|---|---|---|
| Identity | name, address, phone, email, logo | invoice header, printed documents, email footers, the sidebar logo |
| Tax & banking | `hst_number`, `bank_beneficiary`, `bank_name`, `transit_no`, `account_no`, `institution_no` | Invoice, Trade Sheet, Notice of Sale, Deposit Receipt, Lawyer Statement — and gated by the `company.read-banking` capability (Accounting and above) |
| Invoicing | `currency`, `default_tax_rate`, `invoice_prefix`, `next_invoice_no`, `default_terms`, `thank_you_note`, `deposit_heading` | invoice creation and totals |
| Automation | `feature_flags.lawyer_reminder_days` (surfaced as "Lawyer Reminder (days)") | the recurring lawyer-detail reminder cadence |
| Feature flags | `feature_flags` JSON, incl. `transaction_desk_v2` | automatic invoice generation on transaction create |

Level: **brokerage-wide, system-level** — one row (`company_settings.id = 1`). Changes are audited
under category `Settings`. Logo upload/delete are `settings:edit`.

### Roles & Permissions — gated on the `users` screen (Super Admin in practice)

Role default matrix editing, per-user overrides, module licence panel, lead books panel.

### Agent's own Settings (`/desk/account`) — every agent

Profile, their own mail accounts and signature, password, push reminders. Self-scoped server-side.

### Notification Preferences / Notification Centre — every user

Per-category, per-channel (in-app / email / push) choices, stored in `notification_preferences` keyed
`(user_id, category, channel)`. Desk-only categories: `listing_expiry`, `lawyer_details`,
`document_review`, `transaction_approvals`, `chat_mentions`.

**Not present in Transaction Desk Settings:** transaction-type configuration, document-checklist
configuration, status configuration, invoice numbering per type, or per-agent commission defaults —
the last of these lives on the **user record** (Users → profile), not in Settings.

---

## 20. Triggers & Automation

Screen: `/desk/triggers` → `DeskTriggersPanel.tsx`. It surfaces what already runs; it is not a rules
engine, and the panel says so.

### A. Scheduled — the reminder sweep

| | |
|---|---|
| **Event** | Hourly wake-up; the schedule decides what is actually due (`ReminderSchedulerService`, 60-minute interval, plus one pass 60 s after boot) |
| **Conditions** | *Listing expiry*: a non-deleted transaction with `listing_expiry_date` 1–10 days away whose status is Active. *Auto-expire*: the expiry day has passed and no terminal status is set. *Lawyer details*: a Buying/Lease deal with a missing buyer or seller lawyer detail, closing within 30 days, on the weekday its phase names — weekly (Mon) from 30 days out, twice weekly (Mon/Thu) from 15, three times weekly (Mon/Wed/Fri) from 7 |
| **Action** | Email the agent; write an audit row under section "Reminders"; for auto-expiry, replace the status rows with `Expired` |
| **Recipient** | The deal's agent, resolved through `PersonResolver` (Active account wins, ties on lowest id) |
| **Template** | `transaction.lawyer_buyer_reminder` / `..._seller_reminder` / `..._both_reminder`; listing-expiry has its own event |
| **Timing** | Nightly in effect — claimed once per calendar day |
| **Background** | In-process `setInterval`, `clusterTick` (Redis lock) so exactly one process runs a pass; `RUN_SCHEDULERS` / `REMINDER_SWEEP_DISABLED=1` |
| **Failure handling** | 4 attempts over ~7 hours (1 h, 2 h, 4 h backoff), max 100 retries per sweep; failures recorded on the reminder row |
| **Duplicate prevention** | Unique index on `transaction_reminders (transaction, kind, day, channel)` — the insert *is* the lock |
| **Kill switch** | `company_settings.feature_flags.lawyer_reminder_days = 0` disables the recurring lawyer reminder (the one-off on-save nudge still fires) — editable on this screen |

### B. Scheduled — the review SLA ladder

| | |
|---|---|
| **Event** | Hourly (`ReviewSlaSchedulerService`) |
| **Conditions** | `transaction_reviews` with `decision = 'Rejected'`, `resolution_status = 'Open'`, `sla_stage < rung`, older than the rung's threshold |
| **Action / recipient** | Rung 1 (24 h) and 2 (72 h): email the agent. Rung 3 (168 h): email the agent **and escalate to every Active admin/manager** |
| **Template** | `transaction.review_reminder`, `transaction.review_escalation` |
| **Duplicate prevention** | `sla_stage` only moves forward; a rung fires once |
| **Failure handling** | Logged, the stage still advances (no infinite retry on a broken address); the item stays visible as overdue on the dashboard |
| **Kill switch** | `REVIEW_SLA_DISABLED=1` |

### C. Event-driven message triggers (each with an Active switch)

| Event key | Fires when | Recipient |
|---|---|---|
| `invoice.send` | an invoice is issued | client / co-op brokerage |
| `invoice.reminder` | a payment reminder is recorded | client |
| `invoice.overdue` | an invoice passes its due date | client |
| `document.pending_reminder` | outstanding documents are chased on a deal | agent(s) on the deal |
| `document.reminder` | a documentation reminder is sent from Reports | agent |
| `document.review_result` | documents are reviewed | agent |
| `document.agent_upload` | an agent uploads a document | deals desk |
| `notice_of_sale.send` | a Notice of Sale is issued | lawyer / brokerage |
| `deposit_receipt.send` | a deposit receipt is issued | client |
| `trade_sheet.send` | a trade sheet is sent | recipient on the sheet |
| `agent_faq.batch_review` | an agent's batch of changes is reviewed | agent |

Switching one off (`email_templates.is_active = false`) stops the message being sent. Editing the
wording is Settings → Templates. **Both are Super Admin only** (`AdminGuard` on
`/api/email-templates`), so an Admin sees the screen with an empty message list.

### D. Automations with no switch

- Auto-invoice on transaction create (governed by the `transaction_desk_v2` feature flag).
- Auto-expire listings (part of the sweep).
- Agent split upgrade on the first Closed status past the agent's threshold.
- `DFT` forcing commission fields to `N/A`.
- `Sold`/`Leased` clearing `mls_verified`.
- Document checklist seeding and status-driven checklist changes.
- Review "Corrected" transition when an agent re-edits a rejected field.

### E. Trigger levels

| Level | Exists? |
|---|---|
| Brokerage-level | Yes — template active flags and the lawyer cadence |
| User-level | **No, for the Desk.** Per-user trigger settings (`crm_trigger_settings`) are CRM-only |

**Explicitly absent** (stated on the screen): triggers on status change, offer/closing dates,
document deadlines, payments, commissions or compliance conditions.

---

## 21. Notifications

`Event → Recipient → Template/Channel → Trigger point → Duplicate protection`

| Event | Recipient | Channels | Trigger point | Duplicate protection |
|---|---|---|---|---|
| Agent uploads a document | Deals desk | Email (`document.agent_upload`) | `documents.service.notifyDealsDesk` | none needed (one per upload) |
| Documents reviewed | Deal's agent | In-app (`DocReview` audit row) · Email (`document.review_result`) · **Push** | `documents.service.bulkUpdate` when any validation changed | one row per review save |
| Document reminder (per deal) | Agent(s) on the deal | Email (`document.pending_reminder`) | admin presses Send Reminders | 422 if nothing is flagged |
| Documentation reminder (bulk, from Reports) | Agents | Email (`document.reminder`) | Reports → Send | `document_reminders` batch log + duplicate warnings in the preview |
| Agent field change made | Admins | In-app bell (`/agent-change-notifications`, 60 s poll) | any agent save | `audit_logs.handled` |
| Change rejected / reviewed | Agent | In-app (review row + chat message) · Email · **Push** (`transaction_approvals`) | `TransactionReviewService.announce` | one review row per decision |
| Review still open at 24 h / 72 h / 168 h | Agent; +office at 168 h | Email | `ReviewSlaService.sweep` | `sla_stage` |
| Listing expiring (10-day countdown) | Agent | Email · in-app · push (`listing_expiry`) | reminder sweep | unique `(txn, kind, day, channel)` |
| Lawyer details missing | Agent | Email · in-app · push (`lawyer_details`) | reminder sweep + on-save nudge | as above, plus "only re-emails when the missing set changed" |
| Mentioned in a deal's chat | The mentioned user | In-app · Email · Push (`chat_mentions`) | `MessagesService.post` | `dedupeKey = mention-<messageId>-<userId>` |
| Calendar appointment reminder | Event owner | Email · in-app · push (`calendar_reminders`) | `event-reminder-scheduler` | `calendar_event_reminders` rows |
| New inbox mail | Mailbox owner | In-app · push (`inbox_new_mail`); **email deliberately unsupported** | IMAP poll, one summary per poll | per-poll summary |
| Invoice sent / reminded / overdue | Client | Email templates exist | — | **not wired: `emailInvoice()` is empty** |

**Delivery control:** `NotificationDispatcher` reads `notification_preferences` per (user, category,
channel) before sending anything, attempts each channel independently, and never throws at the
caller. In-app history is the **Notification Centre**, which reads `audit_logs` (`source: 'Agent'`
and `DocReview`), `transaction_reviews` and `transaction_reminders` rather than a notifications
table of its own.

---

## 22. Recycle Bin

**Frontend:** `RecycleBinPage.tsx` · **Backend:** `server/src/recycle-bin/*` ·
**Access:** Super Admin only, enforced in the service on **every** method
(`recycle-bin.service.ts:35-37`), not just in the controller or the UI.

| Tab | What lands there | Restore | Permanent delete |
|---|---|---|---|
| Transactions | soft-deleted deals (direct delete or approved request) | restores the deal **and the invoices deleted in the same instant**; writes "Record restored" to the deal's audit | `prisma.transactions.delete` → cascades everything; module audit row kept |
| Documents | soft-deleted document rows (files stay on disk) | clears `deleted_at`, writes "Document restored" | unlinks the main file, the validation file and every per-client file, then deletes the row |
| Invoices | soft-deleted invoices, with the deletion reason | clears `deleted_at` | purges line items and payments first |
| Payments | soft-deleted invoice payments | restores **and recalculates the invoice totals** | deletes and recalculates |
| Deleted rows | rows removed from `admin_activities` / `adjustments` (agent payments, CTA to BA, adjustments, advances, client referrals, external referral), captured at save time into `trashed_row_items` | re-inserts the row into the deal's JSON, re-enables its section flag, removes the trash row, audits "Row restored" | deletes the trash row |
| Deletion log | last 400 audit rows whose action contains "delet"/"remov", excluding deletion-request rows | read-only | — |

**Retention:** none — nothing expires or is auto-purged. Deleted records stay until a Super Admin
acts. (Export files *are* swept — `export_jobs` expire — but that is the Download Centre, not this.)

**Related records on restore:** transactions bring their invoices back; documents, payments and rows
restore individually. Audit rows are never deleted by a restore, and a permanent transaction delete
cascades its own audit rows away while leaving the module-level "permanently deleted" entry.

**Agent / Admin restrictions:** neither role can see the Recycle Bin, restore anything, or read the
deletion log. The API answers 403 with an explicit message, so hiding the nav is not what protects
it.

---

## 23. Audit Trail

Two surfaces over one table (`audit_logs`):

1. **Per-deal** — `AuditTrailModal` on the transaction screen (hidden from agents), fed from
   `transaction.audit_logs`.
2. **Brokerage-wide** — `/desk/audit` → `GET /api/audit-logs` (`@Screen('audit','view')`).

**Recorded per entry:** `category` · `domain` (`crm`/`desk`/`common`/null) · `transaction_id` ·
`who` (name, or "System") · `user_id` · `section` · `field` · `old_value` · `new_value` (both clipped
to 2 000 characters) · `action` · `source` (`Manual` / `Agent` / `System` / `Quick Action` /
`DocReview`) · `handled` · `details` · timestamps.

**Not recorded:** IP address, user agent, device, session id, or request id. **Unable to verify any
IP/device capture from the current implementation** — there is no such column and no writer sets one.

**What is covered.** The snapshot diff (`AuditService.snapshot`) covers 60+ scalar columns mapped to
readable section/field labels, the four JSON blocks flattened to leaves, and the ordered collections:
clients, conditions, team members (name, split %, agent %, brokerage %, scope), preconstruction terms,
brokerage contacts + listing agent names, inter-board listings, and the status set. So:

| Sensitive action | Logged? |
|---|---|
| Transaction created / removed / restored | ✔ |
| Any field edited (incl. price, deposit, commission %, splits, adjustments, trust payable) | ✔ with old → new |
| Status changed | ✔ ("Status" field, comma-joined set) |
| Documents added / uploaded / replaced / removed / deleted / restored / versioned | ✔ |
| Document validation changed + review summary | ✔ |
| Document reminders sent | ✔ (count and titles) |
| Invoice created / updated / status changed / sent / deleted / payment recorded or removed / reminder | ✔ — written **twice**, once module-level (`category: 'Invoice'`) and once against the deal |
| Assigned agent changed, team members changed | ✔ |
| Edit request raised / approved / rejected | ✔ (section "Approvals") |
| Deletion requested / forwarded / rejected / approved | ✔ |
| Review requirement overridden at close | ✔ with the reason |
| Company Settings changed | ✔ (category `Settings`) |
| Roles / permissions changed | ✔ (category `Users`, `common` domain) |
| Recycle Bin restore / permanent delete | ✔ |
| Trigger (template) switched on/off | **Unable to verify** — no audit write found in the email-template update path |
| Reading a record / downloading a document | ✖ not logged |

**Filters:** area (`crm`/`desk`) · scope (this area + shared / this area only / shared only /
everything) · category (the area's own screen labels) · user id · from/to dates · free-text across
who/section/field/old/new/action/details. **Pagination:** 50/page, capped at 20 000 pages. Invalid
filter values are refused with a named field rather than silently dropped, and LIKE wildcards in the
search term are escaped.

**Agent-made changes are deliberately excluded** from the global trail (they live in each deal's own
trail) — `audit-log.service.ts:103`.

**Export:** CSV and XLSX through `GET /api/audit-logs/export`, using the same `buildWhere` as the
listing, with `X-Export-Rows` / `X-Export-Truncated` headers so a truncated export can say so.

**Retention:** none. Nothing prunes `audit_logs`.

---

## 24. Background Jobs & Schedulers

Master switch: `schedulersEnabled()` (`common/schedulers.ts`) — off in tests; off by default under a
process manager (`NODE_APP_INSTANCE` present) unless `RUN_SCHEDULERS=true`; on otherwise. Health is
observable at `GET /api/health/workers`.

| Job | Purpose | Frequency | Env switch | Dependencies | If disabled | Failure / retry | Duplicate prevention |
|---|---|---|---|---|---|---|---|
| `reminder-sweep` | Listing-expiry countdown, auto-expire, lawyer-detail chasing | hourly + 60 s after boot | `RUN_SCHEDULERS`, `REMINDER_SWEEP_DISABLED=1` | DB, SMTP, `company_settings` | No expiry or lawyer reminders; listings still auto-expire lazily on read | 4 attempts, 1 h/2 h/4 h backoff, ≤100 retries per pass | unique `(txn, kind, day, channel)` + Redis `clusterTick` |
| `review-sla` | Chase unresolved rejections, escalate at a week | hourly | `REVIEW_SLA_DISABLED=1` | DB, SMTP | Rejections are never chased | logged, stage still advances | `sla_stage`, `clusterTick` |
| `event-reminder` | Calendar appointment reminders | timer | scheduler flags | DB, SMTP, VAPID keys | No appointment reminders | per-reminder rows | `calendar_event_reminders` |
| `imap-sync` | Poll connected mailboxes | timer, immediate first pass | scheduler flags | IMAP hosts | Inbox only updates on manual sync | per-account error recorded | `clusterTick` |
| `mail-retention` | Prune stored inbound mail | timer | scheduler flags | DB | Mail grows unbounded | logged | `clusterTick` |
| `export-sweeper` | Expire and clean up export files | timer | scheduler flags | disk | Export files accumulate past `expires_at` | logged | `export_jobs.status` |
| Export queue drain | Generate queued exports one at a time | on enqueue | — | DB, disk | Queued exports never complete | job marked failed, never throws | `request_hash` + `requested_by_id` blocks an identical in-flight request |
| `google-calendar-sync` retry | Push events to Google | timer | scheduler flags | Google OAuth | Events are not mirrored | best-effort | per-event |
| `lawyer-reminder` (legacy) | Old recurring lawyer reminder | **idle** — deliberately superseded by the sweep; the class is kept callable | — | — | — | — | — |

CRM-only schedulers (campaign resume, lead greetings, lead welcome, lead-task reminders, Meta sync,
lead retention) are out of scope.

---

## 25. Data Model

```
users ──< user_permissions            (screen overrides)
  │   ──< user_modules                (crm | desk assignment)
  │   profile JSON: agent_comm_pct, lease_comm_pct, brok_comm_pct,
  │                 completed_deals, upgrade_agent_pct, split_upgraded
  │
  └──(by name, and by agent_user_id)──┐
                                      ▼
                               TRANSACTIONS  (soft delete: deleted_at)
                                      │  trade_no UNIQUE
   ┌──────────────┬──────────────┬────┴─────┬──────────────┬─────────────────┐
   ▼              ▼              ▼          ▼              ▼                 ▼
transaction_    clients      conditions   brokerages    team_members    documents
statuses                        │            │             │            (soft delete)
(many: a deal            documents ◄─────────┘             │
 holds a set)            (one per                   team_member_terms
                          condition)   brokerage_agents
   ▼              ▼              ▼          ▼              ▼
inter_board_   precon_terms  transaction_  transaction_  transaction_
listings                     messages      reviews       reminders
                                 │            │
                     transaction_message_    ├─ transaction_review_messages
                     reads                   └─ transaction_review_attachments
   ▼
INVOICES (soft delete) ──< invoice_line_items
   │                    ──< invoice_payments (soft delete)
   └──> customers

transaction_edit_requests ─┐
transaction_delete_requests┤── approval workflows
trashed_row_items ─────────┘── Recycle Bin capture for JSON rows

AUDIT_LOGS (transaction_id nullable; domain crm|desk|common|null)
document_reminders · export_jobs · import_batches · calendar_events · todos
company_settings (singleton) · email_templates · mail_accounts · subscriptions
```

**Ownership & scope**

- A transaction is owned by `agent` (name string) with `agent_user_id` as the resolved id.
  **The visibility predicate uses the name, not the id** — see SEC-3.
- Team membership (`team_members.name` + `access` of `full` | `docs`) widens visibility and,
  at `full`, edit rights.
- Everything hanging off a transaction inherits its scope through
  `ResourceAccessService.assertTransaction`.
- Calendar events and to-dos are owned by `user_id` and are private to that user for every role.
- Mail accounts, inbound mail, notification preferences and push subscriptions are per user.
- Company settings, email templates and the licence are brokerage-wide singletons.

**Soft deletes:** `transactions`, `documents`, `invoices`, `invoice_payments`, `calendar_events`,
`todos`, `leads`. Everything else is hard-deleted or cascaded.

**Status fields:** `transactions.comm_status` / `comm_paid_status` / `valid_status` /
`reco_audit_ready`; `transaction_statuses.status` (a set); `documents.status` / `validation` /
`agent_accepted`; `invoices.status`; `transaction_reviews.decision` / `resolution_status`;
`transaction_edit_requests.status` (pending → approved → applied | rejected);
`transaction_delete_requests.status` (pending → forwarded → approved | rejected).

**Timestamps:** every table carries `created_at` / `updated_at`; deletion via `deleted_at`; the
review lifecycle adds `corrected_at`, `resolved_at`, `first_response_at`, `agent_seen_at`,
`sla_notified_at`; the deal carries `agent_review_at`, `trade_sheet_sent_at`.

---

## 26. Data Privacy / Agent Isolation

Can Agent A reach Agent B's Transaction Desk data? Verified **at the backend query level**, not from
the UI.

| Surface | Isolated? | Enforcement |
|---|---|---|
| Transaction list | ✔ | `transactions.service.ts:61-76` — own + split, unassigned deals excluded |
| Transaction detail | ✔ | `authorizeAgentAccess` |
| Deal chat + mentions | ✔ | `ResourceAccessService.assertTransaction`; mention candidates re-checked per person |
| Documents (list, files, validation files, ZIP) | ✔ | `guardAgent` + `ownedDocument` → `assertTransaction` |
| FINTRAC identifications | ✔ | same service |
| Review history / threads / attachments / export | ✔ | `assertMayRead` |
| Reports (all 20) | ✔ | `sanitize()` forces the agent filter; search haystack excludes agent names |
| Report document expansion, reminder history | ✔ | same loader, same scope |
| Live bulk export / documents ZIP | ✔ | `bulk-export.service.ts:90` |
| **Queued (background) export** | ✖ **LEAK** | `export-job.service.ts:201` rebuilds the user as `role: 'admin'` |
| Dashboard tiles | ✔ (undercounts split deals) | `area-dashboard.service.ts:273` |
| Dashboard commissions | ✔ | own name only |
| Review widgets / error charts | ✔ | `agent_name` filter |
| Analytics | ✔ (inherits the list scope) | |
| Invoices | n/a — agents hold `invoice: 'none'`; **no ownership filter exists** if granted | `invoices.service.ts:36-57` |
| Calendar | ✔ for every role | `{ user_id }` |
| Inbox | ✔ | `{ user_id }` + account scope |
| Notifications / Notification Centre | ✔ | per-user |
| Deleted transactions | ✔ | Recycle Bin is Super Admin only |
| Audit trail (global) | ✔ | `audit: 'none'` for agents |
| Per-deal audit rows | ◐ | serialised into the transaction payload for anyone who can read the deal; the button is hidden for agents but the data is in the response |
| Reminder history endpoint | ✔ | explicit `isAdminOrAbove` |
| Export history / download token | ✔ | agents see only their own jobs |
| Agent names / commission profiles | ◐ | `GET /api/agents`, `/agent-commissions`, `/agent-emails`, `/agent-loans` are **AuthGuard only** — any signed-in user can read every agent's name, email, commission split and loan balance |

### SECURITY / PRIVACY RISKS

> **SEC-1 — BLOCKER · Queued exports run with elevated privilege.**
> **Module:** Transactions → Download All / Export & Download Centre.
> **File:** `server/src/reports/export-job.service.ts:201`.
> The worker reconstructs the requesting user as
> `{ id, name, role: 'admin' }`. `BulkExportService.resolve()` decides agent scoping from
> `user.role === 'agent'`, so the queued job loads **every transaction in the brokerage**. The
> "Download All Transactions" button queues automatically whenever the result set exceeds 25 rows
> (`TransactionsPage.tsx:113`) with `all_matching: true`, and the finished file is downloadable by
> the requester (`mayAccess` → own job). The enqueue-time count is computed with the *real* user, so
> the job even reports the agent's own deal count next to a file containing everyone's.
> **Impact:** any agent obtains the whole brokerage's deal data — prices, clients, commissions,
> splits, adjustments, referrals.

> **SEC-2 — SECURITY / ROLE ISSUE · Transaction reads are not screen-guarded.**
> `TransactionsController` applies `@Screen('transactions','edit')` to create/update/delete but
> **not** to `GET /api/transactions` or `GET /api/transactions/:id`
> (`transactions.controller.ts:209-223`). The same is true of `GET
> /api/transactions/:id/documents`, the three document download routes, the documents ZIP,
> `GET /api/transactions/:id/identifications`, `GET /api/transactions/:id/messages` and the review
> endpoints. There is no global `ScreenGuard` (`app.module.ts` registers only `CsrfGuard` and the
> throttler). Consequences:
> - the **`crm` role**, whose map is explicitly `transactions: 'none'`, can read every deal
>   including the full commission breakdown, every document file, and every deal chat;
> - a user whose `transactions` permission was deliberately revoked keeps read access;
> - the module/area check that `ScreenGuard` performs is skipped too, so a CRM-only user reaches
>   Desk data.
> Only the *navigation* hides these screens.

> **SEC-3 — SECURITY · Agent scoping keys on a name string.**
> `common/transaction-scope.ts` and `authorizeAgentAccess` compare `transactions.agent` to
> `user.name`. `agent_user_id` exists and is populated, and `PersonResolver` exists precisely because
> two active accounts in this database share a name (documented at `dashboard.service.ts:150-171`).
> Two agents with the same name therefore see each other's deals, and renaming a user silently
> transfers or removes visibility.

> **SEC-4 — PRIVACY · Brokerage-wide agent financial reference data is auth-only.**
> `GET /api/agent-commissions` and `/api/agent-loans` (`agents/agents.controller.ts`) are guarded by
> authentication alone and return every agent's commission split and outstanding loan balance to any
> signed-in user, including agents.

> **SEC-5 — PRIVACY (lower) · Invoices have no ownership scoping.**
> `InvoicesService.index()/show()` filter only on `deleted_at`. Any principal holding `invoice:view`
> — including an agent granted it by a per-user override — sees every invoice in the brokerage. The
> Dashboard was fixed for exactly this reason (`area-dashboard.service.ts:309-332`); the module
> itself was not.

---

## 27. Frontend vs Backend Verification

| Capability | Frontend | Backend | Permission | Verdict |
|---|---|---|---|---|
| Transaction list/detail | gated on `transactions:view` | **no screen guard** | map says `none` for `crm` | **Mismatch — backend weaker** (SEC-2) |
| Transaction create/edit/delete | gated | `@Screen('transactions','edit')` | matches | ✔ |
| Agent financial fields | hidden in the UI | stripped in `AGENT_LOCKED` | matches | ✔ defence in depth |
| Closed / DFT locks | banners + disabled Save | refused in the service | matches | ✔ |
| Delete vs Request Deletion | branches on `isAgent` | `destroy` refuses agents; `store` on delete-requests requires `isAgent` | matches | ✔ |
| Approve deletion | shown only to Super Admin | `isSuperAdmin` | matches | ✔ |
| Recycle Bin | Super-Admin-only route + in-page guard | `isSuperAdmin` in every service method | matches | ✔ |
| Document delete | hidden from agents | refused for agents | matches | ✔ |
| Valid-document lock | not visibly indicated | 403 from `guardValidLocked` | Super Admin | UI does not warn until the request fails — minor UX gap |
| Desk trigger on/off buttons | rendered without a `canEdit` check | `AdminGuard` | Super Admin | **Latent mismatch**, masked because the template list is empty for others |
| Trigger cadence | disabled without `settings:edit` | `@Screen('settings','edit')` | matches | ✔ |
| Users screen | `superAdmin: true` on the route (comment explains it was previously driven by the `users` permission and produced a 403-ing page) | `AdminGuard` | matches | ✔ |
| Invoice tiles on the dashboard | hidden when `invoices === null` | withheld server-side | matches | ✔ |
| Reports agent filter | rendered for non-agents | overwritten server-side for agents | matches | ✔ |
| Audit export | button present | same guards as the listing | matches | ✔ |
| `POST /api/documents/:id/restore` | called from the "deleted documents" panel | exists, but only clears `pending_delete` | Admin (`documents.administer`) | **Dead** — nothing ever sets `pending_delete = true` |
| `documents.mandatory` | shown as a per-row checkbox and counted in stats | wiped to `false` on every index load | — | **Functionally dead field** |
| `emailInvoice()` | "Send Email" button reports success | empty method — no mail is sent | — | **Incomplete** |
| `LawyerReminderSchedulerService` | not referenced by any screen | timer deliberately not started; `sweep()` kept callable | — | Intentionally dormant, documented |
| CSV export of reports | not offered on the report screen | not implemented for reports (exists for transactions bulk) | — | Consistent |
| `mls_type` / `precon_*` nulling on create | — | reproduces a Laravel quirk for response parity | — | Deliberate, documented |

**Endpoints with no UI:** `GET /api/transactions/reminders/history` (admin-only reminder history) is
served but no Desk screen calls it; the Documentation Reminder report covers similar ground.

**Duplicate implementations:** invoice audit rows are written twice by design (module-level and
deal-level). Commission totals are computed server-side *and* re-summed in the browser by
`AnalyticsPage`, which is a genuine duplicate of logic that exists more accurately on the server.

---

## 28. Real-World Agent Workflow

**Scenario A — Priya's accepted offer on 14 Elm Street.**

1. Signs in; lands on `/desk/dashboard`; sees her own deal counts, her T4A pipeline, her calendar and
   to-dos. No invoice tiles.
2. Transactions → **+ Add Transaction**: type *Residential Buying*, property `14 Elm St, Unit 5`,
   price, deposit, offer date, closing date, commission 2.5 %. The duplicate guard checks for an
   existing deal with the same type/price/offer date and a fuzzy address match; hers is new. Trade
   number `007` is issued; she is set as the agent automatically; an invoice `GHR-007` is generated
   in the background.
3. Opens the deal in Edit mode. Adds the two buyers with emails and phones, the co-operating
   brokerage and its listing agent, the conditional-offer flag with a Financing condition due in
   10 days, and the buyer's lawyer. Auto-save writes each change; each becomes an audit row tagged
   `Agent`.
4. Because the seller's lawyer is still blank, she receives a lawyer-detail email; the sweep will
   chase her weekly, then twice a week, then three times a week as closing approaches.
5. **Legal & Docs**: uploads the APS, the FINTRAC ID for each buyer (per-client upload), the
   deposit cheque image and the confirmation of co-operation. Each upload emails the deals desk. She
   marks the RECO Guide "Accepted".
6. Uses **Chat** to ask the desk about the deposit, `@`-mentioning the transaction coordinator, who
   gets an in-app, email and push notification.
7. Two days later her bell shows "Document review updates": the FINTRAC ID for the second buyer was
   marked **Invalid — expired ID**. She re-uploads; her upload creates a new version rather than
   overwriting the old one.
8. Her bell also shows a rejection: she had changed the closing date and the office rejected it with
   "APS says the 30th". The value was reverted automatically. She corrects the date; the review item
   moves to **Corrected** by itself. Had she ignored it, she would have been emailed after a day,
   three days, and a week — the last also to the office.
9. She cannot see the commission fields as editable, cannot delete the deal (only **Request
   Deletion**), cannot open the Invoice, the Audit Trail, the Recycle Bin or Settings.
10. Reports → *Deal Documentation Status* shows only her deals, with the agent chip reading
    "Priya (your data)".

## 29. Real-World Admin Workflow

**Scenario B — the office processes Priya's deal.**

1. The topbar bell shows "Agent changes to review · 14 Elm St ·6". Opening the deal clears the
   document notifications and shows the change list.
2. **Review:** ticks five changes and presses *Mark reviewed* with the note "Verified against APS";
   selects the closing-date change and presses *Reject* with the reason "APS says the 30th". All
   unhandled agent rows are marked handled, `agent_review_at` is stamped, a `Reviewed` record and a
   `Rejected` record are written, a message is posted to the deal chat, and Priya is emailed.
3. **Documents:** works down Legal & Docs setting Validation to Valid/Invalid with remarks; ticks the
   reminder bell on the two still outstanding and presses *Send Reminders* — Priya gets one email
   listing them, with the invalid reason in red. Sets *Ready for RECO Audit* = Yes.
4. **Corrections:** fixes the property address typo and the co-op brokerage invoice email directly —
   these are `Manual` audit rows, not review items.
5. **Financial:** opens the Financial modal, confirms the 2.5 % commission, the listing/co-op split
   and the team split (Priya 90 / brokerage 10 from her profile). Records an advance payment in the
   Adjustment modal and the agent commission payment in Admin Activities. Removing a stale adjustment
   row captures it to the Recycle Bin automatically.
6. **Approval:** issues the **Trade Sheet**, then the **Notice of Sale** — after which team members
   can no longer be changed by non-admins.
7. **Invoice:** opens `GHR-007`, checks the co-op brokerage details pulled from the deal, presses
   *Send Email* (which stamps `sent_at`; note that no mail is actually dispatched today), then
   records the payment when it arrives. The invoice moves Unpaid → Paid and the totals recompute.
8. **Closing:** sets the status to `Closed`. The save is refused with 422 because one review item is
   still Open; the Admin either resolves it or supplies an override reason, which is written to the
   audit trail as "Review requirement overridden". On success, Priya's split-upgrade check runs.
9. **Reporting:** runs *Transaction Payment Status* and *Sales Statement* for the month, customises
   the columns, and exports XLSX for the bookkeeper.
10. **Audit:** `/desk/audit` filtered to category *Transactions* for the week, exported as CSV for the
    file.

**What the Admin cannot do:** edit the deal now that it is Closed, approve their own edit request,
approve a deletion, open the Recycle Bin, change a document already marked Valid, or touch Users,
Roles or Transaction Desk Settings.

## 30. Real-World Super Admin Workflow

**Scenario C — brokerage oversight.**

1. **Dashboard** — brokerage-wide deal counts, validation and commission-status breakdowns, closings
   ahead and overdue, documents outstanding, all four invoice tiles, brokerage gross commission and
   both referral totals, plus the review widgets and the recurring-error charts ("what keeps going
   wrong, and how long it takes to put right").
2. **Transactions** — every deal, unfiltered. Handles the exceptions: approves the Admin's edit
   request on a DFT deal, edits a Closed deal to correct a commission figure, and approves the
   deletion request the Admin forwarded (soft delete + invoices).
3. **Analytics** — brokerage commission by month, top agents, by type. (Thin; the real numbers come
   from Reports.)
4. **Reports** — *Brokerage Split Ratio Commission*, *Agent Loan*, *Agent Paid – Brokerage Receivable
   Pending*, *RECO Audit Readiness* before an audit, with XLSX/PDF exports.
5. **Settings → Transaction Desk** — connects the brokerage mailbox (SMTP + IMAP, marks it primary),
   edits the wording of the document-reminder and invoice templates, switches the
   `agent_faq.batch_review` trigger off for a month.
6. **Settings → Company** — updates the HST number and the banking block (which the Trade Sheet,
   Notice of Sale, Deposit Receipt, Lawyer Statement and Invoice all print), the default tax rate and
   the invoice prefix.
7. **Settings → Roles & Permissions** — grants Accounting `invoice: edit`, revokes `audit` from a
   departing manager, assigns the Desk module to a new hire, and reviews the licence panel.
8. **Users** — creates the new agent, sets `agent_comm_pct` 85 with an upgrade to 90 after 10 closed
   deals; the deal financials pick this up immediately.
9. **Triggers** — sets the lawyer-reminder cadence to 4 days (0 would switch the recurring reminder
   off entirely).
10. **Audit Trail** — scope *Everything*, filtered to the departing manager's user id for the last
    quarter, exported to XLSX.
11. **Recycle Bin** — restores a deal deleted in error (its invoices come back with it), permanently
    destroys a duplicate deal created during testing, and reads the deletion log.

---

## 31. Existing Problems / Risks

> **STATUS, 2026-08-14.** B-1, S-1, S-2 and S-3 have been fixed and are covered by
> `server/src/core/transaction-identity.spec.ts` (12 tests) plus migration
> `20260814090000_transaction_owner_ids`. They are kept below with their original description so the
> record of what was wrong survives, each marked **FIXED** with what changed. Everything not marked
> FIXED is still open.

### BLOCKER

| Id | Finding | Evidence |
|---|---|---|
| **B-1 — FIXED** | **Queued exports ran as `role: 'admin'`**, so an agent's background export contained the whole brokerage. The worker now re-reads the requester from `requested_by_id` with their permission and module rows, and **fails the job** rather than substituting another identity when that account is gone or deactivated. | `reports/export-job.service.ts` (`requesterOf`), spec: "a queued export runs as the person who asked for it" |

### SECURITY / PRIVACY RISK

| Id | Finding | Evidence |
|---|---|---|
| **S-1 — FIXED** | Transaction, document, identification, chat and review **read** endpoints had no `@Screen` guard and there is no global screen guard — the `crm` role (`transactions: 'none'`) and any user whose permission was revoked keep full read access. | `transactions.controller.ts:209-223`; `documents.controller.ts:26-88`; `messages.controller.ts`; `app.module.ts:109-121` |
| **S-2 — FIXED** | Agent visibility was keyed on the **name string**, while `agent_user_id` exists and the codebase documents that two active users share a name here. | `common/transaction-scope.ts`; `dashboard.service.ts:150-171` |
| **S-3 — FIXED** | `GET /api/agent-commissions` and `/api/agent-loans` exposed every agent's split and loan balance to any signed-in user. Now `@Screen('transactions','view')` on all four routes, and the three money maps return only the caller's own row for agents. | `agents/agents.controller.ts`, `agents/agents.service.ts` (`mine`) |
| **S-4** | Invoice list/detail carry **no ownership filter**; only the permission default keeps agents out. | `invoices/invoices.service.ts:36-57` |
| **S-5** | The per-deal `audit_logs` array is serialised into the transaction payload for anyone who can read the deal, including agents, even though the Audit Trail button is hidden from them. | `transaction.resource.ts:323-336`; `TransactionDetailPage.tsx:1106` |

### ROLE / PERMISSION ISSUE

| Id | Finding | Evidence |
|---|---|---|
| **R-1** | An **agent can create a `scope: 'financial'` edit request**. The guard only refuses Super Admins ("can edit directly") and the `isAdminOrAbove` check is in the `else` branch. Harmless today (approval is Super-Admin-only and the agent's financial fields are stripped anyway) but it is not the intended shape. | `workflows/edit-requests.service.ts:29-34` |
| **R-2** | Desk trigger on/off buttons render without the `canEdit` check the cadence field uses; masked only because the template fetch 403s for non-Super-Admins. | `DeskTriggersPanel.tsx:58, 168` |
| **R-3** | `accounting` and `documentation` hold `transactions: 'edit'` and therefore full brokerage write access to deals, including status changes and deletion (`destroy` refuses agents only). Whether Documentation should be able to delete a transaction is a policy question the code answers "yes". | `permission.service.ts:122-134`; `transactions-write.service.ts:792-795` |

### FUNCTIONAL ISSUE

| Id | Finding | Evidence |
|---|---|---|
| **F-1** | `documents.mandatory` is **reset to false on every documents load**, so the Dashboard's "mandatory missing" tile and the reports' `missing_mandatory` / "Required" column are structurally always 0/No — while the admin UI still offers a Mandatory checkbox that is silently discarded on the next load. | `documents/documents.service.ts:93`; `document-defaults.service.ts:4`; `area-dashboard.service.ts:307`; `report-documents.ts:105-106` |
| **F-2** | The Desk dashboard scopes an agent to `{ agent: name }` only, omitting deals they are split into — so the tiles disagree with the Transactions list for split-only agents. | `area-dashboard.service.ts:273` vs `transactions.service.ts:64-75` |
| **F-3** | The `Suspended` listing status has no coded effect anywhere — no lock, no checklist change, no automation. | `reference/transaction.constants.ts`; `TransactionDetailPage.tsx` status handling |
| **F-4** | Status changes are unvalidated: any status in the type's vocabulary can be applied from any other, including re-opening a `Closed` deal by removing the status (Super Admin only in practice, since Closed locks editing). | `transactions-write.service.ts:557-568` |

### INCOMPLETE FEATURE

| Id | Finding | Evidence |
|---|---|---|
| **I-1** | **Invoice email is not sent.** `send()` and `recordReminder()` stamp state, audit it and call `emailInvoice()`, which is an empty method. The `invoice.send` / `invoice.reminder` / `invoice.overdue` templates exist and the Triggers screen lists them as live. | `invoices/invoices.service.ts:273, 283, 313-316` |
| **I-2** | **Analytics** has no filters, no date range, no agent selector, no export, and computes in the browser from the full transaction list. | `AnalyticsPage.tsx` |
| **I-3** | **Desk Inbox is read-only** — no compose, reply, forward, delete, archive, search, drafts, sent or attachments. | `InboxPage.tsx`, `inbox.controller.ts` |
| **I-4** | **No trigger engine.** Nothing watches status changes, dates, deadlines, payments or commissions. The screen says so. | `DeskTriggersPanel.tsx:185-193` |
| **I-5** | `invoices.auto_reminder` is stored and returned but nothing reads it to schedule anything. | `invoices.service.ts:350`; no scheduler references it |

### UX ISSUE

| Id | Finding | Evidence |
|---|---|---|
| **U-1** | A document marked `Valid` shows no lock indicator; the user discovers the restriction only when the upload or delete fails with a 403. | `documents.service.ts:318-320` |
| **U-2** | Deletion and edit-request reasons are collected with `window.prompt`, unlike the rest of the application's modal dialogs. | `TransactionsPage.tsx:187`; `TransactionDetailPage.tsx:663, 675` |
| **U-3** | "Download All Transactions" silently switches between a direct download and a queued job at 25 rows; the user is told only by a toast that redirects them to the Download Centre. | `TransactionsPage.tsx:108-124` |
| **U-4** | The Triggers screen shows an Admin a reminder cadence they may not be able to save and an empty message-trigger list with no explanation of why it is empty. | `DeskTriggersPanel.tsx:69-71, 150` |

### DEAD / UNUSED CODE

| Id | Finding | Evidence |
|---|---|---|
| **D-1** | `documents.pending_delete` is **never set to `true`** anywhere in the codebase. The `deleted_documents` payload, the "review deleted documents" panel (`canReviewDeleted`) and `POST /api/documents/:id/restore` can therefore never act on anything. | grep across `server/src`: only reads and one reset-to-false |
| **D-2** | `GET /api/transactions/reminders/history` is implemented and admin-guarded but no Desk screen calls it. | `transactions.controller.ts:184-197` |
| **D-3** | `LawyerReminderSchedulerService` no longer starts its timer (superseded by the sweep). Deliberate and documented; the class remains for manual/test invocation. | `lawyer-reminder-scheduler.service.ts:29-40` |
| **D-4** | `matchingYears()` accepts a `_scope` argument it deliberately ignores. | `transactions.service.ts:141` |
| **D-5** | `auditInvoice()` takes an `invoiceId` it discards (`void invoiceId`), and `mapFields()` takes `settings` it discards. | `invoices.service.ts:303-304, 318-319` |

### RECOMMENDED IMPROVEMENT

1. ~~Add `@Screen('transactions','view')` to every transaction-derived read route~~ — **done**: the
   permission is now declared once on each controller class, so a route added later inherits `view`
   without anybody remembering to decorate it.
2. ~~Carry the real role into queued export jobs~~ — **done**: the requester is re-read at run time.
3. ~~Move the agent visibility predicate to `agent_user_id`~~ — **done**: `common/transaction-scope.ts`
   is now the single definition and matches on the id wherever the row has one.
   **Still outstanding from this:** `transaction_reviews.agent_name` and
   `notification_center`'s agent feed filter on a NAME snapshot, so two same-named agents still see
   each other's *review items* (field label, reason, old/new value). Closing that needs a user-id
   column on `transaction_reviews` and a backfill. Migration `20260814090000_transaction_owner_ids`
   also reports any deals whose name matches more than one account — those keep the name fallback
   and must be assigned by hand.
4. Either restore the `mandatory` concept or remove it from the dashboard tile, the reports column and
   the admin checkbox (fixes F-1).
5. Either implement `pending_delete` (a soft "requested deletion" state for documents) or delete the
   panel and the endpoint (fixes D-1).
6. Wire `emailInvoice()` to `MailerService` using the existing `invoice.*` templates, or relabel the
   button as "Mark as sent" (fixes I-1).
7. Scope `InvoicesService.index()` by the caller the way the dashboard now does (fixes S-4).
8. Give Analytics the server-side treatment Reports already has, or fold it into Reports.
9. Add a retention/prune policy for `audit_logs` and the Recycle Bin.
10. Record IP/user-agent on audit rows for the actions that carry money or permissions.

---

## 32. Incomplete or Unused Functionality — Classification

| Feature | Classification |
|---|---|
| Transactions (CRUD, statuses, team split, conditions, clients, brokerage, lawyers) | **Implemented and working** |
| Commission engine (%, fixed, listing/co-op, adjustments, HST, team splits, preconstruction terms) | Implemented and working |
| Documents (seeding, per-client, versions, validation, reminders, RECO flag) | Implemented and working |
| Review lifecycle (reject/approve, revert, threads, SLA ladder, exports, widgets) | Implemented and working |
| Edit-request and delete-request workflows | Implemented and working |
| Invoice module (generation, totals, payments, statuses, Recycle Bin) | Implemented; **email delivery incomplete** |
| Reports (20 reports, filters, columns, totals, XLSX/PDF, reminders) | Implemented and working |
| Bulk import / bulk export / export queue | Implemented; **export queue mis-scoped** |
| Recycle Bin | Implemented and working |
| Audit Trail (+ export) | Implemented and working |
| Reminder sweeps (listing expiry, auto-expire, lawyer details) | Implemented and working |
| Desk Calendar + To-Dos + Google mirroring + push | Implemented and working |
| Desk Inbox | **Implemented but incomplete** — read-only |
| Analytics | **Implemented but incomplete** — no filters, no export, client-side |
| Triggers screen | Implemented as a surfacing screen; **no rules engine** (stated) |
| Mandatory documents | **Disabled in one place, still surfaced in two** |
| Document `pending_delete` / restore panel | **Dead code** |
| `auto_reminder` on invoices | **Backend-only, unused** |
| Reminder-history endpoint | **Backend-only, no UI** |
| Legacy lawyer-reminder scheduler | **Intentionally dormant** |
| Status/date/deadline/payment triggers | **Planned / not implemented** |
| E-signature, client portal, MLS write-back, payment gateway | **Not implemented, not planned in code** |

---

## 33. Final Transaction Desk Capability Summary

**In one paragraph.** The Transaction Desk takes a real-estate deal from the moment an offer is
accepted to the moment the file is closed and archived. It issues the trade number, holds every fact
about the deal, computes the money server-side, keeps the document file with a per-type checklist and
a validation record, and — its distinguishing feature — treats *the office's review of the agent's
work* as first-class data with its own lifecycle, conversation, reminder ladder and reporting. It
locks the file progressively as the deal becomes final, routes every irreversible act (editing a
locked deal, deleting a deal, restoring anything) through an approval chain that terminates at the
Super Admin, and writes a field-level audit trail of everything in between. Around that core sit
twenty reports, an invoice module, a per-user calendar and inbox, a bulk import/export pipeline, and
an hourly sweep that chases expiring listings and missing lawyer details without anyone asking.

**Who does what, in one line each.**

- **Super Admin** — sees and does everything; the only role that can edit a Closed deal, approve edits
  and deletions, override a Valid document, open the Recycle Bin, manage users, roles, licences,
  mail accounts and templates.
- **Admin** — runs the desk: creates and edits deals, reviews and rejects agent changes, validates
  documents, processes the money, issues the paperwork, invoices and collects, reports, and reads the
  audit trail. Escalates anything final to the Super Admin.
- **Agent** — works their own deals and the deals they are split into: creates them, fills them in,
  uploads documents, answers rejections, chats to the desk, and reads their own reports, analytics
  and commission figures. Cannot touch money fields, cannot delete, cannot review, cannot administer.

**The three things to fix first:** the queued-export privilege escalation (B-1), the missing screen
guards on transaction reads (S-1), and name-based agent scoping (S-2).

---

## 34. Remediation — 2026-08-14

Two rounds of fixes were applied after the audit. Everything below is in the working tree, typechecks
clean and is covered by the suite (1,554 passing). The 2 assertion failures and 7 compile failures
that remain are pre-existing and unrelated: the unresolved `auth.service.ts` merge conflict, and an
uncommitted `mail-event-registry.ts` change that adds four variables to the unescaped allow-list
without updating its spec.

### Round 1 — the four P0s

| Id | Fix | Where |
|---|---|---|
| B-1 | Queued exports re-read the requester from `requested_by_id` with their permission and module rows, and **fail** rather than substituting an identity | `reports/export-job.service.ts` |
| S-1 | `@Screen('transactions', …)` declared once per controller class on all seven transaction-derived controllers, so a route added later inherits `view` by default | `transactions`, `messages`, `documents`, `fintrac`, `quick-actions`, both `workflows` controllers |
| S-2 | Ownership matches on `agent_user_id` / `team_members.user_id` wherever the row has one; the name decides only rows that never resolved | `common/transaction-scope.ts` + 13 call sites; migration `20260814090000_transaction_owner_ids` |
| S-3 | Agent reference endpoints behind `transactions:view`; the three money maps return only the caller's own row for an agent | `agents/*` |

### Round 2 — remediation scope

| Item | Fix | Where |
|---|---|---|
| Invoice authorization | New `invoices.access` capability — a **named role set** (`admin`, `manager`, `accounting`), because `documentation` shares Accounting's rank and must be refused. Enforced by `InvoiceAccessGuard` on the whole controller **in addition to** the screen permission, so a mistaken override grants nothing. Agents receive **no** invoice access at any scope. | `core/authz.ts`, `invoices/invoice-access.guard.ts` |
| …indirect leaks | `invoices` and `invoice_admin` removed from the transaction payload for anyone without the capability; the dashboard's invoice figures now require the capability as well as the permission | `transactions/transaction.resource.ts`, `dashboard/area-dashboard.service.ts` |
| Agent audit exposure | `audit_logs` and `agent_changes` withheld from agents entirely — they carried every old and new value including commission, splits and approval decisions, on a screen whose Audit Trail button is already hidden from them | `transactions/transaction.resource.ts` |
| Mandatory documents | The `updateMany(mandatory → false)` that ran on every document load is gone. The dashboard's "mandatory missing" now means what the reports' `missing_mandatory` means (mandatory and **not Valid**, rather than "file not arrived"), and all three document counts now exclude deleted rows | `documents/documents.service.ts`, `dashboard/area-dashboard.service.ts` |
| Invoice send | The email is **sent before anything is recorded**. `emailInvoice()` was an empty method: `sent_at`, the audit row and the 200 were all written for a message that never left. A delivery failure now fails the request with the reason and leaves the invoice untouched. The PDF the browser has always posted is now actually attached. Reminders follow the same order. Resending does not move `sent_at` | `invoices/invoices.service.ts`, `invoices/invoices.controller.ts` |
| Status integrity | `statusSetProblem()` rejects two terminal statuses together (`Closed + DFT`, `Closed + Void`, …) and any status outside the type's vocabulary (`Expired` on a Buying deal). Applied on create, and on update **only when the set actually changes** — so rows already holding a contradiction stay editable | `reference/transaction.constants.ts`, `transactions/transactions-write.service.ts` |
| Dead `pending_delete` | Retired: the payload block, the six filters, `POST /api/documents/:id/restore`, the service method, the "Deleted Documents — pending review" panel, the API client function and the type field. The column is left in the database. Recycle Bin restore is untouched | `documents/*`, `DocsModal.tsx`, `lib/api.ts`, `types/document.ts` |
| Analytics | `GET /api/dashboard/analytics` computes the same five figures server-side, paging by cursor over only the columns `summarize()` reads. The screen no longer downloads the whole deal book to reduce it in the browser. **Arithmetic preserved to the cent** | `dashboard/desk-analytics.service.ts`, `AnalyticsPage.tsx` |
| Valid-document UX | The lock is now shown wherever the backend enforces it (first upload, Add File on a multi-file document) — and the Replace control tests `validLocked` rather than `validation !== 'Valid'`, so a **Super Admin regains the override the UI was hiding from them** | `DocsModal.tsx` |
| Forensic context | `audit_logs.ip`, `.user_agent`, `.request_id` — captured centrally from the existing `AsyncLocalStorage` request context, so no call site can forget them and background work correctly records NULL. `request_id` is the id returned in `X-Request-Id`, making an audit row joinable to its request's logs | `observability/log.ts`, `audit/audit.service.ts`, migration `20260814140000_audit_request_context` |

### Still open — needs a decision, not code

1. **The default mandatory-document set per transaction type has never existed in this codebase.**
   `DocumentDefaultsService` was born with `mandatory: false` on every row. The flag is now durable
   and administrator-set; turning on defaults is one map from document title to boolean, and needs
   the brokerage's RECO answer. Until then the dashboard tile and the reports honestly count what
   somebody has actually ticked.
2. **Ambiguous legacy deal owners.** Migration `20260814090000` prints any deal whose agent name
   matches more than one account. Those keep the name fallback — a namesake can still reach them —
   and must be assigned by hand. There is no safe automatic answer.
3. **`transaction_reviews.agent_name` is a name snapshot.** Two same-named agents can still see each
   other's *review items*. Closing it needs a user-id column on that table plus a backfill.
4. **Analytics labels its total "incl. HST" while `paid + pending` excludes HST** (the grouped
   totals include it). Reproduced exactly rather than silently corrected — decide which is wanted.
5. **Retention.** Nothing prunes `audit_logs`, the Recycle Bin, `document_reminders` or
   `transaction_reminders`; only `export_jobs` expire. The `audit_logs.domain` column already
   separates `crm` / `desk` / `common`, so a Desk-only policy is expressible today — what is missing
   is the retention period, which is a compliance decision rather than an engineering one.
6. **Two screens still read the unpaged transaction list**: `CommissionAnalytics.tsx` (on the Invoice
   screen) and `EventEditorModal.tsx` (the calendar's deal picker). Both have the same shape of
   problem Analytics just had.
7. **Index gaps** measured against the queries this audit traced: `transactions.deleted_at` (used by
   every query, no index), `comm_status` and `valid_status` (grouped on by the dashboard),
   `documents.deleted_at`, and `audit_logs.created_at` (the trail's sort and date filter). Adding
   them is safe but should follow an `EXPLAIN` against production volumes rather than this list.
8. **Transaction detail over-fetches** the full audit history on every read (`txnShowInclude`), which
   grows without bound per deal. It is now withheld from agents but still loaded for everyone.
   Moving it to its own paged endpoint — as the review history already is — is the fix.

### Not performed

Load, concurrency and volume testing (remediation §10 D–J) was **not** carried out: it needs a load
harness and production-scale data, neither of which exists in this environment. The structural work
those tests would exercise is done — server-side aggregation, cursor paging, bounded selects, and
the export queue running under the requester's own identity — but the measurements themselves remain
outstanding and must not be reported as passed.

### CRM isolation

Six shared files were touched. None changes CRM behaviour:

| File | Why CRM is unaffected |
|---|---|
| `core/authz.ts` | One capability **added**. Nothing existing was altered; `authz.spec.ts` pins the holders of all eleven. |
| `common/transaction-scope.ts` | Reads transaction tables only. No CRM caller. |
| `core/resource-access.service.ts` | Only `assertTransaction` changed; `assertLead` and `assertNoteAuthor` are untouched. |
| `dashboard/area-dashboard.service.ts` | Only the `desk()` method changed. `crm()` and its cache key are untouched. |
| `audit/audit.service.ts` | Three nullable columns added to every write. CRM rows gain the same context; no CRM query, filter, response field or export column changes. |
| `observability/log.ts` + interceptor | Two optional fields added to the request context. |

`crm-desk-isolation.spec.ts`, `crm-dashboard-scope.spec.ts`, `lead-transfer.spec.ts`,
`data-ownership.spec.ts`, `module-access.spec.ts` and the CRM notification and campaign suites all
pass unchanged.

---

## 35. Performance remediation — 2026-08-15

The certification of 2026-08-14 returned **NOT READY AT TESTED SCALE** against a corpus of 80,000
transactions, 800,000 documents and 2,400,000 audit rows. This section records what was changed in
response, what it measured at afterwards, and what is still not good enough. Every figure below was
taken on the same isolated database (`myapp_perf_large`) against the compiled services.

### 35.1 What was wrong, and what replaced it

| Surface | Was | Cause | Now |
|---|---:|---|---:|
| Invoice list | 2,825 ms / **9.0 MB** | every invoice, with `customers` and the entire linked transaction attached to each | **77 ms / 11 KB** |
| Analytics (office) | 3,142 ms | every deal read into Node and summed one at a time | **557 ms** |
| Transactions list | 301 ms / **507 KB** | `meta.ids` carried every matching id on every page load; all 601 user profiles fetched per request | **181 ms / 51 KB** |
| Dashboard commissions | 9,580 ms | full commission breakdown over every deal, per visitor | **6,525 ms** |
| Reports (unfiltered) | ~40,000 ms | every report loaded documents, conditions and clients — 800,000 rows — whether it read them or not | **~13,000 ms** |
| Reports (filtered) | ~40,000 ms | no predicate reached the database | **1,400–3,400 ms** |
| Reports screen (filter options) | full brokerage enrichment | `filterOptions` ran `load()` to fill one `<select>` | **364 ms** |

### 35.2 The commission engine now exists twice, and that is the risk

`dashboard/desk-commission.sql.ts` and migrations `20260815090000` / `20260815100000` /
`20260815110000` are a transliteration of `CommissionService` into SQL. That is the thing this
codebase otherwise avoids: two copies of a financial rule drift, and a drift shows up as a wrong
number rather than a crash.

What makes it acceptable is `core/desk-sql-parity.spec.ts` — 30 tests that run both implementations
over the same deals and require **exact** equality, and `DashboardService.commissionsInNode`, which
is kept precisely so there is something to compare against. It caught two real defects during this
work:

- **A NULL `comm_paid_status` made the SQL `OR` return UNKNOWN**, so those deals satisfied neither
  `WHERE paid` nor `WHERE NOT paid` and vanished from both totals and both counts on Analytics.
- **`php_round2` had to keep PHP's 14-significant-digit pre-correction.** The fast path added in
  `20260815110000` only skips it for values demonstrably away from a half-cent boundary; the exact
  path still runs for the rest.

`reports/report-needs.spec.ts` does the same job for the reports data path and caught a third: the
`team-split-deals` SQL filter required team member rows, but a **preconstruction deal produces one
agent line per term**, so a single-agent precon deal is a "team" deal with no team rows and was
being silently dropped.

### 35.3 Still not good enough

- **Reports take ~13 s** for an unfiltered brokerage-wide run. Decomposed: 8.9 s reading and
  hydrating 79,037 rows with their relations, ~4.4 s enriching them. Totals are computed over the
  complete filtered set, so a page cannot be served without enriching everything that matches — the
  fix is to compute report totals in SQL, which is a redesign of the reports data layer.
- **Dashboard commissions take 6.5 s** for an office user. Single-flight means concurrent visitors
  share one computation rather than each starting their own, but the first one still waits.
- **Throughput saturates at roughly 60 requests per second** on one Node process. More users queue
  rather than fail — no 5xx at any tested level — but latency grows with them.


---

## 36. Second performance pass — 2026-08-15

Three follow-ups from §35: the Dashboard's commission aggregate, the report totals it still could not
answer in SQL, and whether a multi-process deployment lifts the throughput ceiling. Same isolated
corpus (80,000 transactions / 800,000 documents / 2,400,000 audit rows / 22,857 invoices), same
compiled services.

### 36.1 Dashboard commissions — 9,580 ms → 1,891 ms

Three things, in the order they mattered:

| Change | Standard branch | Whole aggregate |
|---|---:|---:|
| One statement (§35) | — | 6,525 ms |
| Split into three variant statements + headline, run together | 21,435 ms | 20,952 ms |
| Fix the correlated subquery on a materialised CTE | 7,779 ms | 7,653 ms |
| Make the report-only columns opt-in | 1,733 ms | **1,891 ms** |

The middle row is the interesting one: splitting the query made it THREE TIMES WORSE before it made
it better, because the same version added a `CROSS JOIN LATERAL (SELECT … FROM scoped …)` to read the
adjustments blob. Against a materialised CTE that is a rescan per member row — 49,000 rows probing a
49,000-row CTE with no index — and it is the second time that exact shape has cost double figures of
seconds in this file. **A correlated subquery against a CTE is not a lookup; it is a nested loop over
the whole CTE.**

The split works because a materialised CTE is evaluated by the PostgreSQL leader process alone: no
parallel workers, however many cores are idle. Three statements on three connections get three plans
on three backends. The variants partition the deals, and every subtotal is an exact two-decimal
`numeric`, so adding them is associative and cannot move a cent.

### 36.2 Report totals in SQL

`ReportsService.runFast` answers the footer with a database aggregate and enriches only the
twenty-five rows on the page. It is used only when the report emits one row per transaction, its
predicate is EXACTLY expressed in SQL (`sqlExact`, not merely the superset `sqlWhere` allows), the
sort is a stored column, and every totalled column is one `reportTotalsSql` can compute. Anything
else takes the original path unchanged.

| Report | §35 | Now |
|---|---:|---:|
| Yearly Deal & Commission Summary | 14,748 ms | **8,693 ms** |
| Brokerage Split Ratio Commission | 13,894 ms | **8,563 ms** |
| Deal List & Price Comparison | 14,363 ms | **8,788 ms** |
| Brokerage Lead Conversion | 1,432 ms | **862 ms** |
| Yearly + closing-year filter | 3,381 ms | **2,132 ms** |
| Yearly, agent-scoped | — | **92 ms** |

Reports that cannot qualify are unchanged and still slow: Sales Statement (13.9 s) and Transaction
Payment Status (14.3 s) filter on a payment status derived from `admin_activities`; the documentation
reports (39–41 s) emit a row per document.

### 36.3 Multi-process deployment — it does not help on this hardware

`WEB_CONCURRENCY` now forks N workers sharing one listening socket, with the schedulers forced onto
worker 1 only. Default 1, so nothing changes unless it is set.

| Topology | rps | p50 | p95 |
|---|---:|---:|---:|
| 1 worker, 300 users | 49.2 | 5,622 ms | 11,943 ms |
| 4 workers, 300 users | 43.1 | 4,929 ms | 16,638 ms |
| 4 workers, pool capped to 16 total | 46.9 | 4,375 ms | 16,228 ms (12 × 5xx) |

**§35 said the ~60 rps ceiling was Node's single thread. That was wrong, and this is the correction.**
Measured during a 300-user run, all Node processes together used 82 CPU-seconds in 45 s — 1.8 of 12
cores. The API tier is not CPU-saturated. PostgreSQL meanwhile ran **41 active backends on average,
peaking at 59**, with the top waits `IO:DataFileRead`, `IPC:BufferIo` and `LWLock:BufferMapping`.

`shared_buffers` is **128 MB against a 773 MB database**, and `random_page_cost` is the spinning-disk
default of 4. More API workers means more concurrent backends contending for a buffer cache that is
already too small, which is why four are worse than one. Confining the load to a 4,000-deal working
set did not help either — the expensive endpoints (Dashboard, Analytics, commissions, audit trail,
invoice list) are brokerage-wide regardless of which deal anybody opens.
