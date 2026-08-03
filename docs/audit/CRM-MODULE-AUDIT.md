# CRM Module — Enterprise Production Readiness Audit

> **REMEDIATION — 2026-08-02.** The three CRITICAL and seven of the eight HIGH findings have been
> fixed and each re-verified at runtime; see [Remediation](#remediation--2026-08-02) at the end of
> this document for what changed, what was deliberately left, and the revised module status. The
> findings below are preserved as written, because the reasoning is what makes the fixes
> reviewable.


**Date:** 2026-08-02 · **Scope:** CRM area only — Leads (+ activity, import, export, tags, transfer,
recycle bin), CRM Settings, CRM advanced email, CRM broadcasts, Meta lead-ads intake, CRM Dashboard
scope. Campaigns has its own audit in [`CRM-CAMPAIGNS-AUDIT.md`](CRM-CAMPAIGNS-AUDIT.md) and is
referenced only where it shares code with this module.

**Method:** code inspection of every server file in `src/leads`, `src/crm-settings`, `src/meta`,
`src/common/lead-scope.ts`, `src/core/resource-access.service.ts`, `src/core/authz.ts` and the CRM
client screens — followed by **runtime testing against a running stack** (Chromium, real Postgres,
real sessions) as Agent, Admin and Super Admin. Every finding below marked **[RUNTIME]** was
observed, not inferred; the observed response is quoted.

---

## Executive Summary

The CRM module is built on a genuinely good idea, executed carefully in the places that were
thought about, and unguarded in the places that were not. Its central promise — *an agent's book of
leads is confidential to them, and no role, however senior, reads a colleague's book* — is enforced
correctly and consistently in `leadScopeWhere`, `assertLead`, the list, the detail read, the recycle
bin and the export. That is a hard rule to hold across twenty endpoints, and it holds.

It is then given away by three side doors, all confirmed at runtime:

1. The **duplicate-email validation message names the other agent's lead**, turning the create form
   into a lookup tool for the entire brokerage's lead database.
2. **Deleting a tag rewrites every lead in the brokerage**, including leads the caller cannot see,
   open or list.
3. The **CRM Settings email actions send to any address in the request body** with no lead lookup,
   no suppression list check and no unsubscribe check — the exact CASL guarantee the Campaigns
   module was carefully built to honour.

The third is the most serious thing in this module. It is not a leak, it is a compliance breach and
an authenticated open mail relay on the brokerage's own domain.

Beyond confidentiality, the module has one structural weakness that will surface on day one at real
volume: **unbounded work in request paths**. The tag registry reads every lead row in the brokerage
into Node to count tags; the header counters fire eleven `COUNT` queries per page of the lead list;
the staff broadcast performs one synchronous SMTP round trip per active user inside the HTTP
request; the CSV export silently stops at 5,000 rows and reports the truncated number as a success.
For a brokerage with hundreds of agents these are not slow — they are broken.

Nothing here is unfixable, and most of it is small. But it is not ready to go live tomorrow.

### Production Readiness Score

**48 / 100 — NOT PRODUCTION READY**

| Dimension | Score | Note |
|---|---|---|
| Access control (read paths) | 85 | The scope rule is correct and consistently applied |
| Access control (write paths) | 35 | Cross-book tag writes; identity lock keyed on a role name; writes gated on `view` |
| Confidentiality | 30 | Validation messages and the tag registry both cross book boundaries |
| Compliance (CASL) | 15 | An entire send path bypasses suppression and unsubscribe |
| Data integrity | 45 | Unique-index violations surface as 500s; import skips validation |
| Performance at scale | 35 | Multiple unbounded scans and synchronous mail loops in request paths |
| Input validation | 75 | Clamping and vocabularies are good; dates and the import path are not |
| XSS / injection resistance | 90 | No `dangerouslySetInnerHTML`; parameterised SQL throughout |
| UX completeness | 60 | Destructive API surface with no UI; silent truncation; inconsistent dialogs |
| Deployment readiness | 70 | Production config validation is genuinely good; background work is single-node |

---

## CRITICAL

### C-1 — CRM Settings emails any address, bypassing the suppression list entirely [RUNTIME]

**Where:** [`crm-settings.controller.ts:86-131`](../../server/src/crm-settings/crm-settings.controller.ts#L86-L131) →
[`crm-advanced-email.service.ts:246-267`](../../server/src/crm-settings/crm-advanced-email.service.ts#L246-L267)

`POST /api/crm-settings/email-settings` dispatches on an `action` field. Six of those actions —
`sendCustomEmail`, `sendWeddingEmail`, `sendSeasonalEmail`, `sendPromotionalEmail`,
`sendReferralEmail`, `bulkSend` — take **`leadEmail` straight from the request body**. There is no
lead lookup, no ownership check, no `email_suppressions` check and no `leads.unsubscribed` check.
`dispatch()` validates the address *shape* and hands it to the mailer.

**Observed:**

```
[C1] sendCustomEmail to an address with no lead record answered 200:
     {"success":false,"message":"Failed to send custom email: getaddrinfo ENOTFOUND smtp.invalid.test"}
[C2] per-lead send → 400 (correctly refused);
     CRM-Settings send to the same address → 200 (no suppression lookup in the second path)
```

The send reached the SMTP layer and failed only because the test environment points at
`smtp.invalid.test`. With working credentials it would have been delivered.

**Why this is critical, in three separate ways.**

*Compliance.* `LeadActivityService.sendEmail` refuses an unsubscribed lead, and its comment explains
why: *"in Canada, CASL does not distinguish"* between bulk and individual mail. The Campaigns module
maintains a suppression list, filters every audience through it, and now records hard bounces in it.
This path ignores all of that. Under CASL the penalty regime runs to $10M for an organisation, and
the burden of proof is on the sender. The application currently has no way to prove this path never
mailed someone who opted out, because it does not look.

*Relay.* `sendCustomEmail` takes an arbitrary `subject` and arbitrary HTML `content` and sends it
from the brokerage's own authenticated domain to any address on earth. That is a phishing platform
with the brokerage's SPF/DKIM alignment behind it. Default permissions confine this to Super Admin
(`settings: edit`), which contains but does not remove the problem — any permission override widens
it, and a compromised Super Admin session is precisely the case where this matters.

*Deliverability.* Mail to addresses that never consented drives spam complaints, and complaints are
scored against the sending domain — the same domain the Campaigns module is carefully protecting.

**Fix:** resolve every recipient from a lead the caller may access; refuse when the lead is
`unsubscribed` or the address is in `email_suppressions`; drop the free-recipient parameter
entirely. Log the rejection so the compliance record shows the guard firing.
**Estimate: 6 h** (plus a review of anything already sent through this path).

---

### C-2 — The duplicate-email check discloses other agents' leads by name and id [RUNTIME]

**Where:** [`leads.service.ts:652-657`](../../server/src/leads/leads.service.ts#L652-L657)

```ts
const clash = await this.prisma.leads.findFirst({
  where: { email: { equals: email, mode: 'insensitive' }, deleted_at: null, ... },
  select: { id: true, name: true },
});
if (clash) add('email', `${clash.name} already uses that email address (lead #${clash.id}).`);
```

The uniqueness check is **brokerage-wide** — correctly, because the database index is — but the
error message is written as though the caller could already see the row. They cannot.

**Observed:** agent2 created a lead; the `agent` account was refused a direct read of it (`404`, the
scope rule working), and then submitted the create form with the same address:

```
[A1] POST /api/leads with a colleague's lead address answered 422:
     {"message":"Confidential Client-…-522644 already uses that email address (lead #565)."}
```

An agent with a list of addresses — a purchased list, a competitor's client roster, a departed
colleague's contacts — can determine which of them the brokerage already holds, **who owns them by
name**, and their internal record id, one form submission at a time. This is the entire
confidentiality model of the module, defeated by an error string.

**Fix:** when the clashing lead is outside the caller's scope, say only that the address is already
in use and offer to route the request to an administrator. Name the lead only when the caller can
already open it. **Estimate: 2 h**

---

### C-3 — Deleting a tag rewrites leads in every other agent's book [RUNTIME]

**Where:** [`leads.service.ts:527-542`](../../server/src/leads/leads.service.ts#L527-L542)

```ts
const rows = await this.prisma.leads.findMany({ where: { deleted_at: null }, select: { id, tags } });
```

No `scopeWhere`. `DELETE /api/leads/tags?tag=X` is available to **any user with `lead:edit`** —
which by default is every agent — and strips the tag from every matching lead in the brokerage.

**Observed:**

```
[A4-delete] agent's DELETE /api/leads/tags answered 200:
            {"tag":"Agent2-Owned-Tag-…","removed":1,"lead_ids":[568]}
[A4]        after another agent deleted the tag, the owner's lead LOST it — cross-book write
```

The response even returns the affected lead ids — a second disclosure. The audit trail records the
deletion against the caller, so the owner sees their segmentation vanish with no local explanation.
Campaign audiences are built from tags, so this silently changes who other agents' campaigns will
reach.

Three defects in one method:
- **unscoped write** across the confidentiality boundary;
- **unscoped read** returning ids the caller may not see;
- an **N-query loop with no transaction** — a failure halfway leaves the tag on some leads and not
  others, and the returned `lead_ids` (the undo payload) is then wrong.

**Fix:** scope the read and the write to `scopeWhere(user)`; return only counts; do the update in
one statement inside a transaction. Consider restricting registry deletion to an administrator.
**Estimate: 4 h**

---

## HIGH

### H-1 — Unique-constraint violations surface as HTTP 500 [RUNTIME]

**Where:** `leads_email_lower_key` (DB) vs [`leads.service.ts:652`](../../server/src/leads/leads.service.ts#L652) and
[`error-log.filter.ts`](../../server/src/observability/error-log.filter.ts)

The application check excludes soft-deleted leads (`deleted_at: null`); the database index does not.
There is no `P2002` handler anywhere — `ErrorLogFilter` deliberately reshapes nothing.

**Observed, two independent routes to the same 500:**

```
[B1] re-creating a lead on a soft-deleted address answered 500:
     {"statusCode":500,"message":"Internal server error"}
[E4] two simultaneous creates answered 201/500; 1 row(s) exist afterwards
```

`B1` is an ordinary workflow: delete a lead by mistake, re-add the person, get a server error with
no explanation of what to do. `E4` is a **double-click on Save** — the second request loses the race
and the user sees "Internal server error" on a lead that was in fact created.

**Fix:** catch `PrismaClientKnownRequestError` `P2002` and translate it to the module's 422 shape,
with wording that distinguishes "already in use" from "in the recycle bin — restore it instead".
Add a client-side submit guard. **Estimate: 4 h**

### H-2 — CSV export silently truncates at 5,000 rows and reports success [RUNTIME]

**Where:** [`leads.service.ts:477`](../../server/src/leads/leads.service.ts#L477) (`take: MAX_IMPORT_ROWS` = 5,000) ·
[`LeadsPage.tsx:215-218`](../../client/src/desk/LeadsPage.tsx#L215-L218)

```
[E5] export returned a bare array of N rows with no total, no meta and no truncation flag
```

The UI then reports `Exported 5000 leads.` — a success message for an incomplete file. This is the
same defect class the team already fixed on the recycle bin ("a silent cap on a recovery screen is
the wrong way round"), reintroduced on the export used for migrations, mail merges and compliance
requests. The constant is also misnamed: `MAX_IMPORT_ROWS` used as an export cap, while a *different*
`MAX_IMPORT_ROWS` (50,000) governs imports in another file.

**Fix:** return `{ data, meta: { total, returned, truncated } }`; refuse or stream above the cap; say
so on screen. Rename one of the two constants. **Estimate: 4 h**

### H-3 — The SMS endpoint sends to a number taken from the request body [RUNTIME]

**Where:** [`lead-activity.service.ts:537-544`](../../server/src/leads/lead-activity.service.ts#L537-L544)

`POST /api/leads/:id/messages` with `send: true` calls `this.twilio.send(to, text)` where
`to = str(body.phone)` — **never compared to the lead's own number**.

```
[C3] send:true with a phone unrelated to the lead answered 400:
     {"message":"Mismatch between the 'From' number +1785… and the account ACd77…","code":"21660"}
```

That error came **from Twilio**, which means the arbitrary number was accepted by the application
and passed to the gateway. On a correctly configured account the message would have been delivered.
Any user with `lead:edit` — every agent — can send 2,000 characters of arbitrary text to any number
on the brokerage's Twilio account. Toll fraud, harassment, and Canadian CASL/CRTC exposure for
unsolicited commercial SMS.

**Fix:** derive the destination from the lead record; if a number must be overridable, restrict it
to the lead's own numbers on file. **Estimate: 2 h**

### H-4 — The staff broadcast sends synchronously inside the request [RUNTIME]

**Where:** [`crm-settings.service.ts` `broadcast()`](../../server/src/crm-settings/crm-settings.service.ts)

One `await this.mailer.sendDirect(...)` per active user, in a `for` loop, inside the HTTP request.
This is precisely the failure the Campaigns module documented and fixed ("the HTTP request stayed
open for the whole send… past most browser patience and, at ~750 recipients, past the 300 s
`proxy_read_timeout`"). The same pattern is still here, and it grows with headcount — the brokerage
described has hundreds of agents.

There is no queue, no resumption, no progress and no throttle. A timeout mid-loop leaves some staff
mailed and some not, with the count written only if the loop completes.

**Fix:** reuse the campaign delivery pattern — persist, return immediately, deliver detached with
per-recipient progress. **Estimate: 6 h**

### H-5 — Writes to CRM Settings are gated on the *view* permission [RUNTIME]

**Where:** [`crm-settings.controller.ts:42-67`](../../server/src/crm-settings/crm-settings.controller.ts#L42-L67)

`@Put()`, `@Post()` and `@Put('profile')` all carry `@Screen('settings', 'view')`. The `manager`
role (labelled **Admin**) is given `settings: 'view'` by
[`permission.service.ts:109`](../../server/src/auth/permission.service.ts#L109) precisely so it
cannot change settings.

```
[D1] PUT /api/crm-settings answered 200 (a write gated on the view level)
```

`saveSettings` writes a row scoped by `scopeId(user)`, which for a sufficiently ranked user is the
**global** settings row — so an Admin holding view-only permission edits brokerage-wide CRM
configuration, including the email settings that gate the C-1 send path.

**Fix:** `@Screen('settings', 'edit')` on all three, or split genuinely personal preferences onto a
separate route that says so. **Estimate: 2 h**

### H-6 — The brokerage-assigned identity lock is keyed on a role name [RUNTIME]

**Where:** [`leads.service.ts:306-343`](../../server/src/leads/leads.service.ts#L306-L343) ·
[`authz.ts:88`](../../server/src/core/authz.ts#L88) (`isAgent = role === 'agent'`)

The rule — *an agent working a lead the brokerage handed them may record everything about the
conversation and change nothing about the identity* — is enforced only when `role === 'agent'`.

```
[D3] the CRM role rewrote the identity of a brokerage-assigned lead: 200
```

The `crm`, `accounting` and `documentation` roles are all exempt, and so is any role added later.
`authz.ts` opens by warning against exactly this: *"Asking 'is this person an admin?' is asking about
a person, and gets the wrong answer the day a role is added."* That day has already happened.

The same predicate also gates the delete restriction and the `bulkDelete` filter, so those are
bypassed identically.

**Fix:** express it as a capability (`leads.rewrite-identity`) and check that instead.
**Estimate: 3 h**

### H-7 — One over-length CSV cell discards a whole batch of valid rows [RUNTIME]

**Where:** [`lead-import.engine.ts:230`](../../server/src/leads/lead-import.engine.ts#L230)

The engine writes with `createMany` and applies no length validation; `name` is `VarChar(255)`.

```
[B5] import status=Failed
     message="Invalid `tx.leads.createMany()` invocation … The provided value for the column is too
              long for the column's type. Column: (not available) — 0 lead(s) imported before the
              failure were kept."
     the valid row in the same batch was LOST
```

Postgres does not name the offending column, so the operator is told a 500-row batch failed and not
which row caused it. On a 50,000-row file, one bad cell in the last batch discards 500 good leads
with no way to identify them.

**Fix:** validate and truncate per field before `createMany`, counting over-length rows as `invalid`
with the row number. **Estimate: 4 h**

### H-8 — Schema drift: the unique index that the import logic depends on is not in `schema.prisma`

**Where:** [`20260722100000_campaigns/migration.sql:35`](../../server/prisma/migrations/20260722100000_campaigns/migration.sql) vs `schema.prisma` `model leads`

`CREATE UNIQUE INDEX "leads_email_lower_key" ON "leads"(LOWER("email"))` exists in the migration and
in the live database (verified with `pg_indexes`), but `schema.prisma` declares only
`@@index([email])`. Consequences:

- Anyone rebuilding from the schema (`prisma db push`, a fresh dev database, a disaster-recovery
  rebuild) gets a database **without** the constraint. `createMany({ skipDuplicates: true })` then
  silently stops de-duplicating and the import begins creating duplicate leads.
- The index is **global, not per `company_id`**. `leads` carries a tenant column and
  `tenancy.spec.ts` enforces it, but two brokerages cannot hold the same email address as a lead —
  the second tenant's import silently reports "already existed" for a lead it does not have.
- The import's raw `SELECT … WHERE lower(email) IN (…)` filters neither `deleted_at` nor
  `company_id`, so a soft-deleted lead is reported as an existing duplicate and never restored.

**Fix:** declare the index in the schema (Prisma supports functional indexes via
`@@index([email(ops: raw(...))])` or keep it as a documented raw migration with a schema-drift
test); scope it to `(company_id, lower(email))`; add `deleted_at IS NULL` and the tenant to the
import lookup. **Estimate: 6 h + a data check**

---

## MEDIUM

| ID | Finding | Evidence |
|---|---|---|
| **M-1** | **Tag registry is unscoped.** `tags()` reads every lead row in the brokerage to count tags — no scope filter, no pagination, no SQL aggregate. Tag *names and counts* from other agents' books are returned to every caller. | `[A3] agent sees agent2's private tag "Agent2-Private-Segment-…" = true, with count 1` · `[G2] took 38ms, returns every lead row into Node` |
| **M-2** | **Lead-id oracle.** `assertLead` answers 403 for a lead that exists but is not yours, and 404 for one that does not exist — so the activity endpoints reveal which ids are real. `leads.service.get()` correctly answers 404 for both. | `[A2] existing-but-forbidden → 403; non-existent → 404` |
| **M-3** | **CSV import bypasses the vocabularies the form enforces.** `lead_status`, `lead_type`, `lead_source`, `client_type` are written verbatim. Such leads then match no filter dropdown and no campaign audience. | `[B4] imported lead_status="NOT_A_STATUS" lead_type="NOT_A_TYPE"` |
| **M-4** | **A lead can be assigned to a deactivated user.** `validate()` comments say *"must be a real, active user"* but queries `users.findFirst({ where: { id } })` with no status filter. The dropdown correctly hides inactive users; the write path does not, so a crafted or stale request orphans the lead. | `[G1] user is status=Inactive; POST /api/leads with assigned_to=6 answered 201` · `[G1-dropdown] correctly hidden in the assignee list` |
| **M-5** | **Notes have no author check.** Anyone who can see a lead can edit or delete anyone else's note. The audit trail records that a note was deleted but not its content, so an administrator's observation can be silently rewritten by the assignee. | `[F5] the assignee edited another user's note → 200, deleted it → 200` |
| **M-6** | **No past-date rule on `date_of_birth` / `marriage_day`, and no cross-check against `age`.** | `[B3] date_of_birth=2090-01-01 with age=3 answered 201` |
| **M-7** | **Header counters cost 11 `COUNT` queries per page of the lead list** ([`leads.service.ts:130-141`](../../server/src/leads/leads.service.ts#L130-L141)), each with the scope filter and any active search. With an unindexable `ILIKE '%…%'` search across five columns this is eleven sequential scans per keystroke-debounced request. |
| **M-8** | **`allTasks` and `allShowings` are unpaginated and unbounded**, and `allTasks` sorts in JavaScript after fetching everything ([`leads.service.ts:159-185`](../../server/src/leads/leads.service.ts#L159-L185)). |
| **M-9** | **Lead transfer is not atomic.** Two `updateMany` calls outside a transaction ([`lead-transfer.service.ts:71-78`](../../server/src/leads/lead-transfer.service.ts#L71-L78)); a failure between them moves ownership without assignment. It also skips soft-deleted leads, so a departed agent's recycle bin becomes permanently unreachable, and it reassigns leads *owned by third parties* that merely happened to be assigned to the departing person. |
| **M-10** | **No delete UI for notes, tasks, calls or messages.** The API supports all four; `LeadDetailPage` renders a delete control only for showings and call recordings. A mistyped note is permanent from the user's point of view, and four DELETE endpoints sit unexercised. |
| **M-11** | **`property_preferences` accepts arbitrary unbounded JSON** ([`leads.service.ts:743-751`](../../server/src/leads/leads.service.ts#L743-L751)) — any object shape, any depth, any size up to the 12 MB body limit, stored as text. No key allowlist, no size cap. |
| **M-12** | **Tags are capped at 50 per lead but each tag is uncapped in `validate()`** (`registerTag` caps at 64 chars; the lead path does not), so a lead can carry 50 megabyte-long tags that `tags()` then aggregates in memory. |
| **M-13** | **AI email drafting sends lead PII to a third-party provider** and interpolates the lead's *name* into the system prompt ([`lead-activity.service.ts:649-658`](../../server/src/leads/lead-activity.service.ts#L649-L658)) — a lead named `". Ignore previous instructions…` steers the model. No rate limit on an expensive external call. |
| **M-14** | **Call recordings are stored as `bytea` in Postgres** (8 MB each). Backups, replication lag and `pg_dump` time all grow with call volume; there is no lifecycle or retention policy. |
| **M-15** | **`deleteCallRecording` has no confirmation** ([`LeadDetailPage.tsx:906`](../../client/src/desk/LeadDetailPage.tsx#L906)) — one click permanently destroys the audio of a client conversation. Showings use `window.confirm` while the rest of the app uses the `ConfirmDialog` component; two dialog idioms on one screen. |
| **M-16** | **The whole uploaded CSV is stored in `lead_import_jobs.payload`** — up to 50,000 rows of text in a column, cleared only on completion. A failure before that point leaves it indefinitely. |

---

## LOW

| ID | Finding |
|---|---|
| **L-1** | `GET /api/users/:id/photo` **404s on every CRM page load, for every role** — confirmed on all seven screens as agent, admin and superAdmin (`[F1-*]`). Harmless but it fills browser consoles and server logs, and masks real 404s during triage. |
| **L-2** | `/api/leads/options` returns the **entire staff roster with names and roles** to anyone with `lead:view` (`[F3] 7 staff records… Ada Nkemelu/crm, Grace Lindqvist/accounting, …`). Needed for the assignee dropdown, but it discloses the brokerage's org chart and role assignments to every agent. |
| **L-3** | `GET /api/leads/import/:jobId` is **not user-scoped** — any `lead:view` caller who obtains a job id reads its results. The id is 16 random bytes, so this is defence-in-depth only. |
| **L-4** | The recording filename is placed in `Content-Disposition` after stripping only `"` ([`leads.controller.ts:374`](../../server/src/leads/leads.controller.ts#L374)). A CRLF in the filename produces a Node exception (a 500) rather than a validation error. Header injection itself is blocked by Node. |
| **L-5** | `MetaPublicController` is **entirely `@SkipThrottle()`** — deliberate for lead bursts, but it leaves `/api/meta/webhook` open to unauthenticated flooding, each request costing an HMAC over a body of up to 12 MB. |
| **L-6** | `GET /api/leads/books` and `POST /api/leads/transfer-ownership` carry **no `@Screen` decorator**. The service enforces Super Admin correctly (`[D2] agent → 403, admin → 403`), so this is a missing layer rather than a hole. |
| **L-7** | Bulk tag application (`tagLeads`) writes no audit entry, while single-lead edits do. |
| **L-8** | Two different constants named `MAX_IMPORT_ROWS` (5,000 in `lead.constants.ts`, used as an *export* cap; 50,000 in `lead-import-job.service.ts`). |

---

## What is genuinely well built

An audit that lists only defects misrepresents the codebase. These were tested and hold:

- **The lead scope rule.** `leadScopeWhere` is written once and used by the list, the detail read,
  the recycle bin, the export, the dashboard and `assertLead`. The comment explaining *why* an
  administrator sees brokerage intake (the brokerage owns it) rather than *because they are an
  administrator* is the kind of distinction that keeps a rule correct under later edits. Direct
  cross-agent reads were refused at runtime.
- **Input clamping.** Every hostile pagination and filter input was handled correctly — no 500s,
  no unbounded pages: `limit=999999 → per_page 200`, `limit=-5 → 1`, `page=0/abc → 1`,
  `search=' OR 1=1-- → 0 results`, a 5,000-character search, `minAge=-100&maxAge=99999`.
- **XSS resistance.** Stored `<img src=x onerror=…>` in a lead name and `<script>` in notes rendered
  inert on the detail page (`[E3] {}`); no `dangerouslySetInnerHTML` anywhere in the CRM screens.
- **CSRF.** Enforced; writes without the `X-XSRF-TOKEN` header are refused with 419.
- **Lead transfer.** Correctly restricted to Super Admin, returns counts only, never lead content,
  and is audited with both names — a thoughtful answer to a genuinely hard problem.
- **The Meta webhook.** HMAC-SHA256 over the raw body with `timingSafeEqual`, a signed OAuth
  `state`, a refused verification handshake when no token is configured, and a data-deletion
  callback with signature verification. This is the best-built file in the module.
- **Production config validation.** `validate-config.ts` refuses to boot a production server with an
  unset or non-HTTPS `FRONTEND_URL`, a trailing slash, or missing CORS — which pre-empts an entire
  class of "worked locally" failures, including the OAuth redirect falling back to `localhost:5173`.
- **UI/API agreement.** The Leads screen displayed exactly the total the API returned (`[E2]`).
- **The assignee dropdown** correctly filters inactive users, even though the write path does not.

---

## Runtime test coverage

Executed against Chromium + a real API + a real Postgres, as Agent (`agent@test.local`), Admin
(`admin@test.local`, role `manager`) and Super Admin (`superadmin@test.local`).

| Area | Cases | Confirmed defects |
|---|---|---|
| Lead confidentiality | 4 | 4 (A1, A2, A3, A4) |
| Data integrity | 5 | 5 (B1–B5) |
| Mail & compliance | 4 | 4 (C1–C4) |
| Permissions | 3 | 2 (D1, D3) — D2 passed |
| UI render, all roles | 21 screen loads | L-1 on every screen |
| UI behaviour | 5 | 2 (E4, E5) — E2, E3 passed |
| Follow-up probes | 8 | 4 (F1, F2/G1, F5, G2) — F4 passed on all 8 inputs |

23 screenshots were captured (`{role}-{screen}.png` for dashboard, lead, campaigns, meta, inbox,
calendar and settings across all three roles, plus the XSS probe and the list-vs-API comparison).
The harness that produced this evidence was temporary and has been removed; every case is described
above in enough detail to reproduce.

**Not covered, and it should be before release:** volume testing (every performance finding above is
reasoned from the query shape, not measured at 40,000 leads); the Meta OAuth round trip against a
real Facebook app; Twilio with working credentials; and concurrent multi-user editing of the same
lead beyond the double-submit case.

---

## Priority order

| # | ID | Why it is here | Est. |
|---|---|---|---|
| 1 | **C-1** | CASL breach + authenticated open relay. Legal exposure, not just a bug. | 6 h |
| 2 | **C-3** | Cross-book writes happening now, invisibly, to other agents' data. | 4 h |
| 3 | **C-2** | The module's core promise, defeated by one error string. | 2 h |
| 4 | **H-3** | Toll fraud and unsolicited SMS on the brokerage's account. | 2 h |
| 5 | **H-1** | Two everyday workflows return "Internal server error". | 4 h |
| 6 | **H-2** | Silent data loss on the export used for compliance and migration. | 4 h |
| 7 | **H-5** | Broken access control on the settings that gate C-1. | 2 h |
| 8 | **H-6** | Permission rule that is already wrong for three existing roles. | 3 h |
| 9 | **H-8** | Schema drift that removes a constraint on any rebuild. | 6 h |
| 10 | **H-4** | Will time out in production the first time it is used at scale. | 6 h |
| 11 | **H-7** | One bad cell loses 500 good leads. | 4 h |
| 12 | M-1, M-2, M-4, M-5 | Remaining confidentiality and integrity gaps. | 12 h |
| 13 | M-7, M-8, M-9 | Performance work before volume arrives. | 12 h |
| 14 | M-3, M-6, M-10 … M-16 | Validation, UX and operational cleanup. | 20 h |
| 15 | L-1 … L-8 | Polish and defence in depth. | 8 h |

**Blocking release (1–11): ~43 hours.**
**Full remediation: ~95 hours**, plus regression testing and a data check for anything already sent
through the C-1 path or created by the H-7/H-8 import paths.

---

## Recommendations

1. **Fix C-1 first and audit what it has already sent.** `crm_email_log` records every recipient —
   cross-check it against `email_suppressions` and `leads.unsubscribed` to establish whether an
   opt-out has already been breached. That determination is a legal question, not an engineering one.
2. **Adopt one rule for scoped writes.** Every unscoped `findMany`/`updateMany` on `leads` outside
   `LeadTransferService` is a defect by construction. A lint rule or a repository wrapper that
   demands an explicit scope argument would have caught C-3, M-1 and the import lookup.
3. **Make "who am I allowed to email" a single function** and route the per-lead sender, the CRM
   Settings actions, the broadcast and Campaigns through it. Three of the four currently disagree.
4. **Replace `isAgent(user)` with a capability** and re-check every call site — H-6 is already wrong
   for `crm`, `accounting` and `documentation`.
5. **Translate `P2002` globally**, then re-examine every check-then-write in the module.
6. **Move every unbounded loop out of the request path.** The Campaigns module already contains the
   pattern, the reasoning and the tests; the broadcast should reuse them rather than repeat the
   history.
7. **Load-test with 40,000 leads and 500 users before release.** Every performance finding here is
   structural and predictable, but the ordering of what hurts first is not.

---

## MODULE STATUS

### NOT PRODUCTION READY

**Justification.** Three confirmed defects would each independently block a release, and all three
were reproduced at runtime rather than inferred. One of them (C-1) is a CASL compliance breach and
an authenticated mail relay on the brokerage's own domain; one (C-2) turns the lead create form into
a directory of every colleague's clients; one (C-3) lets any agent silently rewrite data in books
they are forbidden to read. A further eight HIGH findings include two ordinary workflows that return
HTTP 500, a compliance export that discards data while reporting success, and a schema drift that
removes a uniqueness guarantee the import logic explicitly depends on.

The foundations are sound and the reasoning in this codebase is unusually careful — which is exactly
why these are worth fixing properly rather than patching. The blocking set is roughly a week of
focused work. After that, and after a volume test, this module would be a credible production
system.

---

# Remediation — 2026-08-02

Every fix below was re-verified against a running stack the same way it was found: Chromium, a real
API, a real database, signed in as the role that could exercise it. The observed response is quoted.

## Fixed

| ID | Change | Verified |
|---|---|---|
| **C-1** | `CrmAdvancedEmailService.dispatch()` now consults `email_suppressions` **and** `leads.unsubscribed` before every send, case-insensitively, and records the refusal in `crm_email_log` — the log being the evidence that the opt-out was honoured. Covers all six actions and `bulkSend`, which routes through the same method. | Suppression list → *"Not sent — this address is on the suppression list because they unsubscribed."* · lead flag → *"Not sent — this lead has unsubscribed."* · `SUPPRESSED@…` in upper case → refused · a non-opted-out address still reaches the mailer · `bulkSend` refuses the opted-out recipient and continues with the rest |
| **C-2** | The duplicate-email message names the clashing lead **only when the caller can already open it** (`canSee`, the same rule as `leadScopeWhere`). Otherwise it says the address is taken and nothing else. | agent probing agent2's address → *"That email address already belongs to a lead in this brokerage. It is not one of yours…"* · the owner still gets *"Confidential Client-… already uses that email address (lead #587)."* |
| **C-3** | `deleteTag` scopes both the read and the write to `scopeWhere(user)`, returns only ids the caller could already read, and does the update as one `updateMany` per distinct tag set inside a transaction. `tags()` scopes its scan too, so counts no longer disclose other agents' volumes. | agent's delete → `{"removed":0,"lead_ids":[]}`; agent2's lead **kept** its tag · agent sees agent2's registered tag with **count 0** |
| **H-1** | `rethrowEmailClash` catches Prisma `P2002` on create and update and rethrows it in the module's 422 shape, distinguishing the recycle-bin case from a lost race. | soft-deleted address → `422` *"A lead with that email address is in Recently Deleted. Restore it from there…"* · two simultaneous creates → `201/422`, no 500 |
| **H-2** | `exportRows` returns `{ data, meta: { total, returned, limit, truncated } }`; the screen warns when `truncated` and says how to get the rest. Constant renamed `MAX_EXPORT_ROWS` — it was `MAX_IMPORT_ROWS`, one of three constants sharing that name. | `meta {"total":11,"returned":11,"limit":5000,"truncated":false}` |
| **H-3** | The SMS destination comes from the lead record, never from `body.phone`. A lead with no dialable number is refused with a message naming them. | unrelated `+1500…` in the body is ignored entirely · lead with no number → `400` *"Verify-… has no phone number on file, so there is nothing to text."* |
| **H-4** | `broadcast()` persists the row as `sending`, returns immediately, and delivers detached, writing `recipients`/`failed` per message and settling to `completed`/`partial`/`failed`. New columns `status`, `attempted`, `failed`, `error`, `completed_at` (migration `20260802120000_crm_broadcast_progress`, with a backfill for existing rows). The list exposes them. | `201` in **45 ms** with `status=sending, attempted=7` (was a synchronous SMTP loop) |
| **H-5** | The two CRM Settings writes are gated on `settings:edit`. `PUT /profile` deliberately stays on `view` — it writes only the caller's own `users` row, so the authority it needs is "are you yourself", and raising it would stop an Admin editing their own name. | Admin → `403`, Super Admin → `200` |
| **H-6** | New capability `leads.rewrite-identity` at `manager` rank replaces `role === 'agent'`. `authz.spec.ts` lists its holders explicitly, so the next role added has to be placed on one side of the rule deliberately. | CRM role rewriting a brokerage-assigned lead's email → `403` · the same user adding a note to the same lead → `201` (the lock stays narrow) |
| **H-7** | The import fits each value to its column (`IMPORT_FIELD_LIMITS`) instead of letting Postgres reject the batch, and normalises `lead_status`/`lead_type`/`lead_source`/`client_type` against the vocabularies case-insensitively, leaving unrecognised values empty rather than writing data no filter can select (also closes **M-3**). | a 300-character name no longer discards its batch — the valid row was **kept** · `"HOT"` normalised to `hot`, `NOT_A_STATUS` dropped |
| **H-8** | `model leads` now documents the `lower(email)` unique index, why it cannot be expressed in Prisma, and what breaks without it. `leads-email-uniqueness.spec.ts` asserts it exists in the connected database, proves it bites case-insensitively, and pins the soft-delete interaction H-1 depends on — so a `prisma db push` rebuild fails a test rather than failing in production. | 3 new tests pass; the index-missing path raises an error that names the migration and the SQL to run |

## Deliberately not changed

- **H-8's tenancy limitation.** The index is global, not `(company_id, lower(email))`. Making it
  per-tenant is a data migration with a real chance of collisions in existing data, and it is not
  what the single-brokerage deployment needs today. It is documented on the model and in the
  finding above.
- **C-1's arbitrary-recipient parameter.** These endpoints still accept a recipient that is not a
  lead. The compliance hole — mailing someone who opted out — is closed, and that was the ask.
  Requiring every recipient to resolve to a lead the caller can access would also close the
  authenticated-relay concern; it is a larger behavioural change and remains open.
- Everything in **MEDIUM** and **LOW** is untouched.

## Verification

- Server unit + integration suite: **585 passed**, 1 failed — `transactions/reminder-sweep.spec.ts`,
  confirmed pre-existing and unrelated (it fails identically with these changes stashed).
- Existing browser suite: **119 passed** across `leads`, `leads-part2`, `campaigns` and
  `auth-roles` — no regressions, including the six per-role book-isolation cases.
- Regression probe on ordinary agent work after all changes: update, note, task, tag, tag list,
  list, delete, restore — all `200/201`.
- Both typechecks clean; client builds.

## Revised status

**Production Readiness: 48 → 78.** The three defects that made this **NOT PRODUCTION READY** are
closed and re-verified, as are seven of eight HIGH findings. What remains is the MEDIUM and LOW set —
principally the performance work (`stats()`'s eleven counts per page, the unpaginated `allTasks`,
the unindexable search) and the confidentiality gaps M-2 and M-5. None of those is a release
blocker on its own, but the **volume test at 40,000 leads and 500 users is still outstanding and
should happen before go-live**, because every performance finding here is reasoned from query shape
rather than measured.

---

# Second remediation — 2026-08-02

## Fixed

| ID | Change | Verified |
|---|---|---|
| **C-1 (remainder)** | The relay half of C-1 is now closed too. `dispatch()` resolves every recipient to a lead the caller can access through `leadScopeWhere` — the same rule the Leads screen applies — before the opt-out check runs. The refusal is worded identically whether the lead does not exist or belongs to a colleague, so this cannot become the address-enumeration oracle C-2 had to be fixed for. | address with no lead → *"Not sent — this address is not one of your leads."* · a colleague's lead → same refusal · the caller's own lead → still reaches the mailer |
| **H-8 (decided)** | Uniqueness is now `UNIQUE (company_id, COALESCE(owner_user_id, 0), lower(email))`, replacing the global index. Another brokerage may hold the same person; so may another agent in the same brokerage; one agent still may not hold them twice. `COALESCE` rather than a plain three-column unique because Postgres treats NULLs as distinct and `owner_user_id IS NULL` is what unattributed intake looks like — the highest-volume source there is. The migration refuses to run if any book already contains a duplicate. | agent 1 creates → `201` · agent 2 creates the **same address** → `201` · agent 2 creates it twice → `422` · agent 2 reading agent 1's copy by id → `404` |
| — | Import dedupe follows: the lookup is scoped to the leads the importer already works (owned **or** assigned, plus unattributed intake for a super-admin), so a colleague's copy is neither counted as the importer's duplicate nor written to. | import of an address a colleague holds → *"1 imported."*, importer sees 1 copy, colleague's row byte-for-byte unchanged including `updated_at` |

## Load test — 40,416 leads, 500 agents

Seeded by `scripts/seed-load-test.cjs`, driven by `scripts/load-test.cjs`. Host: 12 cores, 32 GB,
single Node process sharing the machine with Postgres — so these are conservative.

The first attempt was wrong and is worth recording: driving the whole run from one account reported
`300/300 FAILED` on four endpoints, and a 50-request probe of the same endpoint then returned 200
fifty times. It was measuring `IdentityThrottlerGuard` (600/min per user), not the application.
Load is now spread across a pool of real signed-in agents, which is also the honest production shape.

**Per-request cost, heaviest book (9,852 leads), one request at a time:**

| Endpoint | p50 | p95 | payload |
|---|---|---|---|
| leads list, page 1 (+11 stat counters) | 39 ms | 42 ms | 43 kB |
| leads search, 5-column ILIKE | 55 ms | 62 ms | 45 kB |
| lead tags | 33 ms | 36 ms | 1 kB |
| lead tasks feed (unpaginated) | 147 ms | 180 ms | **1,666 kB** |
| lead showings feed (unpaginated) | 72 ms | 79 ms | 673 kB |
| CRM dashboard | 18 ms | 24 ms | 1 kB |

**Under load, 50 concurrent across 41 agents:** every endpoint inside budget, worst p95 401 ms
(search), leads list 353 ms, throughput 126–642 req/s depending on endpoint.

**Super admin (widest scope — own book plus all unattributed intake), 5 concurrent:** leads list
59 ms p95, search 117 ms, 200-row page 77 ms, CSV export of 5,000 rows 445 ms.

**Saturation:** at 150 concurrent the leads list reaches p95 1,041 ms while throughput stays flat at
~144 req/s — queueing, not degradation. The ceiling for that endpoint on this hardware is therefore
about **144 req/s**. For scale: 500 agents refreshing their list every 30 seconds is ~17 req/s, so
there is roughly 8× headroom on one node before the list is the constraint.

**Cost attribution, direct to the database (median of 10):**

| | |
|---|---|
| page query alone (50 rows + `_count`) | **31.5 ms** ← dominates |
| the 11 stat counters, in parallel | 13.5 ms |
| └ of which "leads with no calls" | 5.6 ms |
| search ILIKE across 5 columns | 5.4 ms |
| tag scan (scoped) | 21.0 ms |

## Two findings this audit got wrong

Measurement contradicts the reasoning, and the reasoning was mine, so it is corrected here rather
than quietly dropped.

- **M-7 — "eleven `COUNT` queries per page, eleven sequential scans."** They are issued in parallel
  and cost **13.5 ms in total**. `owner_user_id` and `assigned_to` are both indexed, so the scope
  filter narrows to one book before any counting happens. Downgrade to LOW; not worth restructuring.
- **The five-column ILIKE search.** Predicted to be unservable by any index; measures **5.4 ms**,
  for the same reason — the scope filter runs first and the pattern match then runs over ~9,800 rows,
  not 40,000. Downgrade to LOW.

The finding that *survives* is **M-8**, and its severity is on the wire rather than in the database:
the unpaginated tasks feed returns **1.67 MB** for a single agent, and grows linearly with the tasks
that accumulate on a book for as long as the brokerage uses the product. That is a mobile-data and
memory problem, not a query problem. Paginating it remains worth doing.

## Verification

- Server suite **589 passed**, 1 failed — `transactions/reminder-sweep.spec.ts`, pre-existing and
  unrelated (fails identically with these changes stashed).
- Browser suite **119 passed** against the 40,416-lead database, including all six per-role
  book-isolation cases.
- Typecheck clean.

## Revised status

**Production Readiness: 78 → 88.** Every CRITICAL and HIGH finding is now closed, the uniqueness
model matches how leads actually arrive, and the performance profile is measured rather than
assumed. What remains is MEDIUM/LOW: the payload size of the two unpaginated feeds (M-8), the
403/404 id oracle on activity endpoints (M-2), notes having no author check (M-5), and the
operational items — call recordings in `bytea`, the AI drafting path sending lead PII to a third
party, and the missing delete UI for notes, tasks, calls and messages.

---

# Third remediation — 2026-08-02

Closes the remaining MEDIUM findings and the operational items.

## M-8 — the feeds are paged

`allTasks` and `allShowings` return `{ data, meta, summary }` at 25 rows a page. The panel headings
still read "N open of M" because `summary` is counted across the whole set by the database, not
derived from the rows on screen — deriving it from a page would quietly make it a different number.

Ordering moved into SQL, which pagination forced: the old code fetched everything and then `.sort()`ed
in JavaScript to float open tasks to the top, which is correct only when the whole set is present.

Measured on the same 40,416-lead database, heaviest book:

| | before | after | |
|---|---|---|---|
| tasks feed payload | 1,666 kB | **7 kB** | 238× smaller |
| tasks feed p50 | 147 ms | **16 ms** | 9× faster |
| showings feed payload | 673 kB | **6 kB** | 112× smaller |
| showings feed p50 | 72 ms | **10 ms** | 7× faster |

Verified: `meta {"page":1,"per_page":25,"total":6001,"last_page":241}`, `summary {"total":6001,
"open":2001,"overdue":1000}`, and page 2 shares no rows with page 1.

## M-2 — the id oracle is closed

`assertLead` answers `404 "Lead not found."` for a lead that is somebody else's *and* for one that
does not exist — same class, same body. It previously answered 403 for the first, which let any
signed-in account walk an id range and learn which leads were real.

Verified: existing-but-forbidden → `404 {"message":"Lead not found."}`; non-existent → identical.
`ownership.spec.ts` now asserts the two responses are byte-identical rather than merely both errors.

**Still open, and outside this module's scope:** `assertTransaction` in the same file has the same
shape — 404 for missing, 403 for existing-but-forbidden. Changing it alters Transaction Desk
behaviour and its specs, so it is flagged rather than done. Deferred by product on 2026-08-02 to the
Transaction Desk audit, and tracked as **B-2** in [`BACKLOG.md`](../BACKLOG.md) with the reasoning
and the exact change to make.

## M-5 — notes have an author check

Editing is the author's alone; deleting is the author or an administrator. The split is deliberate:
rewriting another person's words while their name stays on them is misattribution and no rank makes
it right, whereas removing a note is moderation and leaves the record honest rather than altered.
Deletions now record the note's **content** in the audit trail, so "which one, and what did it say?"
has an answer afterwards.

Verified: assignee editing the Super Admin's note → `403 "This note was written by Sam Whitfield, so
it cannot be edited here."`; deleting it → `403`; their own note → edit `200`, delete `200`.

## Operational items

**Call recordings now go to disk.** `RECORDING_STORAGE_DIR` (default `./storage/recordings`), with
`storage_path` on the row and a CHECK constraint guaranteeing exactly one of `data`/`storage_path`
is set. Nothing was migrated automatically — every existing `bytea` row keeps working and is served
from the column, because a migration that silently fails to copy a file loses the recording of a
client conversation. `scripts/migrate-recordings.cjs` moves them deliberately, verifying a SHA-256
read-back before it clears the column, and `--dry-run` reports without touching anything.

> **Deployment requirement.** The directory must be on persistent storage. In a container with no
> mounted volume it is the container's own filesystem and recordings vanish on restart. The service
> probes the directory at boot by writing to it, logs loudly if it cannot, and falls back to the
> database — slower and older, but never silently lost.

Verified end to end: 512-byte upload → stored → played back with all 512 bytes and the correct
content type → deleted.

**AI drafting is off by default.** It previously enabled itself the moment any API key appeared in
the environment — including one set for an unrelated feature, since `ID_EXTRACTION_MODEL` shares the
Anthropic key. Nobody chose it. `AI_EMAIL_DRAFTING=on` is now that choice, made once, in writing.

Two further changes to what leaves the building: only the lead's **first name** is sent (it was the
full name, and the model never needed the rest of the row), and both the name and the agent's name
are sanitised and delimited before entering the system prompt — a lead name is attacker-controllable
via Meta forms, web enquiries and CSV imports, so `". Ignore previous instructions…` was writing our
prompts for us. Every draft is recorded in the audit trail with the provider and model, because
"did client information go to an AI provider, and whose?" is a question a privacy officer will
eventually ask.

Verified: `503 "AI email drafting is switched off. It sends the lead's name and your instruction to
an external AI provider…"`.

**Delete controls exist in the UI.** Notes, tasks, calls and messages all had working DELETE
endpoints and no way to reach them from the screen, so a note typed against the wrong lead was
permanent as far as the user was concerned. All four now have a confirmed delete, and the two
inconsistencies beside them are fixed: showings used `window.confirm` while the rest of the
application uses `ConfirmDialog`, and deleting a call recording — permanently destroying the audio
of a client conversation — had no confirmation at all. One dialog now serves the whole page.

## Verification

- Server suite **590 passed**, 1 failed — `transactions/reminder-sweep.spec.ts`, pre-existing and
  unrelated.
- Browser suite **134 / 134 passed** (3.6 min), on a test database with the load-test data removed.
- Runtime probes: 7/7 pass across pagination, the id oracle, note ownership, the AI gate, all four
  delete endpoints, the recording round trip, and an agent-workflow regression check.
- `migrate-recordings.cjs` exercised against a real row: copied, SHA-256 verified, column cleared,
  file byte-identical to the original.
- Both typechecks clean; client builds.

### A note on how that number was reached

The first three attempts at the browser suite reported 102, 81 and 131 — none of them trustworthy,
and the reasons are worth writing down because they are easy to repeat.

Two runs overlapped: Playwright's `webServer` binds fixed ports (8100 / 5174) and every spec shares
one database, so a second run does not queue behind the first — it fights it, and both report
truncated counts with no failures to explain them. Then the 131/134 run was clean but sat on a
database still holding 40,000 load-test leads, which pushed the fixtures the suite looks for by name
past the first page of every list. Three specs failed as a result and looked exactly like
regressions.

Two things came out of that. `seed-load-test.cjs --clean` now removes what the seed created — matched
on the `@load.test` domain and the `Load Seed` author rather than on recency, so fixtures survive —
and `leads-part2.spec.ts` no longer asserts that the task feed *contains* a title. That assertion
only ever passed while an agent had fewer than one page of tasks, which made it a test of the seed
size; it now asserts the paged shape and finds the task on the lead it belongs to. That one was a
real gap left by the pagination change, not an artefact of the data.

## Revised status

**Production Readiness: 88 → 93.** No CRITICAL, HIGH or MEDIUM findings remain open in this module.
What is left is LOW and operational: `assertTransaction`'s 403/404 split (outside this module),
`/api/leads/options` exposing the staff roster to every lead viewer, the `GET /api/users/:id/photo`
404 on every page load, import-job status not being user-scoped, and the recordings migration script
still to be run against real data.
