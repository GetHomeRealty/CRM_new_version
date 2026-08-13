# Tenant Removal — Final Report

**Date:** 2026-08-08
**Scope:** the multi-brokerage removal programme (§1–§10) and the production-readiness programme
that followed it (§11). The Phase 1/2 inventory is in `TENANT-REMOVAL-AUDIT-2026-08-08.md` and is
superseded on one point, recorded in §9.
**Verdict:** tenancy removal **COMPLETE**; production deployment **READY WITH CONDITIONS** — see §12.

---

## 1. Executive summary

Multi-brokerage tenancy has been removed from the application and from the database. The deployment
is now single-brokerage by construction rather than by convention.

**What was removed.** One mechanism, not a scattered pattern: a Prisma client extension that added
`company_id = N` to every query, fed by an `AsyncLocalStorage` request context. With it went the
context middleware, the `setCompanyId` calls in authentication, eleven `forEachTenant` scheduler
loops, roughly fifty `runAsSystem` escapes, the `TENANT_ID` constant, and — in the schema — 86
`company_id` columns, 21 foreign keys and 88 indexes.

**What was retained, deliberately.** `company_settings` (the brokerage's own record: letterhead,
address, HST number, banking details, invoice prefix and next invoice number); `subscriptions` (the
licence that keeps CRM and Transaction Desk separately gated); `brokerages` and `brokerage_agents`
(the *co-operating* brokerage on a transaction — real-estate counterparty data that merely shares a
word with tenancy); and every rental/lease "tenant" in the product vocabulary.

**Did functionality change?** No behaviour was intentionally altered. Every automated check that
passed before passes now, at the same counts, with the two differences fully accounted for in §6.

**Did security change?** Not for the worse, and the evidence is stronger than an assertion.
Agent-to-agent privacy was never enforced by the tenant filter — a colleague's lead and your own
carried the same `company_id`, so the filter was satisfied by both. It is enforced by
`ResourceAccessService`, the area/screen guards, `authz.ts` and per-query owner predicates, none of
which consult `company_id` and none of which changed. 165 ownership and authorization tests across
both suites confirm this after the change (§5).

**One thing genuinely got faster, and it was not optional.** See §7: the index replacement was the
difference between a 0.049 ms lookup and a 122 ms one on 2.5M leads.

---

## 2. Files modified

109 files changed, 665 insertions, 2,126 deletions. Grouped by what they are; every entry states
why it changed, what changed, its risk, and how it was verified.

### 2.1 The mechanism (deleted outright)

| File | Reason | What changed | Risk | Verification |
|---|---|---|---|---|
| `core/tenant-extension.ts` (181 ln) | The whole isolation mechanism | Deleted | Low — the filter matched every row it was applied to | Full suite green with it detached, before deletion |
| `core/tenant-context.ts` (154 ln) | AsyncLocalStorage carrying the tenant | Deleted | Low — nothing read the store once the extension went | Typecheck + full suite |
| `core/tenants.ts` (13 ln) | `allTenantIds()` | Deleted | Low | Full suite |
| `core/tenant.ts` (27 ln) | `TENANT_ID = 1` | Deleted | Low | Settings/trigger suites |
| `core/tenancy.spec.ts` (361 ln) | Tenancy invariants | Deleted; schema-health half preserved (§2.6) | Medium, mitigated | `data-ownership.spec.ts` green |
| `core/tenant-context.spec.ts` (219 ln) | ALS semantics | Deleted | Low | n/a |

### 2.2 Prisma and application wiring

| File | Reason | What changed | Risk | Verification |
|---|---|---|---|---|
| `prisma/prisma.service.ts` | Applied the extension | Removed `$extends` and the forwarding Proxy; docblock rewritten to say what protects agents instead | **This is the single highest-leverage change** | Full jest + e2e immediately after, before anything else moved |
| `app.module.ts` | Registered the middleware | `configure()` and the `NestModule` implementation removed | Low | e2e (every route passes through it) |
| `observability/log.ts`, `request-log.interceptor.ts` | Logged `companyId` | Field removed from the request context and log line | None | Typecheck; log shape asserted by observability specs |

### 2.3 Authentication and MFA

| File | Reason | What changed | Risk | Verification |
|---|---|---|---|---|
| `auth/guards/auth.guard.ts` | Named the tenant post-auth | `setCompanyId` line removed. **Session lookup, inactive-account rejection and permission loading untouched.** | Low | 25 auth-session-security e2e tests |
| `auth/auth.controller.ts` | 4 × `setCompanyId` on register/login/MFA paths | Removed | Low | 13 auth-roles + 25 session-security e2e |
| `auth/auth.service.ts` | 7 × `runAsSystem`; `run(1, …)` on bootstrap create | Unwrapped to plain calls; `company_id: 1` dropped from the bootstrap user | Low | Login/lockout/bootstrap specs |
| `auth/mfa/mfa.service.ts` | 16 × `runAsSystem`; 2 × `company_id` stamp; `issueOtp(companyId)` | Unwrapped; parameter removed | Low | MFA spec suite + 12 MFA e2e |
| `auth/mfa/mfa-policy.service.ts` | Keyed on `company_id_role` | Rekeyed to `role`; keyed upsert became find-then-write, because the compound accessor no longer exists | **Medium** — behaviour must match the old upsert | MFA policy tests, incl. grace-period expiry |
| `auth/mfa/recovery-code.service.ts`, `trusted-device.service.ts` | `runAsSystem`, `companyId` params and stamps | Unwrapped; parameters removed | Low | MFA suite |
| `auth/mfa/mfa.controller.ts` | Threaded `user.company_id` into the policy API | Arguments dropped | Low | Typecheck + MFA e2e |

