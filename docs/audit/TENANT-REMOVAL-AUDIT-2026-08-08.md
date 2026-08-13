# Tenant Dependency Inventory & Impact Report

**Date:** 2026-08-08
**Scope:** Phase 1 + Phase 2 of the multi-tenant removal programme. **No application code was modified.**
**Objective:** convert the deployment to a single-brokerage (Get Home Realty) application without changing any behaviour.

---

## 0. Headline findings

Five things decide the shape of this work. They are stated up front because each one overturns an assumption the task brief reasonably makes.

**1. Tenancy here is one mechanism, not a scattered pattern.**
It is a Prisma client extension (`core/tenant-extension.ts`) applied once in `PrismaService`, fed by an `AsyncLocalStorage` context (`core/tenant-context.ts`). No service, controller or DTO passes a tenant id. There is no tenant guard, no tenant interceptor, no tenant decorator, no tenant route parameter, no tenant header, no tenant DTO field, no tenant controller and no tenant API. The 271 backend occurrences are overwhelmingly *escapes from* the mechanism (`runAsSystem`, `forEachTenant`), not uses of it.

**2. The frontend has zero tenancy. Phase 8 is empty.**
Four `tenant` matches in `client/src`, all of them rental-lease vocabulary. No `TenantProvider`, no `useTenant`, no tenant store, selector, header, route, query key or storage entry. There is nothing to remove and nothing to preserve.

**3. `company_settings` is not a tenant table that happens to hold settings — it is a settings table that was drafted into being the tenant root.**
It carries the brokerage's legal and financial identity: name, address, phone, email, logo, HST number, bank beneficiary/name/transit/institution/account, currency, default tax rate, invoice prefix, **next invoice number**, default terms, thank-you note, deposit heading, feature flags. Every invoice, letterhead and trade record depends on it. It must be **retained in full**. Only its role as the parent of 85 foreign keys goes away.

**4. The real risk is not the code. It is seven database constraints that lead with `company_id`.**
Five of them encode live business rules — the per-agent lead-duplicate rule, the one-form-one-agent Meta routing rule, the single shared CRM settings row, the single CRM email settings row, and the single licence row. Dropping `company_id` naively does not weaken these constraints, it **deletes three of them outright**, because a unique index on nothing is not an index. These are the Critical items and they are the reason this cannot be done as a schema-first change.

**5. Tenancy has never been what protects one agent from another.**
Agent privacy is enforced entirely by `ResourceAccessService`, `area.guard.ts`, `authz.ts`, `role-permission.store.ts` and per-query owner predicates — all independent of tenancy, all unaffected by its removal. `resource-access.service.ts` says so explicitly in its own header comment: *"Tenant isolation … says nothing about one agent reading a colleague's, because both rows belong to the same company and the filter is satisfied."* This is the single most reassuring finding in the audit.

---

## 1. Terminology: what is *not* tenancy

Per the brief's warning, every ambiguous term was traced to its actual purpose before classification.

### 1a. Rental / lease tenants — RETAIN, do not touch

| File | Occurrence | Meaning |
|---|---|---|
| `client/src/desk/NoticeOfSaleModal.tsx` | `isLease ? 'Tenants (Client Names)' : 'Buyers'` | Lease deals reframe Buyers→Tenants, Sellers→Landlords |
| `client/src/desk/TradeSheetModal.tsx` | `// Buyer/Tenant` | Trade sheet party label |
| `server/src/leads/lead.constants.ts` | `'tenant'` in lead-type list | Lead is a renter |
| `server/src/campaigns/campaign.constants.ts` | `'Tenant'` in `TAG_OPTIONS` | Campaign audience tag |
| `server/src/documents/document-defaults.service.ts` | `'Tenant Representation'` | A document type |
| `server/src/reports/import-template.ts` | `'One row per buyer/seller/tenant'` | Import help text |
| `server/src/reports/report-data.service.ts` | `buyer/seller/landlord/tenant` | Report column comment |
| `server/scripts/seed-load-test.cjs` | `'tenant'` in `TYPE[]` | Seeded lead type |
| `server/scripts/verify-campaigns.cjs` | `Cy Cold,…,tenant,…` | CSV fixture row |

