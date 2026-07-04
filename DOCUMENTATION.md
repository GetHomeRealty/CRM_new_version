# Transaction Desk — Project Documentation

Get Home Realty's **Transaction Desk**: a real-estate brokerage back-office system for
managing transactions, commissions, legal documents, invoices and team collaboration.

- **Backend:** Laravel 12 REST API (PHP 8.2+), MySQL, Sanctum cookie auth.
- **Frontend:** React 19 + Vite 7 single-page app (`client/`), React Router 7, Axios.
- **Local stack:** XAMPP (Apache/MySQL) with PHP at `c:\xampp\php\php.exe`.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Directory Structure](#2-directory-structure)
3. [Getting Started](#3-getting-started)
4. [Authentication, Roles & Permissions](#4-authentication-roles--permissions)
5. [Domain Model](#5-domain-model)
6. [Core Features](#6-core-features)
7. [Commission Model](#7-commission-model)
8. [Approval & Review Workflows](#8-approval--review-workflows)
9. [Database Schema](#9-database-schema)
10. [API Reference](#10-api-reference)
11. [Backend Services](#11-backend-services)
12. [Frontend Structure](#12-frontend-structure)
13. [Developer Notes & Conventions](#13-developer-notes--conventions)

---

## 1. Architecture

```
                 ┌────────────────────────┐
  Browser ─────► │  React SPA (client/)    │  Vite dev :5173 / built to public
                 │  React Router + Axios   │
                 └───────────┬────────────┘
                             │ /api/* (cookie auth, Sanctum)
                 ┌───────────▼────────────┐
                 │  Laravel 12 API         │  artisan serve :8000
                 │  Controllers → Services │
                 │  Eloquent Models        │
                 └───────────┬────────────┘
                             │
                     ┌───────▼───────┐
                     │  MySQL (myapp) │
                     └───────────────┘
```

- **Backend-authoritative business logic.** Commission math, invoice totals, trade
  numbers, document validation and permissions are all computed server-side. The SPA
  renders state; it never becomes the source of truth for money or access.
- **Resource layer.** `TransactionResource` (and the invoice/document payloads) shape
  every response, including per-user derived fields such as `my_team_access` and
  `unread_messages`.
- **Auth.** Sanctum SPA cookie sessions. The React app calls `/api/*` with credentials;
  role/permission checks run in middleware and in-controller.

---

## 2. Directory Structure

```
myapp/
├── app/
│   ├── Http/
│   │   ├── Controllers/        REST controllers (Transaction, Document, Invoice, …)
│   │   ├── Requests/           Form-request validation (Store/Update Transaction, …)
│   │   ├── Resources/          API response shaping (TransactionResource)
│   │   └── Middleware/         admin / screen permission middleware
│   ├── Models/                 Eloquent models (Transaction, Document, Invoice, …)
│   └── Services/               Business logic (Commission, Invoice, Permission, Audit)
├── database/migrations/        Schema (chronological)
├── routes/api.php              All API routes
├── client/                     React SPA
│   └── src/
│       ├── desk/               Feature pages + modals (the app UI)
│       ├── context/            AuthContext
│       ├── components/         ProtectedRoute, etc.
│       ├── lib/api.js          Axios API client (all endpoints)
│       └── styles/desk.css     App styling
├── serve-dev.ps1               Dev API server with auto-migrate + restart (see §13)
└── DOCUMENTATION.md            This file
```

---

## 3. Getting Started

### Prerequisites
- PHP 8.2+ (bundled with XAMPP at `c:\xampp\php\php.exe`), Composer
- MySQL (XAMPP) with a database named `myapp`
- Node.js (for the Vite client)

### First-time setup
```bash
composer install
cp .env.example .env            # configure DB (myapp) + APP_URL
php artisan key:generate
php artisan migrate --force
npm --prefix client install
npm --prefix client run build
```

The first registered account becomes the bootstrap **Super Admin** (`POST /api/register`
is only open until the first admin exists).

### Running in development (Windows / PowerShell)

Run the **API** with the auto-reloading watcher and the **client** with Vite:

```powershell
pwsh -File serve-dev.ps1                 # API on http://127.0.0.1:8000 (auto-migrate + restart)
npm --prefix client run dev              # Vite on http://localhost:5173
```

Open **http://localhost:5173**. `serve-dev.ps1` watches `database/migrations` and, when a
migration is added/changed, runs `php artisan migrate --force` and restarts the server —
so newly-created tables are always visible to the running app (see §13).

### Useful commands
```bash
php artisan migrate --force              # apply migrations
php artisan migrate:status               # list migrations
php artisan optimize:clear               # clear config/route/view caches
php -l <file.php>                        # PHP lint
npm --prefix client run build            # build the SPA
```

---

## 4. Authentication, Roles & Permissions

### Roles (stored value → UI label)
| Stored | UI Label | Notes |
|--------|----------|-------|
| `admin` | **Super Admin** | Full access to everything; only role that manages Users. |
| `manager` | **Admin** | Full edit except Users (none); Settings/Audit are view. |
| `agent` | **Agent** | All modules **view**, **Transactions edit**; no Invoice/Audit/Users/Settings. |

In the React app: `const { can, isSuperAdmin, isAdminOrAbove, user } = useAuth();` and
`const isAgent = user?.role === 'agent';`.

### Screen permissions
Access is screen-level with three ranked levels: `none < view < edit`. Screens are listed
in `PermissionService::SCREENS` (dashboard, analytics, calendar, invoice, transactions,
audit, users, settings, …).

- **Effective permission** = role defaults (`PermissionService::roleDefaults`) overlaid
  with per-user overrides stored in `user_permissions`.
- Middleware `screen:<name>,<level>` guards write routes; `admin` middleware guards
  admin-only routes. The sidebar renders only screens the user can `view`.

### Agent portal access to a transaction
Agents only see transactions they **own** (primary agent) or are **split into**.
`TransactionResource.my_team_access` returns:
- `full` — primary agent **or** a founding/promoted team member → same edit rights as the primary.
- `docs` — a later-added team member → can only upload documents; the rest is view-only.
- `null` — not an agent / not on the team.

---

## 5. Domain Model

### Transaction types (`Transaction::TYPES`)
Residential Buying · Residential Lease · Residential Sale Listing · Residential Lease
Listing · Preconstruction · Referral · Commercial Property Buying · Commercial Property
Lease · Commercial Property Sale Listing · Commercial Property Lease Listing · Business
Buying · Business Sale.

Type families that change layout/behaviour:
- **Listing types** (`LISTING_TYPES`) — use the Listing + Co-op financial layout.
- **Secured deal types** — Buying/Lease/Business Buying use the "Secured" lifecycle
  (no Open/Active; the user picks *Secured Firm* / *Secured Conditionally*).
- **Invoiceable types** (`INVOICEABLE_TYPES`) — a co-op commission invoice can be generated.
- **Preconstruction** — commission is per-term (`precon_terms`), invoiced per term.

### Statuses
Stored as `transaction_statuses` rows (a transaction can carry multiple). Examples: Open,
Active, Secured Firm, Secured Conditionally, MPR, Sold, Leased, Mutual Release, DFT,
Void, Closed, Suspended, Terminated, Expired. Some statuses drive behaviour, e.g.:
- **Closed** → fully locked (Super Admin only).
- **DFT** → edits require an approved edit request.
- **Void / Mutual Release** → the checklist is restricted to specific documents.
- **Secured Firm** → the Conditional Offer section is hidden.
- Listing expiry date passing → status auto-becomes **Expired**.

### Key related entities
- **clients**, **conditions** (conditional offers), **inter_board_listings**
- **team_members** (+ `team_member_terms` for precon per-term splits)
- **brokerages** / **brokerage_agents** (co-operating brokerage)
- **documents** (legal checklist), **precon_terms**
- **invoices** / **invoice_line_items** / **invoice_payments**
- **audit_logs**, **transaction_messages** (+ `transaction_message_reads`)
- **transaction_edit_requests**, **transaction_delete_requests**

---

## 6. Core Features

### Transactions
- **List** (`TransactionsPage`) — filter by type/agent/status/etc., per-row Edit/View,
  chat and delete. Agents see only their own/team deals; unassigned deals are admin-only.
- **Detail** (`TransactionDetailPage`) — Basic Info, Conditional Offer, MLS, Team Split,
  Lawyer, Legal & Docs, Financial, Adjustments, Admin Activities, Agent FAQ, Audit Trail.
  Sections show/hide based on type, status and role.
- **Add** (`AddTransactionModal`) — type-aware form with:
  - Property Address **Search / Manual** toggle (OpenStreetMap/Photon type-ahead, Canada-biased).
  - Duplicate guard: same Type + Price + Offer Date + a **fuzzy** property match blocks
    creation (directional tokens N/S/E/W and unit numbers are treated as distinct).
  - **Team** option: pick Agent 1 (primary, defaults to creator) + team members, seeded
    into Team Split as `full` access (split % entered later).

### Team Split
Per-agent commission split (must total 100%). Agent %/Brokerage % come from each agent's
User profile and are only overridden under Financial Information. Each non-primary member
has a **Portal Access** control (Full / Docs only) visible only to the primary agent or an
admin. Precon deals support per-term split scopes.

### Legal & Documentation (`DocsModal`)
Per-transaction document checklist with Status, Validation, upload/replace, per-client and
multi-file uploads, and an invalid-reason attachment. Highlights:
- **Reminder** (admin only) — flag documents for future automated pending-doc reminder emails.
- **Ready for RECO Audit** (admin only) — Yes/No with a reason when No.
- **Manual docs** (added via **+ Add**) show an agent **Accept this document?** control
  (Pending / Accepted / Not Accepted). **Not Accepted** disables uploads for **everyone**
  (agents and admins) and suppresses reminders for that document.
- Agents see uploaded docs as **"Sent"**; admins see them as **"Received"**.
- Agents can add and upload but cannot change Status/Validation or delete (Super-Admin-gated
  for condition docs). Agent-flagged deletions await admin review.

### Agent FAQ Center (`AgentFaqModal`)
Post-deal tracking (docs cleared, final validation, payment readiness, per-agent breakdown).
**Ready to Process Agent Payment** auto-fills: *Final Validation = Done → Yes*; *Docs cleared
= Yes but validation Pending → No*. Editable by admins; agents may only toggle the batch
review-email flag.

### Invoices
Auto-generated commission invoices for invoiceable types on creation (precon is per-term).
Line items, payments, reminders, statuses (Draft/Unpaid/Partially Paid/Paid/Overdue/Void),
due/overdue warnings from the closing date, and a shared **Analytics Dashboard**
(pending vs paid commissions) at the top of the Invoice module.

### Chat
Per-transaction chat thread (`ChatModal`). The Transactions list shows a 💬 button per row
with an **unread-count badge** — messages posted by others since the user last opened the
thread. Opening the thread marks it read (`transaction_message_reads`).

### Audit Trail
Every meaningful change is recorded (`audit_logs`) with section, field, old/new, action,
`source` (Manual/Agent/System), category and a `handled` flag. Agent edits are tagged
`source='Agent'` and surface for admin review (per-transaction banner + top-bar bell),
excluding Team Member and Lawyer changes.

### Users & Permissions (`UsersPage`)
Super-Admin-only. Create/edit users with role, screen-permission overrides and an agent
profile (mobile, gender, onboard date, Fresher/Experienced + Previous Brokerage, commission
split, loans, history). Mandatory fields are enforced before save.

---

## 7. Commission Model

`CommissionService` is the single source of truth. `summarize()` uses `grossCommission()`:

- **Preconstruction** → manual amount, or `precon_comm_pct × price`.
- **Listing** → `price × (listing_comm_pct + coop_comm_pct)/100` plus listing/co-op flats.
- **Standard (deal-side)** → precedence of `comm_amt` (fixed) → `comm_pct` → `comm_value`.

`breakdown()` computes per-agent splits from `team_members` (using each agent's registered
Agent %/Brokerage %). Adjustments (before/after) layer on top. On create, the Add modal's
Commission Input Type maps to `comm_amt` (Fixed) or `comm_pct` (%).

---

## 8. Approval & Review Workflows

### Agent change review
Agents edit their own/full-access transactions freely; changes are tagged `source='Agent'`
and flagged `handled=false`. Admins review via the per-transaction banner / bell. **Mark
reviewed** clears the flags; **rejecting** a change auto-reverts the field (scalars,
Status, brokerage, clients, conditions, inter-board rows).

### Transaction deletion
Agents cannot delete — they raise a **deletion request** (with reason). It appears on the
Transactions home page for admins: pending → forwarded (to Super Admin) → approved (deletes)
or rejected.

### Edit-approval (DFT / Closed)
- **Closed** → only a Super Admin can edit.
- **DFT** → non-Super-Admins must save against an **approved edit request** (consumed on use).

---

## 9. Database Schema

Migrations live in `database/migrations/` (chronological). Core tables:

| Table | Purpose |
|-------|---------|
| `users`, `user_permissions` | Accounts (role + profile JSON) and per-screen overrides |
| `agents`, `brokerages`, `brokerage_agents` | Reference data / co-op brokerage |
| `transactions` | The central record (financial, listing, precon, lawyer, tracking JSON) |
| `transaction_statuses` | One-to-many statuses per transaction |
| `clients`, `conditions`, `inter_board_listings` | Nested transaction collections |
| `team_members` (+ `team_member_terms`) | Commission split; `access` = full/docs; `split`, `agent_pct`, `brok_pct` |
| `precon_terms` | Preconstruction per-term percentages/closing dates |
| `documents` | Legal checklist; `reminder`, `agent_accepted`, `manual`, `pending_delete`, files JSON |
| `invoices`, `invoice_line_items`, `invoice_payments` | Invoice module |
| `audit_logs` | Change history (`section`, `source`, `category`, `handled`) |
| `transaction_messages` (+ `transaction_message_reads`) | Chat + per-user last-read marker |
| `transaction_edit_requests`, `transaction_delete_requests` | Approval workflows |
| `company_settings` | Company profile + feature flags (e.g. `transaction_desk_v2`) |

Notable recent columns: `documents.reminder`, `documents.agent_accepted`,
`documents.manual`, `transactions.reco_audit_ready/remarks`, `team_members.access`.

---

## 10. API Reference

All routes are under `/api` and (except the public auth endpoints) require
`auth:sanctum`. Full definitions: [`routes/api.php`](routes/api.php).

### Public
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/register` | Bootstrap the first admin only |
| POST | `/login` | Login (accepts username **or** email) |
| GET  | `/registration-open` | Whether registration is still open |

### Session / reference (any authenticated user)
`GET /user`, `POST /logout`, `POST /user/password`, `GET /agents`,
`GET /agent-commissions`, `GET /agent-emails`, `GET /transaction-types`,
`GET /suggestions/{lawyers|brokerages}`, `GET /company-settings`.

### Transactions
| Method | Path | Guard |
|--------|------|-------|
| GET | `/transactions` | any auth (agents filtered to own/team) |
| GET | `/transactions/{id}` | access-checked |
| POST | `/transactions` | `screen:transactions,edit` |
| PUT | `/transactions/{id}` | `screen:transactions,edit` (owner/full-member for agents) |
| DELETE | `/transactions/{id}` | `screen:transactions,edit` (admins; agents use delete-requests) |
| GET/POST | `/transactions/{id}/messages` | chat thread / post |

### Documents
`GET /transactions/{id}/documents`, `PUT …/documents` (bulk save), upload/replace single &
multi/per-client files, validation-file upload/delete, delete/restore, and public file
download routes. Uploads are blocked on docs marked **Not Accepted**.

### Workflows
`POST /transactions/{id}/edit-requests` (+ admin approve/reject),
`review-agent-changes` / `reject-agent-change`, `GET /agent-change-notifications`,
`delete-requests` (+ forward/approve/reject).

### Invoices (`screen:invoice,*`)
`GET /invoices`, `GET /invoices/{id}`, `GET /customers`, `POST /invoices`,
`POST /transactions/{id}/invoices` (generate), `PUT/DELETE /invoices/{id}`, payments,
reminders, send; customers CRUD.

### Admin only (`admin` middleware)
`PUT /company-settings`, `GET /users/catalog`, `apiResource('users')` (except show),
`GET /audit-logs` (via `screen:audit,view`).

---

## 11. Backend Services

| Service | Responsibility |
|---------|----------------|
| `CommissionService` | Gross commission + per-agent breakdown (the money source of truth) |
| `PermissionService` | Screen catalog, role defaults, effective permissions, `can()` |
| `AuditService` | Snapshots + change recording (`SCALAR_MAP`, `JSON_MAP`, source/category) |
| `DocumentService` | Type-specific default checklists (`defaultsFor`) |
| `DocsValidationService` | Keeps `documents`/transaction validation status in sync |
| `TransactionInvoiceService` | Auto-generates commission invoices for a transaction |
| `InvoiceCalculator` / `InvoiceStatusService` | Invoice totals, balances, sent/overdue status |
| `TradeNumberService` / `InvoiceNumberService` | Sequential trade / invoice numbers |

---

## 12. Frontend Structure

- **Entry / routing** — `client/src/App.jsx`. Routes live under `/app` inside `DeskLayout`,
  each wrapped in `RequireScreen`. Landing redirects to the first permitted screen.
- **Auth** — `context/AuthContext.jsx` exposes `user`, `can()`, `isSuperAdmin`,
  `isAdminOrAbove`.
- **API client** — `lib/api.js` (Axios, all endpoint helpers).
- **Pages** — `desk/TransactionsPage`, `TransactionDetailPage`, `InvoicePage`, `UsersPage`,
  `CompanySettingsPage`, `AuditLogPage`, plus Dashboard/Analytics/etc.
- **Modals** — `AddTransactionModal`, `TeamSplitModal`, `DocsModal`, `LawyerModal`,
  `FinancialModal`, `AdjustmentModal`, `AdminActivitiesModal`, `AgentFaqModal`,
  `NoticeOfSaleModal`, `TradeSheetModal`, `DepositReceiptModal`, `InvoiceEditorModal`,
  `ChatModal`, `AuditTrailModal`, `ChangePasswordModal`, and more.
- **Styling** — `styles/desk.css` (shared `.list-table`, cards, pills, etc.).

---

## 13. Developer Notes & Conventions

- **Shell:** PowerShell is primary on this machine; a Bash tool exists for POSIX scripts.
  PHP is `c:\xampp\php\php.exe`.
- **Dev server & migrations (important):** a plain `php artisan serve` process started
  *before* a migration will not see the new table (`SQLSTATE[42S02] Base table or view not
  found`) until restarted. Use **`serve-dev.ps1`**, which auto-migrates and restarts on
  migration changes. Do **not** use it in production — run migrations deliberately on deploy.
- **Backend-authoritative:** never trust the client for money or access. Add commission /
  permission / validation logic in Services and Resources, not the SPA.
- **Validation whitelisting:** Form Requests (`Store/UpdateTransactionRequest`) strip
  un-listed fields — when you add a persisted field to a nested payload (e.g. `team.*.access`,
  `documents.*.agent_accepted`), add its validation rule or it will be silently dropped.
- **Migrations are additive** and dated `YYYY_MM_DD_NNNNNN`. Add fillable + casts to the
  model, surface the field in the relevant Resource/payload, and (for nested payloads)
  whitelist it in the Form Request.
- **After changing code:** `php -l` the PHP file, and `npm --prefix client run build` for
  the SPA. Client changes hot-reload under Vite; a hard refresh (Ctrl+Shift+R) picks up a
  fresh build.
- **Roles reminder:** stored `admin` = Super Admin, `manager` = Admin, `agent` = Agent.
```