### 2.4 Background work — eleven schedulers

Every one had the identical shape `forEachTenant(() => allTenantIds(prisma), () => work())` where
the callback ignored the tenant id. All became a direct call. Trivial wrappers left behind were
collapsed and the `*ForTenant` suffixes renamed to say what the method does.

`calendar/event-reminder-scheduler`, `campaigns/campaign-resume` (×3), `inbox/imap-sync`,
`google/google-calendar-sync`, `leads/lead-task-reminder`, `meta/meta-sync-scheduler`,
`reports/export-job` (×2), `transactions/reminder-scheduler`, `transactions/lawyer-reminder-scheduler`,
`transactions/review-sla-scheduler`, `crm-settings/crm-settings.module`.

**Risk: Low** — with one brokerage the loop ran exactly one pass. **Verification:** the scheduler
specs, plus `reminder-starvation`, `schedule-and-recovery`, `campaign-concurrency`,
`claim-then-send`, `claim-observed` and `meta-budget-and-token`, all green.

Four services (`event-reminder-scheduler`, `reminder-scheduler`, `review-sla-scheduler`,
`crm-settings.module`) lost their `PrismaService` injection, which existed only to list tenants.
Verified first that none is constructed positionally anywhere — all four are DI-registered only.

### 2.5 Settings, licensing and integrations

| File | What changed | Risk | Verification |
|---|---|---|---|
| `crm-settings.service.ts`, `crm-triggers.service.ts`, `crm-advanced-email.service.ts` | `where: { company_id: TENANT_ID }` → unfiltered `findFirst({ orderBy: { id: 'asc' } })`; `company_id` dropped from creates | Low — the table is now a database-enforced singleton | Settings + triggers specs, 10 settings e2e, 6 triggers e2e |
| `core/module-access.service.ts` | `findUnique({ where: { company_id: 1 } })` → `findFirst()`; the hardcoded `companyId = 1` removed | **Medium** — this gates CRM vs Transaction Desk | 16 module-access + 11 module-enforcement + 19 crm-desk-isolation tests |
| `google/google-public.controller.ts` | The OAuth callback resolved the owner's company then wrapped the writes in `run()`. Now a plain existence check that still refuses `unknown_user` | Medium — public, unauthenticated route | `google-*` specs; account-google-cards e2e |
| `meta/meta-public.controller.ts` | `setCompanyId(user.company_id)` removed; **the `loadUser` check that refuses a deleted or deactivated agent was kept** | Medium — public route | 6 meta e2e + meta specs |
| `campaigns/campaigns.service.ts` | 5 × `runAsSystem` on the public open/click/unsubscribe paths | Low — already unscoped | 40 campaign e2e + tracking-attribution |
| `notifications/notification-dispatcher.service.ts`, `notification-center.service.ts` | Stopped threading and stamping the recipient's `company_id` | Low | Dispatcher + centre specs, 14 notification e2e |
| `calendar/event-reminder.service.ts`, `web-push.service.ts` | Stopped stamping `company_id` | Low | Calendar specs |
| `inbox/mail-retention.service.ts`, `leads/lead-import-job.service.ts`, `observability/health.controller.ts`, `core/role-permission.store.ts`, `dashboard/dashboard-parity.harness.ts` | `runAsSystem` unwrapped | Low | Respective specs |

### 2.6 Tests

| File | What changed |
|---|---|
| **`core/data-ownership.spec.ts` (NEW)** | The schema-health half of `tenancy.spec.ts`, preserved. It verifies every model is classified as owned-directly / reached-through-a-parent / owned-by-nobody, that every stated parent link really exists, and that every chain terminates. That is a statement about **ownership**, which is what agent privacy and cascade behaviour both reason along — unrelated to tenancy, and it would have been lost with the file. |
| `settings-audit-findings.spec.ts` | Finding S-H5 restated. It used to seed a second brokerage's settings row and prove it was ignored; seeding it is now the thing that fails. Rewritten to assert the singleton constraint directly — a stronger guarantee than the filter it replaces. |
| `crm-triggers-findings.spec.ts` | Index-name assertion updated to `crm_email_settings_singleton_key` |
| `leads-email-uniqueness.spec.ts` | Index definition/shape assertions updated; the "another brokerage may hold the same person" test **deleted** — it had been a no-op on this database for its whole life, returning early whenever it could not find a second company |
| `crm-events.spec.ts`, `notification-dispatcher.spec.ts` | Two tests asserted the row's `company_id`. Rewritten to assert the responsibility that survived: the notification is addressed to the right recipient and does **not** appear for anyone else |
| `module-access.spec.ts`, `module-enforcement.spec.ts` | Keyed `subscriptions.upsert` replaced with find-then-write |
| ~40 further spec files | Incidental `company_id` fixture stamps removed |