### 1b. Business entities that merely sound like tenancy — RETAIN

| Entity | What it actually is | Verdict |
|---|---|---|
| `brokerages` (table) | The **co-operating brokerage on a transaction** — the other side of a deal. Keyed `transaction_id @unique`; holds name, address, invoice_email, agent_email, phone. Nothing to do with SaaS tenancy. | RETAIN — NOT TENANCY |
| `brokerage_agents` (table) | The co-op brokerage's agents on that deal. | RETAIN — NOT TENANCY |
| `company_settings` (table) | The deployment's own brokerage record: letterhead, banking, HST, invoice counter. See finding 3. | RETAIN — NOT TENANCY *(its FK role is tenancy)* |
| `subscriptions` (table) | The module **licence**: `crm_enabled`, `transaction_enabled`, `plan`, `expiry_date`, `status`. This is the gate that keeps CRM and Transaction Desk separate — a thing the brief explicitly requires preserved. | RETAIN — NOT TENANCY *(its key is tenancy)* |
| `accountId` in `client/src/lib/accountApi.ts` | A **mail account** id. | RETAIN — NOT TENANCY |

### 1c. Terms from the brief's search list that do not exist here

`organizationId`, `organization_id`, `orgId`, `workspaceId`, `workspace_id`, `tenantId`, `tenant_id`, `currentTenant`, `tenantSlug`, `tenantScope`, `scopeTenant`, `withTenant`, `requireTenant`, `tenantFilter`, `tenantWhere`, `TenantGuard`, `TenantInterceptor`, `TenantRepository`, `TenantController`, `TenantModule`, `TenantProvider` — **zero occurrences repo-wide.**

The tenant column is spelled `company_id` throughout. `withTenant` appears only inside a `tenancy.spec.ts` regex that also matches `forEachTenant`.

---

## 2. Impact table

Risk is stated as *risk if the dependency is removed naively*, i.e. deleted rather than replaced.

### 2.1 Core mechanism

| Area | File/Component | Tenant Dependency | What It Currently Does | Risk If Removed | Replacement Required | Action |
|---|---|---|---|---|---|---|
| Core | `core/tenant-extension.ts` (181 ln) | Whole file | Injects `AND company_id = N` into every `findFirst/findMany/count/aggregate/groupBy/updateMany/deleteMany`; stamps `company_id` on `create/createMany/upsert`; post-fetch ownership check on `findUnique`; pre-flight ownership check on `update/delete`; **throws** when no tenant is in context | **Low functionally, Medium diagnostically.** With one company the filter is `company_id = 1` against rows that are all 1 — a no-op. What is genuinely lost is the fail-closed error, which has caught four real missing-context bugs (documented in-file: Google OAuth callback, Meta connect, campaign open tracking, campaign click tracking). It is a bug detector, not a privacy control. | None for privacy. Ownership/RBAC already carries that responsibility independently. | REMOVE |
| Core | `core/tenant-context.ts` (154 ln) | Whole file: `enter`, `run`, `runAsSystem`, `forEachTenant`, `setCompanyId`, `currentCompanyId`, `requireCompanyId`, `isSystemContext`, `TenantContextMiddleware` | AsyncLocalStorage carrying `companyId` across the request; `system` flag marking sanctioned cross-tenant reads | Low — once the extension is gone nothing reads the store | None | REMOVE |
| Core | `core/tenants.ts` (13 ln) | `allTenantIds()` | `SELECT id FROM company_settings ORDER BY id` — feeds `forEachTenant` | Low | None | REMOVE |
| Core | `core/tenant.ts` (27 ln) | `TENANT_ID = 1` | Named constant replacing a bare `1` in Settings queries | Low, but see 2.4 — the *queries* that use it need a correct replacement predicate | Settings reads become `findFirst({ orderBy: { id: 'asc' } })` | REPLACE |
| Prisma | `prisma/prisma.service.ts` | `$extends(tenantExtension(...))` + Proxy | Applies the extension to the client the whole app injects | Low | Remove the `$extends`; **keep the Proxy removal careful** — the Proxy exists only to expose the extended client, so it goes with it | REMOVE |
| App | `app.module.ts` | `consumer.apply(TenantContextMiddleware).forRoutes('*')` | Opens an empty ALS store per request | Low | None | REMOVE |