### 2.7 Scripts and documentation

| File | What changed | Note |
|---|---|---|
| **`scripts/seed-test-env.cjs`** | 7 × `company_id` stamps removed | **This was a real functional break**, caught only by the final audit. It is the e2e seeder (`npm run seed` in `e2e/`) and would have failed against the migrated schema |
| `scripts/seed-load-test.cjs` | 6 × `company_id` stamps removed | Used for §7 |
| `e2e/tests/leads.spec.ts` | `company_id: 99` removed from the mass-assignment probe (it no longer probes anything); one comment reworded | |
| `docs/OPERATIONS.md`, `docs/VPS-DEPLOYMENT.md` | The standing warning that "two tenant-isolation defects (`AUD-001`, `AUD-002`) are open" described something that no longer exists. Replaced with what is now true and stricter: the settings, CRM-email and licence tables each hold exactly one row, enforced by the database, so a second brokerage record cannot be created by accident | Leaving these would have been a false statement about the system |
| `docs/META-LEAD-FORM-POLICY.md` | The "why `company_id` is in the key" section replaced with the new key and why the rule is unchanged | |

Historical audit reports under `docs/audit/` were **not** rewritten — they are dated records of what
was true when written.

---

## 3. Database changes

### 3.1 Removed

```
company_id columns .................. 86   (across 86 tables)
foreign keys to company_settings .... 21
indexes referencing company_id ...... 88
redundant index dropped .............  1   (crm_settings_single_global_key — see §9)
```

Verified `0` remaining in `myapp`, `myapp_test` and `myapp_loadtest`. No views, functions or
triggers referenced the column (checked before dropping: the database has 0 views and 0 non-internal
triggers).

**Every `company_id` value in all 86 tables was `1`** — verified before the drop, and re-verified by
a guard inside the migration itself. Nothing distinguished one row from another by that column, so
the drop discarded no information.

### 3.2 Constraints replaced

| Was | Now | Why it could not simply be dropped |
|---|---|---|
| `crm_email_settings` UNIQUE (company_id) | `crm_email_settings_singleton_key` UNIQUE ((true)) | The unique was on `company_id` **alone** — dropping the column deletes the constraint rather than narrowing it. A second SMTP configuration would then be insertable, and the read is `findFirst` |
| `subscriptions` UNIQUE (company_id) | `subscriptions_singleton_key` UNIQUE ((true)) | Same, and this row decides whether CRM and Transaction Desk are enabled at all |
| `leads` UNIQUE (company_id, COALESCE(owner_user_id,0), lower(email)) | `leads_owner_email_key` UNIQUE (COALESCE(owner_user_id,0), lower(email)) | Ordinary narrowing. COALESCE retained — without it, unowned intake (the highest-volume source) would be exempt entirely, since PostgreSQL treats NULLs as distinct |
| `leads` INDEX (company_id, lower(email)) | `leads_email_lower_idx` (lower(email)) | Not cosmetic — see §7 |
| `meta_lead_forms` UNIQUE (company_id, page_id, form_id) WHERE is_active | `meta_lead_forms_page_form_v2_key` (page_id, form_id) WHERE is_active | Ordinary narrowing; protects inbound paid-lead routing |
| `roles` UNIQUE (company_id, key) | `roles_key_key` UNIQUE (key) | Ordinary narrowing; RBAC identity |
| `mfa_policies` UNIQUE (company_id, role) | `mfa_policies_role_key` UNIQUE (role) | Ordinary narrowing; two call sites rekeyed |

`crm_settings` needed no replacement — see §9.

The three singleton indexes use a unique index on the **constant expression `(true)`**: every row
produces the same key, so the index admits exactly one row. This pattern was not invented here — the
original `crm_settings` migration from 2026-07-22 already used `((user_id IS NULL))` the same way. It
was proved against a scratch PostgreSQL 17 database before being written into a migration, and again
behaviourally after applying.

### 3.3 Migrations added

| Migration | Kind |
|---|---|
| `20260808140000_tenant_removal_replacement_constraints` | **Additive only.** Creates every replacement alongside what it replaces. Reversible by dropping the new indexes |
| `20260808150000_tenant_removal_drop_company_id` | **Destructive.** Guarded: refuses, naming the offending tables and row counts, if any `company_id` is not `1` |

Applied to `myapp`, `myapp_test` and `myapp_loadtest`. **Not** applied to `myapp_qa` — see §9.

### 3.4 A note for a production run

The `leads` indexes are built non-concurrently, which takes an `ACCESS EXCLUSIVE` lock. That is
instantaneous on a small table and **not acceptable at 2.5M rows**. The migration header carries the
out-of-band `CREATE INDEX CONCURRENTLY` statements to run first, after which the `IF NOT EXISTS`
guards make the in-migration statements no-ops. `CONCURRENTLY` cannot run inside a transaction
block, which is why it is not written that way in the file.