**Note on raw SQL:** `$queryRaw`/`$executeRaw` bypass the extension entirely (the Proxy forwards only non-`$` properties and `$transaction`). 9 call sites across 7 files have therefore **never** been tenant-filtered. Their behaviour is unchanged by this work. Listed for completeness: `auth.service.ts`, `campaigns.service.ts`, `crm-settings.service.ts`, `leads/lead-import.engine.ts`, `meta/meta-api-budget.service.ts`, `observability/health.controller.ts`, `users/users.service.ts`.

### 2.2 Authentication & request context (Phase 4)

| Area | File | Dependency | What It Does | Risk If Removed | Action |
|---|---|---|---|---|---|
| Auth | `auth/guards/auth.guard.ts:28` | `setCompanyId(user.company_id)` | Names the tenant for the rest of the request, after the user is loaded | Low. **Everything else the guard does — session lookup, inactive-account rejection, permission loading — is untouched and must stay.** | REMOVE (line only) |
| Auth | `auth/auth.controller.ts` × 5 | `setCompanyId` at bootstrap-register, MFA verify, login, MFA challenge, `devices.trust(...)` | Login is the one authenticated action AuthGuard never sees, so it names the tenant itself | Low | REMOVE (lines only) |
| Auth | `auth/auth.service.ts` × 6 | `runAsSystem` around `loadUser`, `findAuthenticatable` raw query, `upgradeHashIfWeak`, bootstrap counts | Session→user resolution happens *before* any tenant is known; it is the query that discovers the tenant | Low — becomes an ordinary call | REMOVE (wrapper only) |
| Auth | `auth/auth.service.ts:260` | `company_id: 1` on bootstrap user create | Stamps the first account | Low — column has `@default(1)`; safe to drop from the payload before the column goes | REMOVE |
| Auth/MFA | `mfa.service.ts` (12), `mfa-policy.service.ts` (7), `recovery-code.service.ts` (3), `trusted-device.service.ts` (3) | `runAsSystem` on every read; `company_id` on creates; `company_id_role` compound key on policy lookup | MFA tables are consulted **during** the login challenge, before a tenant exists | Low for the wrappers. **`mfa_policies` compound unique is a Phase 12 item** — see 2.6 | REPLACE |
| Auth/MFA | `mfa.controller.ts:210,221` | `user.company_id` passed to `policy.list/set` | Threads the tenant into the policy API | Low — becomes a no-arg call | REMOVE |
| Observability | `observability/log.ts`, `request-log.interceptor.ts` | `companyId` field on the log context, emitted as `company` | Log enrichment only | None | REMOVE |

**Target flow confirmed achievable:** authenticate → load user → load role/permissions → continue. Nothing in the current flow resolves a tenant *before* authentication, so no reordering is needed — only deletion of the `setCompanyId` step that follows it.

### 2.3 Background jobs, schedulers, workers (Phase 6)

Every one follows the identical shape `forEachTenant(() => allTenantIds(prisma), () => doWork())`, where the callback **ignores** the tenant id and relies on the ALS context. Replacement is `await doWork()` in all eleven cases.

| File | Line | Job |
|---|---|---|
| `calendar/event-reminder-scheduler.service.ts` | 72 | Calendar event reminder sweep |
| `campaigns/campaign-resume.service.ts` | 114, 171, 207 | Campaign dispatch, deferred retry, resume |
| `inbox/imap-sync.service.ts` | 155 | IMAP mailbox poll |
| `google/google-calendar-sync.service.ts` | 97 | Retry failed Google Calendar pushes |
| `leads/lead-task-reminder.service.ts` | 74 | Lead task reminders |
| `meta/meta-sync-scheduler.service.ts` | 89 | Meta lead poll |
| `reports/export-job.service.ts` | 91–100, 194–200 | Export queue: orphan recovery, dispatch, `run(owner.company_id, …)` per job |
| `transactions/reminder-scheduler.service.ts` | 69 | Transaction reminder sweep |
| `transactions/lawyer-reminder-scheduler.service.ts` | 64 | Lawyer reminder sweep |
| `transactions/review-sla-scheduler.service.ts` | 61 | Review SLA sweep |
| `crm-settings/crm-settings.module.ts` | 55 | CRM settings bootstrap |