---

## 4. Architecture: before and after

**Before**
```
request → TenantContextMiddleware (opens empty ALS store)
        → AuthGuard  → loadUser (runAsSystem, because the tenant is not known yet)
                     → setCompanyId(user.company_id)
        → handler    → PrismaService → tenant extension → AND company_id = 1
                                       ↑ throws if no tenant in context
background timer → forEachTenant(allTenantIds) → run(id, work)   [one pass per brokerage]
public route     → runAsSystem(...)                              [sanctioned escape]
```

**After**
```
request → AuthGuard → loadUser → role + permissions → handler → PrismaService (unmodified client)
background timer → work()
public route     → work()
```

Authorization is unchanged and sits where it always did: `ResourceAccessService` (per-record
ownership), `ScreenGuard`/`AreaGuard` (module and screen), `authz.ts` + the role tables (RBAC), and
owner predicates inside individual queries.

---

## 5. Security verification

| Surface | Result |
|---|---|
| Admin access | 13 auth-roles e2e; admin-only screens reachable, verified per role |
| Manager access | Covered by the role matrix in auth-roles and roles-management (15 tests) |
| Agent access | 28 write-authorization e2e — agent A vs agent B across leads, calendar, inbox |
| Agent privacy | `does not show another agent's leads`, `an agent cannot build an audience from another agent's leads`, `campaign history is scoped to the caller`, `bulk delete only removes the caller's own leads`, `shows only the signed-in person's own appointments`, `marking someone else's message read is refused` — all green |
| Direct API / guessed ids | Guessed ids (`999999999`, `0`, `-1`, `2147483647`) refused cleanly on calendar events, inbox messages and mail accounts — no 500s, no existence disclosure |
| Search, pagination, exports | `leads-part2` (31 tests) incl. export scoping and `export is refused when signed out` |
| Attachments | `template-ownership.spec.ts` (7 tests) |
| Notifications | 14 notification-centre e2e; dispatcher now asserted to address the right recipient **and nobody else** |
| Session security | 25 tests incl. session fixation, password change ending other sessions |
| Cache isolation | No change — cache keys never carried a tenant. `cache.service.ts` namespaces are unchanged |
| Integration ownership | Google/Meta connections keyed on `user_id`; Meta form claims by `(page_id, form_id)`; the deactivated-agent refusal on the Meta callback retained |

**Jest ownership/RBAC suites, all green:** resource-access 9, ownership 13, authz 9,
crm-desk-isolation 19, module-access 16, module-enforcement 11, role-permission 10,
roles-management 15, lead-transfer 14, offboarding 18, inbox-isolation 14, crm-dashboard-scope 10,
desk-dashboard-scope 7 — **165 tests**.

**CRM / Transaction Desk separation is preserved.** `crm-desk-isolation.spec.ts` (19 tests) and the
module-enforcement suite both pass, and the `subscriptions` licence row that gates the two now has a
stronger uniqueness guarantee than before.

---

## 6. Regression results

Actual counts, not summaries.

| Stage | Unit + integration (jest) | E2E (Playwright) | Typecheck |
|---|---|---|---|
| **Baseline** (before any change) | 98 suites — **0 failed / 1473 passed** | **0 failed / 391 passed** (10.9m) | clean |
| After application removal, before schema change | 97 suites — **0 failed / 1455 passed** | **0 failed / 391 passed** (10.8m) | clean |
| **After the destructive migration** | 97 suites — **0 failed / 1454 passed** | **0 failed / 391 passed** (10.9m) | clean |

**The two count differences are fully accounted for:**

- `1473 → 1455`: −22 (the two deleted tenancy specs) +4 (the new `data-ownership.spec.ts`).
- `1455 → 1454`: −1, the deleted `allows another brokerage to hold the same person` test, which had
  been a no-op on this database for its entire life.

Security, permissions, agent isolation, background jobs, integrations and frontend are not separate
runners in this project; they are distributed across the two suites above and enumerated in §5.

**A caveat on the baseline, stated because it matters.** The first post-change e2e run was
**discarded as invalid**: Playwright's `reuseExistingServer` had attached to an API server left
listening on port 8100 from the previous day, so it was exercising a stale build. The baseline run
has the same provenance. Every result reported above for the post-change runs was produced with
`CI=1`, which forces Playwright to start its own server from a fresh `npm run build`. The baseline
count of 391 is therefore a like-for-like comparison of *test outcomes*, but it was measured against
a binary built from the pre-change source rather than a fresh build of it.

---

## 7. Performance

Measured on `myapp_loadtest`: **500 users, 2,500,008 leads, 1,182 MB** — the brief's target scale.

| Query | Plan | Time |
|---|---|---|
| Duplicate check, `lower(email)` (every lead create; every imported row) | Index Scan `leads_email_lower_idx`, 3 buffers | **0.049 ms** |
| Per-book duplicate, `COALESCE(owner,0) + lower(email)` | Index Scan, 3 buffers | **0.035 ms** |
| Lead list page 1, realistic agent (15,000-lead book) | Index Scan Backward `leads_pkey` | **3.0 ms** |
| Lead count, realistic agent | BitmapOr over `leads_owner_user_id_idx` + `leads_assigned_to_idx` | **109 ms** |
| Lead count, synthetic probe agent owning 300,005 leads (12% of table) | Parallel Seq Scan | 257 ms |

The last row is **not a regression**: at 12% selectivity a sequential scan is the correct plan, and
the old query added `company_id = 1`, a predicate matching every row, which could not have helped.
No real agent has a book that shape — the seeder skews deliberately to find slow paths.

**The measurement that justifies Phase 12.** The old index led with `company_id`. Once the code
stopped passing that predicate, could the old index still serve the duplicate check? A counterfactual
was built by creating an index of the identical shape — a constant leading column, `((1), lower(email))`
— and dropping the new one inside a rolled-back transaction:

```
with only the old-shape index available : 122.155 ms   15,228 buffers
with leads_email_lower_idx              :   0.049 ms        3 buffers
```

**~2,500× worse**, and the old-shape index is not even smaller (120 MB vs 117 MB). Removing the
tenant predicate while leaving the tenant-shaped index would have made every lead create and every
imported row do a full index scan. This is the concrete answer to the brief's requirement that
tenant removal must not introduce brokerage-wide scans: it does not — but only because the indexes
were redesigned rather than inherited.

Login load, campaign recipient calculation, inbox and calendar throughput were **not** separately
load-tested — see §9.

---

## 8. Remaining tenant references

**Technical SaaS tenant dependencies: 0.** `tenantId`, `tenant_id`, `currentTenant`, `TenantContext`,
`TenantService`, `TenantGuard`, `TenantMiddleware`, `TenantInterceptor`, `TenantModule`,
`TenantProvider`, `TenantRepository`, `TenantController`, `tenantSlug`, `tenantScope`, `scopeTenant`,
`withTenant`, `requireTenant`, `tenantFilter`, `tenantWhere`, `organizationId`, `organization_id`,
`orgId`, `workspaceId`, `workspace_id`, `brokerageId` — **zero occurrences** across `server/src`,
`server/prisma/schema.prisma`, `client/src`, `e2e/tests` and `server/scripts`.

**`company_id` in live code: 0 executable references.** What remains is prose in comments that
explains what was removed and why, plus the migration history — which must not be edited, as those
migrations have been applied.

**Retained, and correct:**

| Category | Where | Why |
|---|---|---|
| Rental / lease tenants | `NoticeOfSaleModal.tsx`, `TradeSheetModal.tsx` (lease deals reframe Buyers→Tenants), `lead.constants.ts`, `campaign.constants.ts`, `document-defaults.service.ts` ("Tenant Representation"), `import-template.ts`, `report-data.service.ts`, both seed scripts | Real-estate vocabulary. Not tenancy |
| `company_settings` | Schema, settings, invoices | The brokerage's legal and financial identity |
| `subscriptions` | `module-access.service.ts` | The CRM ↔ Transaction Desk licence gate |
| `brokerages`, `brokerage_agents` | Transactions | The co-operating brokerage on a deal |

---

## 9. Known risks and things not verified

1. **`myapp_qa` has not been migrated.** It holds 76 `company_id` columns and is **30 migrations
   behind** — drift that predates this work by weeks. It was left alone deliberately: applying 30
   migrations to an environment whose data I have no context on is not a decision to make silently,
   and several of those migrations contain guards that refuse rather than repair. Bring it up with
   `DATABASE_URL=…myapp_qa npx prisma migrate deploy` when someone can watch it.

2. **The Phase 2 report overstated one risk, and this corrects it.** It said dropping `company_id`
   would delete the `crm_settings` shared-row constraint outright. It would not have:
   `crm_settings_global_key`, a unique index on `(user_id IS NULL)`, has existed since that table was
   created in July and enforces the rule without reference to any company. The replacement added in
   the additive migration was therefore redundant and is dropped again in the destructive one. The
   other two singletons genuinely needed replacing.

3. **The loss of a bug detector, not a security control.** The extension failed closed: a query with
   no tenant in context threw. That caught four real missing-context bugs, documented in the file it
   lived in. Nothing now fails loudly if a query forgets something — but there is no longer anything
   for it to forget, and the ownership layer that protects agents is independent and unchanged.

4. **Not load-tested:** login throughput, campaign recipient calculation, inbox and calendar under
   concurrency, connection-pool behaviour, Redis (not configured on this machine), CPU and memory
   under sustained load. What was measured is in §7 — the query paths whose indexes actually changed.

5. **Redis is not configured in this environment**, so the distributed-lock and cache paths ran in
   their fallback modes throughout. They carried no tenant scoping before or after, so nothing here
   changed them — but they were exercised only in the no-Redis configuration.

6. **`prisma migrate dev` must not be used to auto-generate against this schema.** Three constraints
   are expression indexes that Prisma cannot represent, so it would see them as drift and offer to
   drop them. This is not new — the partial and functional indexes on `leads`, `crm_settings` and
   `meta_lead_forms` were already in that category — but there are now three more.