**Risk: Low.** With one tenant the loop runs exactly one pass; removing it is behaviour-identical.

**One caveat worth stating.** `forEachTenant`/`run` `await` inside the ALS scope specifically to force lazy Prisma promises to execute in-scope. Once the extension is gone that guarantee is no longer needed — but the `await` must not be dropped from a call site that currently returns the promise to a caller expecting it settled. Each of the eleven must be converted individually, not with a regex.

**Recipient routing is unaffected.** `export-job.service.ts` resolves the job's owner and `notification-dispatcher.service.ts` resolves the recipient by `user_id`; neither routes by tenant. Meta lead routing is by `meta_lead_forms.user_id` (see 2.6 for its constraint).

### 2.4 Settings & licensing — the hardcoded `1`s

| File | Line | Query | Replacement |
|---|---|---|---|
| `crm-settings/crm-settings.service.ts` | 257, 349, 351 | `crm_email_settings.findFirst({ where: { company_id: TENANT_ID }, orderBy: { id: 'asc' } })`, and a `create` stamping it | `findFirst({ orderBy: { id: 'asc' } })`; drop the stamp |
| `crm-settings/crm-triggers.service.ts` | 42, 79, 155 | Same pattern on `crm_trigger_settings` + `crm_email_settings`; `create` stamps `company_id` | Same |
| `crm-settings/crm-advanced-email.service.ts` | 64 | Same on `crm_email_settings` | Same |
| `core/module-access.service.ts` | 44, 68 | `private readonly companyId = 1` → `subscriptions.findUnique({ where: { company_id: 1 } })` | `findFirst()` — **but the unique key it relies on is a Critical Phase 12 item, see 2.6** |

`TENANT_ID`'s own docblock already records the discrepancy the brief asks me to surface rather than silently fix: *"`crm_email_settings` was read with `findFirst({ orderBy: { id: 'asc' } })` and no tenant filter at all."* The constant was introduced to make the single-tenant assumption explicit. **Removing tenancy makes that constant's stated purpose obsolete rather than violated** — this is the one place where the documentation and the implementation agree that the current state is provisional.

### 2.5 Sanctioned cross-tenant escapes (`runAsSystem`) — all become plain calls

| File | Sites | Why it currently escapes |
|---|---|---|
| `campaigns/campaigns.service.ts` | 5 (1084, 1114, 1132, 1177, 1192) | Open/click tracking pixels are **public** — no session, no tenant |
| `google/google-public.controller.ts` | 2 (78, 84) | OAuth callback is public; resolves owner's company then `run()`s inside it |
| `meta/meta-public.controller.ts` | 1 (94) | Meta connect callback is public |
| `notifications/notification-dispatcher.service.ts` | 3 (220, 285) | Dispatch runs on a timer; stamps recipient's own `company_id` |
| `notifications/notification-center.service.ts` | 2 (171, 331) | Notification reads outside request scope |
| `observability/health.controller.ts` | 6 (63, 85, 86, 187, 210, 231) | Health probes span everything by definition |
| `core/role-permission.store.ts` | 2 (46, 87) | Permission tables loaded at start-up, before any request |
| `inbox/mail-retention.service.ts` | 3 (130, 151) | Retention sweep spans brokerages |
| `leads/lead-import-job.service.ts` | 7 (69, 80, 163, 167, 179, 191) | Import queue runs on a timer |
| `reports/export-job.service.ts` | 4 (93, 100, 194) | Export queue runs on a timer |
| `auth/*` | 12 | See 2.2 |

**Risk: Low.** These are already unscoped today. Unwrapping them changes nothing except removing the wrapper.

### 2.6 Database — the Critical section