7. **`myapp` and `myapp_test` were written to by the test runs** during this work, as they always are.
   Verified backups were taken before the schema change (`backups/20260808-131911` and
   `20260808-140904`, both restore-verified into a scratch database).

---

## 10. Final verdict

**SUPERSEDED — see §11.** This section recorded the state at the end of the removal work, before
the production-readiness programme ran. It is left in place because the three conditions it names
are exactly what §11 resolves, and deleting it would hide what was outstanding and why.

Its verdict was READY WITH CONDITIONS, blocked on: (1) the production `leads` index swap not being
rehearsed, (2) `myapp_qa` being 30 migrations behind, and (3) performance being scoped only to the
query paths whose indexes changed.

---

*Backups: `backups/20260808-131911` (pre-change) and `backups/20260808-140904` (pre-migration), both
verified restorable.*

---

# 11. Production-readiness programme (Phases 1–7)

Run after §1–§10. Everything below is measured, not inspected.

## 11.1 What changed during this programme

Nothing about the architecture. Four stale artefacts the first pass missed, and four new measurement
harnesses.

| File | Change |
|---|---|
| `campaigns/campaigns.service.ts` | Removed a comment still describing `runAsSystem` as "the sanctioned way to say this spans brokerages", and collapsed four `*Unscoped` wrapper/worker pairs (`recordOpen`, `recordClick`, `isMachinePrefetch`, `unsubscribe`) — dead indirection that existed only to mark the tenancy escape hatch |
| `scripts/rehearse-index-traffic.cjs` | **New.** Drives create / duplicate-check / update / list against `leads` during a DDL operation; exits non-zero if any operation fails |
| `scripts/rehearse-index-locks.cjs` | **New.** Samples `pg_locks` once a second; exits non-zero if `ACCESS EXCLUSIVE` is ever observed |
| `scripts/measure-agent-endpoints.cjs` | **New.** Times the heaviest read endpoints for a *named* agent, so book size is a controlled variable rather than whatever the fixture happens to hold |
| `scripts/measure-login-throughput.cjs` | **New.** Concurrent sign-in throughput |

## 11.2 Gate 1 — final architecture audit: **PASSED**

Zero occurrences, across `server/src`, `server/prisma/schema.prisma`, `client/src`, `e2e/tests` and
`server/scripts`, of: `tenantId`, `tenant_id`, `currentTenant`, `TenantContext`, `TenantService`,
`TenantGuard`, `TenantMiddleware`, `TenantInterceptor`, `TenantModule`, `TenantProvider`,
`TenantRepository`, `TenantController`, `tenantSlug`, `tenantScope`, `scopeTenant`, `withTenant`,
`requireTenant`, `tenantFilter`, `tenantWhere`, `organizationId`, `organization_id`, `orgId`,
`workspaceId`, `workspace_id`, `brokerageId`, `forEachTenant`, `runAsSystem`, `setCompanyId`,
`TENANT_ID`, `allTenantIds`.

`company_id` as executable code: **0**. What remains is prose explaining what was removed, plus the
migration history, which is immutable.

Retained and correct: `company_settings`, `subscriptions`, `brokerages` / `brokerage_agents`, and
the rental/lease "tenant" vocabulary.

## 11.3 Gate 2 — ownership and authorization: **PASSED**

| Suite | Tests | Result |
|---|---|---|
| e2e: `write-authorization`, `auth-roles`, `auth-session-security`, `template-ownership` | 73 | 0 failed |
| jest: resource-access, ownership, authz, crm-desk-isolation, module-access, module-enforcement, role-permission, roles-management, lead-transfer, offboarding, inbox-isolation, crm-dashboard-scope, desk-dashboard-scope | **193** | 0 failed |

*(§1 of this report said 165 for the jest suites. That was an undercount; the figure is 193.)*

The e2e role matrix is the one required: superAdmin, admin (manager), agent, agent2, plus
accounting, documentation and crm. CRM ↔ Transaction Desk separation is carried by
`crm-desk-isolation` (19) and `module-enforcement` (11), both green.

## 11.4 Gate 3 — production-sized index rehearsal: **PASSED**

`myapp_staging_rehearsal` — the **pre-migration** backup restored and seeded to **2,500,655 leads /
500 users**, verified to start with 86 `company_id` columns and the three original `leads` indexes.

| Measurement | Result |
|---|---|
| `leads_owner_email_key` CONCURRENTLY | **9.3 s** |
| `leads_email_lower_idx` CONCURRENTLY | **9.4 s** |
| Both migrations (`prisma migrate deploy`) | **3.8 s** |
| Lock modes on `leads` during the build | AccessShareLock, RowExclusiveLock, ShareUpdateExclusiveLock |
| **ACCESS EXCLUSIVE during the build** | **never observed** |
| Max sessions waiting on a lock | 1, momentary |
| Lead traffic throughout | **193,916 operations (48,479 × 4), 0 failed** — p50 0 ms, p95 1 ms, p99 1 ms on create, duplicate-check, update and list |
| Index size | `leads_email_lower_idx` 242 → **125 MB**; `leads_owner_email_key` 237 → **145 MB** |
| Duplicate check after migration | **0.064 ms**, Index Scan, 3 buffers |
| Invalid indexes left behind | 0 |