Column inventory: **85 models carry `company_id`.** All are `Int @default(1)` except two: `subscriptions.company_id` (`Int @unique`, no default) and `meta_webhook_events.company_id` (`Int?`, nullable). **This matters enormously for sequencing** — because almost every column has a default, application code can stop writing `company_id` at any time without a single write failing, long before the columns are dropped. The code change and the schema change are fully decoupled.

Foreign keys: **19 declared** `company_id → company_settings(id)` (agents, customers, leads, crm_email_settings, crm_referral_codes, crm_email_log, crm_broadcasts, meta_webhook_events, lead_tags, campaigns, marketing_inventory, email_suppressions, export_jobs, import_batches, personal_access_tokens, transactions, users, crm_settings, crm_trigger_settings, lead_import_jobs). The remaining ~66 columns are denormalised with an index but no FK.

Single-column `company_id` indexes: **~85.** All become useless the moment the column has one value; all can be dropped. No replacement needed.

#### The seven constraints that carry business meaning

| # | Constraint | Table | Rule it enforces | What naive removal does | Required replacement | Sev |
|---|---|---|---|---|---|---|
| 1 | `crm_settings_global_per_company_key`<br>`UNIQUE (company_id) WHERE user_id IS NULL` | `crm_settings` | **At most one shared/global CRM settings row.** Personal rows are covered by a separate unique on `user_id`. | **Deletes the constraint entirely.** A unique index on a dropped column cannot be "narrowed" — there is nothing left. Duplicate global rows become possible, and CRM settings would then be governed by whichever row a query happens to pick. | `CREATE UNIQUE INDEX crm_settings_single_global_key ON crm_settings ((TRUE)) WHERE user_id IS NULL;` — a constant-expression index is how Postgres expresses "at most one row matching". Must exist **before** the column drop. | **CRITICAL** |
| 2 | `crm_email_settings_company_id_key`<br>`@@unique([company_id])` | `crm_email_settings` | **Exactly one CRM outbound email configuration.** | Same as #1 — constraint vanishes; a second SMTP config row becomes insertable and the `orderBy: { id: 'asc' }` reads would silently pick the older one. | `CREATE UNIQUE INDEX crm_email_settings_singleton_key ON crm_email_settings ((TRUE));` | **CRITICAL** |
| 3 | `subscriptions_company_id_key`<br>`company_id Int @unique` | `subscriptions` | **One licence row**, and the lookup key `ModuleAccessService` uses. This is the CRM ↔ Transaction Desk separation gate. | Constraint vanishes *and* `findUnique({ where: { company_id } })` stops compiling. A duplicate licence row could silently disable CRM or Desk for everyone. | `CREATE UNIQUE INDEX subscriptions_singleton_key ON subscriptions ((TRUE));` + change the lookup to `findFirst()`. Note `company_id` here has **no default**, so the code change must land before the column becomes optional. | **CRITICAL** |
| 4 | `leads_company_owner_email_key`<br>`UNIQUE (company_id, COALESCE(owner_user_id,0), LOWER(email))` | `leads` | **One address appears at most once in one agent's book.** Deliberately per-owner: two agents may each hold the same person. `COALESCE` exists because NULL owners (unattributed intake — the highest-volume source) would otherwise be exempt entirely. | The three-part key becomes two-part. Semantically **identical** under one company — but it is a drop-and-recreate on a table headed for 2.5M rows, and during the window between the two statements the duplicate rule is unenforced. | `CREATE UNIQUE INDEX CONCURRENTLY leads_owner_email_key ON leads (COALESCE(owner_user_id,0), LOWER(email));` then drop the old. **Create before drop**, never the reverse. | **CRITICAL** |
| 5 | `meta_lead_forms_page_form_key`<br>`UNIQUE (company_id, page_id, form_id) WHERE is_active` | `meta_lead_forms` | **One Meta lead form belongs to one agent.** Fixes a real, observed misrouting bug where two agents claimed a form and `findFirst` gave every delivery to one of them. Partial so a deactivated row releases its claim. | Becomes two-part; semantically identical under one company. Same drop/recreate window risk — and the thing at stake is inbound paid leads going to the wrong agent. | `CREATE UNIQUE INDEX meta_lead_forms_page_form_key_v2 ON meta_lead_forms (page_id, form_id) WHERE is_active;` then drop the old. | **CRITICAL** |
| 6 | `roles_company_id_key_key`<br>`UNIQUE (company_id, key)` | `roles` | **Role keys are unique** (`admin`, `manager`, `agent`, `accounting`, `documentation`, `crm`). RBAC identity. | Becomes `UNIQUE (key)` — identical under one company. | `CREATE UNIQUE INDEX roles_key_key ON roles (key);` then drop the old. | HIGH |
| 7 | `mfa_policies_company_id_role_key`<br>`UNIQUE (company_id, role)` | `mfa_policies` | **One MFA policy per role.** Also the compound key `mfa-policy.service.ts:53,77` upserts and reads through. | Becomes `UNIQUE (role)`; the Prisma compound-key accessor `company_id_role` disappears and both call sites stop compiling. | `CREATE UNIQUE INDEX mfa_policies_role_key ON mfa_policies (role);` + rewrite the two call sites to key on `role`. | HIGH |

Plus one performance index, not a constraint:

| `leads_company_email_lower_idx` `(company_id, LOWER(email))` | `leads` | Answers *"is this address anywhere in the brokerage?"* — used by import and the duplicate check on every lead create. | Under one company, a leading constant column makes this a near-useless index that Postgres will still scan. | `CREATE INDEX CONCURRENTLY leads_email_lower_idx ON leads (LOWER(email));` — this is a genuine **improvement**, not just parity. | HIGH (perf) |

#### Two operational constraints on the migration

- **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction**, and `prisma migrate` wraps each migration file in one. The `leads` indexes (2.5M rows) therefore need either a separate non-transactional migration or an out-of-band `psql` step with the migration recording it as applied. Doing it transactionally will hold an `ACCESS EXCLUSIVE` lock on `leads` for the duration of the build — minutes, with the whole CRM stalled.
- **Applied migrations must not be edited.** `20260730160000_tenant_company_id` and `20260731090000_tenant_on_every_table` are history. All changes go in new migrations.

### 2.7 Tests

| File | Dependency | Action |
|---|---|---|
| `core/tenancy.spec.ts` (361 ln) | The entire tenancy invariant suite: structural classification of every model into root/derived/global, "every root has `company_id`", four behavioural two-tenant isolation tests, and a source-scan asserting the 4 named timers call `forEachTenant` | DELETE. **But note a real loss:** the structural half also verifies that every derived table has a valid link to a real parent and that every chain terminates at a root. That is a schema-health invariant independent of tenancy, and deleting the file discards it. Flagged for your decision — see §5. |
| `core/tenant-context.spec.ts` (219 ln) — *currently modified in the working tree* | ALS semantics, lazy-promise trap, `runAsSystem` accounting | DELETE |
| 53 other spec files | Incidental `company_id` in fixtures/factories, or `runAsSystem` in setup | UPDATE in place — mechanical |
| `e2e/tests/leads.spec.ts:306` | Comment only: *"not created pre-deleted or in another tenant"* | UPDATE comment |
| `server/scripts/seed-load-test.cjs` | `company_id: 1` × 6 on seeded users/leads/tags | UPDATE (drop the field) |

Files whose specs must be **preserved and used as the regression baseline** — these are the agent-privacy tests and they are the actual safety net for this work:
`core/resource-access.spec.ts`, `core/ownership.spec.ts`, `core/authz.spec.ts`, `core/crm-desk-isolation.spec.ts` (468 ln), `core/module-access.spec.ts`, `core/module-enforcement.spec.ts`, `core/role-permission.spec.ts`, `core/roles-management.spec.ts`, `core/lead-transfer.spec.ts`, `users/offboarding.spec.ts`.

### 2.8 Layers audited and found clean