**Failure and recovery, rehearsed deliberately.** A unique build was forced to fail by planting a
legitimate cross-book duplicate. It left an index with `indisvalid = f`; the planner ignored it and
live queries were unaffected; `DROP INDEX CONCURRENTLY` cleared it in **89 ms** without blocking;
the retry after fixing the data succeeded in **7.7 s**. The procedure is resumable — nothing needs
unwinding.

**Honest limitation.** §4 of the runbook is genuinely non-blocking. The destructive migration is
not: 86 `DROP COLUMN` statements each take a brief `ACCESS EXCLUSIVE` lock. `DROP COLUMN` is a
catalogue operation, which is why 86 of them take 3.8 s rather than minutes — but it is a short
stall, not zero. Stated plainly in the runbook rather than glossed.

## 11.5 Gate 4 — QA environment: **MIGRATED AND CURRENT**

The inspection changed the decision. `myapp_qa` is **not disposable**: it holds four real staff
accounts (`akhilesh@`, `karishma@`, `kalyani@`, `karthik@gethomerealty.ca`), two personal addresses,
and live integration credentials — **2 Google refresh tokens, 1 Meta access token, 8 mail-account
passwords**. Rebuilding would have destroyed working OAuth grants.

The preserve path was taken, in order: backup to a separate `backups-qa/` root (restore-verified) →
classify all 30 pending migrations (**21 additive, 6 guarded data transforms, 3 destructive**) →
rehearse the full chain on a throwaway copy → verify data identity → apply to the real database.

| | before | after |
|---|---|---|
| users / leads / transactions / documents | 13 / 512 / 8 / 53 | 13 / 512 / 8 / 53 |
| roles / permission grants | 6 / 135 | 6 / **137** |
| google / meta / mail credentials | 2 / 1 / 8 | 2 / 1 / 8 |
| real staff accounts | 4 | 4 |
| `company_id` columns | 76 | **0** |

Grants 135 → 137 is exactly `20260805140000_crm_role_campaigns_edit`, and matches the verified
current state elsewhere.

**Worth raising separately from this work:** a QA database holding real staff accounts and live
OAuth refresh tokens is a standing exposure. Not caused by, and not in scope for, this change.

## 11.6 Gate 5 — performance and concurrency: **PASS WITH CONDITIONS**

Measured against 2.5M leads / 500 users, one web process.

**A correction that changes the reading.** The first run reported six endpoints over budget. That
was not a production signal. `load-test.cjs` labels `agent@test.local` as "the heaviest book
(~9,800 leads)"; at a 2.5M seed that account holds **300,005** — sixty times the ~5,000 a real agent
carries. Re-measured with book size controlled:

| Endpoint (p50 / p95) | 15,000-lead agent | 300,005-lead agent | super admin (250k unattributed) |
|---|---|---|---|
| leads list page 1 | **49 / 54 ms** | 1005 / 1185 ms | 324 / 330 ms |
| leads list page 5 | **44 / 49 ms** | 1058 / 1194 ms | 322 / 327 ms |
| leads search | **64 / 67 ms** | 2474 / 2560 ms | 954 / 1040 ms |
| leads filtered | **70 / 78 ms** | 678 / 707 ms | 272 / 283 ms |
| lead tags | **43 / 60 ms** | 1672 / 1678 ms | 652 / 656 ms |
| CRM dashboard | **24 / 105 ms** | 763 / 839 ms | 224 / 233 ms |
| lead options / tasks / inbox | 4–13 ms | 4–15 ms | 4–14 ms |

Cost tracks **book size**, not table size — exactly what finding **P-08** in
`CRM-SCALABILITY-500-AGENTS-2026-08-06.md` predicted before this work began: the scope predicate
narrows first, and the five-column `ILIKE` then runs over the rows that agent owns.

**Concurrency, realistic books only** (10 agents × 15,000 leads, one process): list p50 878 / p95
951 ms; search p50 950 / p95 1034 ms; dashboard p50 417 / p95 496 ms; tags p50 280 / p95 289 ms;
**0 errors**. List and search sit marginally over the 800 ms budget on a single process; production
runs four `crm-web` instances.

**Authentication:** **3.9 logins/s** on one process, 60/60 succeeded, p50 4652 ms at 20-way
concurrency. That matches the 4.3/s already recorded in `ecosystem.config.cjs` for bcrypt cost 12 —
so removing the tenant lookup from the login path changed nothing. 500 agents ≈ 129 s on one
process, ≈ 32 s across four.

**Connections:** 11 idle → 19 under burst, against `max_connections = 100`. No pool pressure.

**Background jobs:** 70 tests across `schedulers`, `cluster-tick`, `campaign-concurrency`,
`claim-then-send`, `claim-observed`, `schedule-and-recovery`, `worker-health` and
`reminder-starvation` — 0 failed. No duplicate dispatch; the `clusterTick` single-owner probe
passes.