| Layer | Result |
|---|---|
| Redis / cache | `cache.service.ts` namespaces carry **no** tenant prefix. Nothing to rewrite. Phase 7 is a no-op for cache. |
| Distributed locks | `cluster-tick.ts` uses `sweep:${name}` — sweep-scoped, not tenant-scoped. Unchanged. |
| Queues | `queue/` payloads carry no tenant. BullMQ job names unchanged. |
| Rate limits / idempotency | `identity-throttler.guard.ts` keys on identity, not tenant. |
| OAuth state | Google/Meta state is signed and carries the **user** id, not a tenant. |
| Webhooks | Meta webhook routing is by `page_id`/`form_id` → `meta_lead_forms.user_id`. Not tenant-routed. |
| WebSockets / push | `push_subscriptions` keyed on `user_id` + `endpoint`. |
| Storage / attachments | No tenant in any path. `campaign-template-attachment` access is owner-checked. |
| DTOs / Swagger / controllers | No tenant field, parameter or header anywhere. |
| Frontend (all of it) | Zero tenancy. See finding 2. |

---

## 3. Totals

Counted as raw occurrences of `tenant|company_id|companyId` (case-insensitive), excluding `node_modules`, `dist`, `.git`, `backups`, `test-results`.

```
Backend tenant dependencies:          271 occurrences across  52 files
  of which technical SaaS tenancy:    266 occurrences across  47 files
  of which rental/business (RETAIN):    5 occurrences across   5 files

Frontend tenant dependencies:           4 occurrences across   2 files
  of which technical SaaS tenancy:      0
  of which rental/lease (RETAIN):       4

Database tenant dependencies:         262 schema lines + 286 migration lines
  models carrying company_id:          85
  declared foreign keys:               19
  single-column indexes:              ~85
  business-bearing constraints:         7   ← the Critical set
  performance indexes to rebuild:       1

Integration tenant dependencies:       11  (Google 2, Meta 1, campaigns tracking 5, notifications 3)
                                           all are runAsSystem escapes, none is tenant routing

Infrastructure tenant dependencies:    11  (forEachTenant schedulers)
                                           cache 0, locks 0, queues 0, webhooks 0

Test tenant dependencies:             318 occurrences across  55 files
  dedicated tenancy suites to delete:   2 files (580 lines)

Scripts:                               15 occurrences across   2 files (13 technical, 2 rental)
E2E:                                    2 occurrences across   1 file  (comment only)

TOTAL:                              ~1,158 occurrences
TOTAL, technical SaaS tenancy only: ~1,147
```

---

## 4. Risk register

| Sev | Item | Why |
|---|---|---|
| **CRITICAL** | `crm_settings` single-global-row index (#1) | Dropping the column deletes the constraint outright, not narrows it |
| **CRITICAL** | `crm_email_settings` singleton (#2) | Same |
| **CRITICAL** | `subscriptions` singleton + lookup key (#3) | Same, **and** it gates CRM vs Transaction Desk |
| **CRITICAL** | `leads` per-owner email unique (#4) | Live business rule; 2.5M-row index rebuild; unenforced window during swap |
| **CRITICAL** | `meta_lead_forms` one-form-one-agent (#5) | Live business rule protecting inbound paid-lead routing |
| **HIGH** | `roles (company_id, key)` unique (#6) | RBAC identity |
| **HIGH** | `mfa_policies (company_id, role)` unique (#7) | MFA enforcement; 2 call sites break at compile time |
| **HIGH** | `leads_company_email_lower_idx` | Import + duplicate check on every create, at 2.5M rows |
| **HIGH** | `CREATE INDEX CONCURRENTLY` vs Prisma's transaction wrapper | Non-concurrent build locks `leads` for minutes |
| **HIGH** | Loss of the fail-closed detector | Not a privacy control, but it has caught four real bugs. After removal, a latent unscoped query surfaces as wrong data rather than an exception. Mitigated by the ownership suite. |
| MEDIUM | `tenancy.spec.ts` structural invariants discarded with the file | Schema-health check unrelated to tenancy — needs a keep/drop decision |
| MEDIUM | 11 `forEachTenant` unwraps | Must be done individually; the `await` is load-bearing at some sites |
| MEDIUM | 53 spec files with incidental `company_id` | Volume, not difficulty |
| LOW | Everything else | |

**Not a risk, stated explicitly because the brief asks:** removing tenancy cannot make one agent's records visible to another. Agent isolation is enforced by `ResourceAccessService.assertLead` / `assertTransaction`, `area.guard.ts`, `authz.ts` and per-query owner predicates. None of them consults `company_id`, and none of them changes.

---

## 5. Proposed safe removal order

The ordering principle: **the code and the schema are decoupled by the `@default(1)` on 83 of 85 columns.** That lets every application change land, be tested, and be reverted independently of any destructive migration.

| Stage | Work | Reversible? | Gate to proceed |
|---|---|---|---|
| **0** | Record the regression baseline (Phase 3). Full `jest` run, counts recorded. | n/a | — |
| **1** | **Detach the extension** — remove `$extends(tenantExtension(...))` from `PrismaService`. One line. All 271 sites still compile; no query is tenant-filtered any more. | Yes, trivially | Full suite green, **agent-isolation suite green** — this is the moment that proves ownership/RBAC alone is sufficient |
| **2** | Unwrap `runAsSystem` / `run` / `forEachTenant` at all ~50 call sites → plain calls. Mechanical, file by file. | Yes | Full suite green |
| **3** | Remove `setCompanyId` from the guard, auth controller, Meta controller; remove `TenantContextMiddleware` from `AppModule`; drop `companyId` from the log context. | Yes | Auth + MFA suites green |
| **4** | Replace `TENANT_ID` and `ModuleAccessService.companyId = 1` with `findFirst()`-shaped reads. Stop writing `company_id` in all `create`/`upsert` payloads. | Yes | Settings, triggers, module-access suites green |
| **5** | Delete `core/tenant.ts`, `tenants.ts`, `tenant-context.ts`, `tenant-extension.ts`, `tenancy.spec.ts`, `tenant-context.spec.ts`. Update the 53 incidental specs. | Yes | **Full suite green — Phase 9 gate.** No Critical/High regressions permitted past here |
| **6** | **Backup + verify** (Phase 11). `npm run backup` then `npm run backup:verify`. | — | Backup restores cleanly |
| **7** | **Additive migration only:** create all seven replacement constraints and the new `leads` index. Nothing dropped. Both old and new constraints coexist. | Yes — additive | Constraints created; suite green |
| **8** | **Destructive migration:** drop the 19 FKs, ~85 single-column indexes, the 7 superseded constraints, then the 85 columns. `subscriptions.company_id` and `meta_webhook_events.company_id` handled individually. | **No** | Stage 7 verified first |
| **9** | Agent-to-agent security testing (Phase 16), performance at 500 agents / 2.5M leads using `seed-load-test.cjs` (Phase 17), final repo audit (Phase 18), final report (Phase 19). | — | — |

Stages 1–5 deliver essentially all of the brief's stated goal — no tenant context, no tenant scoping, no tenant jobs, no tenant switching — while remaining fully reversible. Stage 8 is the only irreversible step, and it is worth being clear that it buys tidiness rather than function: 85 columns of constant `1` cost storage and clutter, not correctness.

---

## 6. Open questions for you

1. **Test execution touches the dev database.** `jest` runs against the development DB, and `tenancy.spec.ts` seeds a second `company_settings` row inside a rolled-back transaction. I have not run anything yet. Confirm before I establish the Stage 0 baseline.
2. **Stage 8 (column drops) — do it now or defer?** Everything the brief asks for functionally is achieved by Stage 5. Dropping the columns is the only irreversible act and the only one requiring a maintenance window on `leads`.
3. **`tenancy.spec.ts` structural invariants** — the parent/child/root classification check is genuinely useful and unrelated to tenancy. Keep it as a standalone schema-health test, or let it go with the file?
4. **`subscriptions`** — confirm it stays. It is tenancy-shaped (one licence row per company) but it is what keeps CRM and Transaction Desk separately gated, which the brief requires preserved. My recommendation: retain as a deployment-level licence singleton.

---

*End of Phase 1 / Phase 2. No application code, schema or database was modified in producing this report.*