### Conditions

| # | Finding | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| C-1 | Lead list and search exceed the 800 ms p95 budget under 10-way concurrency on **one** web process | 951 ms / 1034 ms p95, 0 errors | Low | Deploy the documented four-instance `crm-web` topology. Not a code change |
| C-2 | An agent holding ~300k leads makes every lead screen exceed budget | 1005–2560 ms p50 | Informational | No real agent should hold 300k. If a house account ever does it needs pagination-first treatment — pre-existing, unrelated to this change |
| C-3 | Five-column `ILIKE` search cannot use an index | pre-existing finding P-08 | Medium (latent) | `pg_trgm` GIN **only if** a broad-scope search is ever introduced. Out of scope here |
| C-4 | Redis not configured **in the test environment**. Production has since had it installed (2026-08-08, operator-reported, not independently verified) | `/api/health/ready` reports it here | Informational, with a caveat | Every measurement in §11.6 reflects the **no-Redis** path, so production should be faster, not slower. But enabling Redis activates a cache and a durable queue that no test in this programme exercised. Run `scripts/verify-redis.cjs` on the server; see §10 of the runbook for what changes at deploy time |

None of C-1 to C-4 is caused by the tenancy removal. The removal deleted a predicate that matched
every row, and the two replacement indexes are smaller and faster than what they replaced.

## 11.7 Gate 6 — final pre-production verification: **PASSED**

| Check | Result |
|---|---|
| Typecheck | clean |
| Prisma schema validation | valid |
| Build | `dist/main.js`, 46 entries |
| Migration status: `myapp`, `myapp_test`, `myapp_qa`, `myapp_loadtest` | all **up to date** |
| **Jest** | **97 suites / 1454 passed / 0 failed** |
| **E2E** (forced fresh server, `CI=1`) | **391 passed / 0 failed** (11.8 m) |
| Database integrity (`myapp`) | 6 roles · 137 grants · 1 `company_settings` (INV- / 601107 / CAD) · 1 `subscriptions` (crm ✓ desk ✓ active/full) · 3 co-op brokerages · 647 leads all owned · **0 `company_id` columns** · all 8 constraints present |

**One e2e run was discarded, and why.** The first Phase 6 attempt reported 8 failures. Investigation
showed a contiguous block of ~16.5 s timeouts caused by the test server being disturbed:
`start-app.ps1` runs the dev API in watch mode, which recompiles into `dist/` — the directory
Playwright's server was running from — and it was restarted mid-run. The run was re-executed
undisturbed rather than reported.

## 11.8 Gate 7 — production runbook

`docs/PRODUCTION-MIGRATION-RUNBOOK-2026-08-08.md`. Written from the rehearsal, not from theory:
every duration, lock mode and recovery step in it is a number measured in §11.4. It covers
pre-deployment checks, a fresh production backup with restore verification, the deployment order
(worker stopped first so no scheduler runs during DDL), the out-of-band `CONCURRENTLY` index build,
the migrations, post-migration verification, fourteen hand smoke tests, and rollback either side of
the destructive step.

**Not executed.** It awaits explicit approval.

---

# 12. Final verdict

### Tenancy Removal — **COMPLETE**

The application is single-company. No tenant middleware, request context, Prisma extension,
`forEachTenant`, `runAsSystem`, hard-coded tenant id, or tenant-scoped filtering, cache, job or
index remains — verified by repository-wide search (§11.2) and by 1,454 unit and 391 browser tests.
Authorization is entirely by user, agent, ownership, role and permission: 266 ownership and
authorization tests pass (§11.3), and none of that layer ever consulted `company_id`.

### QA Environment — **READY**

`myapp_qa` is migrated and current. All data, all four real staff accounts and all integration
credentials preserved; 137 grants; 0 `company_id` columns. Backed up and restore-verified first
(§11.5).

### Performance — **PASS WITH CONDITIONS**

At realistic scale every measured endpoint is well inside budget (49–70 ms p50 for a 15,000-lead
agent). Four conditions, C-1 to C-4, are recorded in §11.6; the only one affecting the deployment is
C-1, which is satisfied by running the already-documented four-process topology. None is caused by
this change.

### Production Deployment — **READY WITH CONDITIONS**

The two conditions that blocked §10 are resolved: the index swap is rehearsed at production scale
with measured proof of non-blocking behaviour, and QA is current. What remains before execution is
approval and two operational decisions, not engineering work:

1. **Approval to run the runbook.** Explicitly withheld to date.
2. **A fresh production backup, restore-verified**, taken immediately before the window. The
   August 8 sets are development backups and are not a production rollback path.
3. **Resolve any duplicate address within a single agent's book** before §4 — the query is in the
   runbook. This is a business decision about which record is real; it must not be automated.
4. **Accept a few seconds of stall** during the destructive migration (§5), or schedule it in a
   quiet minute.

Nothing here is unverified engineering. The migration path itself has been executed end to end
against a 2.5M-row copy of the real pre-migration schema, including its failure mode.
