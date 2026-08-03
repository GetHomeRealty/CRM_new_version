# CRM › Settings — Enterprise Production Readiness Audit

**Date:** 2026-08-03
**Scope:** the Settings screen reached from the CRM area, and the API behind it.
**Method:** code inspection plus mandatory runtime testing (Playwright, six roles, live database).

---

## Scope boundary

"CRM › Settings" is `SettingsPage.tsx` mounted at `/crm/settings`. Its tabs are declared with an
`area`, so from the CRM the screen offers exactly three:

| Tab | Gate in the UI | Backing API |
|---|---|---|
| **CRM Settings** | `superAdmin` | `/api/crm-settings/*` |
| **Company Settings** | `settings` screen | `/api/company-settings` |
| **Roles & Permissions** | `users` screen | `/api/roles/*` |

**Transaction Desk Settings** (Integrations, Templates) carries `area: 'desk'` and does not appear
in the CRM. It is out of scope and was not audited; where a Desk-side surface consumes CRM Settings
data, that handoff is verified and labelled.

Roles & Permissions was audited only where it acts *on* Settings — the grant path in **S-H2**. The
role engine itself belongs to the Users module, already audited separately.

**Runtime environment.** API on 8100, SPA on 5174, `myapp_test`, seeded accounts for `admin`
(Super Admin), `manager` (Admin), `agent`, `accounting`, `documentation`, `crm`. All probe data was
removed and the database restored; the 148-test browser suite was re-run afterwards.

---

## Executive Summary

The Settings module is **well built at the perimeter and unreliable in the middle**. CSRF is
enforced (419 without the header), unauthenticated writes are refused, mass assignment is closed by
a global `whitelist: true` pipe, the DTO is a real allow-list, stored values are escaped by React,
path traversal is defended on every filesystem read, and the read-only rendering for `settings:view`
is correct — I expected that last one to be broken and it was not.

What blocks it is a different class of problem, and it is the same class the Users audit found:
**controls that report success and do not do what they say.**

- An administrator can grant `settings: edit` through Roles & Permissions. The grant is accepted,
  the API reports it, the form becomes editable — and **every save returns 403**, because the server
  gates on `isSuperAdmin` while the client gates on the permission.
- The CRM Triggers screen offers seven automatic emails with a "Days Before" schedule. **No
  scheduler exists.** Nothing sends them, and the message body the administrator writes is never
  used by the code that does send.
- The brokerage's **operating bank account, transit, institution and HST numbers** are returned to
  the `crm` role, which holds `transactions: 'none'` and `invoice: 'none'` and cannot open a single
  screen that displays them.

Each of these looks configured, reports success, and produces no effect or the wrong effect. None
would be discovered by the person who set it — they would be discovered by the birthday email that
never arrived, or by the bank account that turned up somewhere it should not have.

### Production Readiness Score

**58 / 100.**

| Band | Count |
|---|---|
| Critical | 0 |
| High | 5 — **all fixed 2026-08-03** |
| Medium | 12 |
| Low | 7 |

No Critical. Nothing here is remotely exploitable without a session, nothing escalates to Super
Admin, and no financial figure is silently miscalculated — the one financial hazard fails loudly
against a unique index rather than producing duplicate invoice numbers.

---

## CRITICAL

**None.** Stated plainly rather than manufactured: I tried unauthenticated writes, CSRF omission,
mass assignment of `role`/`id`/`feature_flags`, SQL injection, path traversal on the logo, and
privilege escalation through the profile form. All were refused. See *What is genuinely well built*.

---

## HIGH

### S-H1 — the brokerage's bank account is readable by roles that have no transactions access

`GET /api/company-settings` strips the banking block only when `isAgent(user)` — a literal
`role === 'agent'` test. Every other role gets all of it.

Measured, one request per role:

| Role | Banking fields returned | Should have them? |
|---|---|---|
| `admin` (Super Admin) | all six | yes |
| `manager` (Admin) | all six | yes |
| `accounting` | all six | yes — invoicing |
| `documentation` | all six | **yes** — see the correction below |
| `crm` | **all six** | **no** |
| `agent` | none — correctly stripped | no |

The six are `bank_beneficiary`, `bank_name`, `transit_no`, `account_no`, `institution_no`,
`hst_number`.

The `crm` role's own permission map is `transactions: 'none'`, `invoice: 'none'`, `settings: 'none'`
— it exists to work leads, reviews and clients. It cannot open a single screen that displays these
numbers, and the API hands all of them over on request.

> **Correction, 2026-08-03.** As first written this finding named `documentation` alongside `crm`.
> That was wrong, and checking it before fixing it is what caught it: the Deposit Receipt and Lawyer
> Statement buttons in `TransactionDetailPage` are gated on `!isAgent`, and `documentation` holds
> `transactions: 'edit'`, so it reaches them and legitimately needs the numbers to produce those
> documents. Only `crm` — which holds `transactions: 'none'` — was wrongly included. The fix reflects
> the corrected finding, not the original one.

The controller's comment defends the design correctly *for agents* — the buttons that print banking
detail sit behind `!isAgent` in `TransactionDetailPage`. The defect is that the guard was written as
the role rather than as the question. `authz.ts` opens by warning against exactly this, and the
Leads module already replaced the same pattern with a capability (`leads.rewrite-identity`). This
one was missed.

A brokerage's operating account number is the raw material of payment-redirection fraud. It should
not be one authenticated `fetch` away from the CRM coordinator's login.

**Fix:** replace `isAgent(user)` with a capability — `company.read-banking`, set at the level that
actually needs it (`accounting`, and `manager` and above). Roughly 1 hour including tests.

### S-H2 — `settings: edit` can be granted, is displayed as granted, and does nothing

Demonstrated end to end against the running application:

1. As Super Admin, `PUT /api/roles/2/permissions` with `settings: 'edit'` → **200**.
2. Sign in as the Admin. `GET /api/user` reports `permissions.settings === "edit"`.
3. `CompanySettingsPage` computes `canEdit = can('settings','edit')` → **true**: every input
   enables, the **Save** button appears, Upload Logo and Remove Logo enable.
4. `PUT /api/company-settings` → **403**.

The client authorises on the screen permission; the server authorises on `AdminGuard`, which is
`isSuperAdmin`. Two different authorities for one action, and the product ships a screen whose whole
purpose is to grant the one that does not work.

The user-visible result is a fully editable form where Save always fails with *"Could not save
(admin only)"* — a message that contradicts the permission the administrator just granted and can
see listed as granted.

This is the U-H2 class from the Users audit ("a permission grant is accepted, displayed as granted,
and does nothing"), in a different module.

**Fix:** decide which authority governs, then make both sides ask it. Either gate the controller on
`@Screen('settings','edit')`, or remove `settings` from the grantable set and have the UI gate on
`isSuperAdmin`. The first is the smaller change and matches the tab's own precedent. 2–3 hours
including the role-matrix test.

### S-H3 — the CRM email triggers promise automation that does not exist

CRM Settings presents **"Automatic sending — master switch for the triggers below"** over seven
toggles (Birthday, Anniversary, Wedding, Seasonal, Promotional, Referral, Custom). The CRM Triggers
screen adds, per trigger, *"The message used for each **automatic** CRM email"* and a **Days Before**
field bounded 0–365.

Two separate findings, both confirmed by exhaustive search of the scheduling layer:

**(a) Nothing fires them.** Every background job in the application is a `setInterval` registered in
a service — event reminders, campaign resume, IMAP sync, mail retention, Meta sync, export sweep,
lawyer reminders. **None reads `crm_settings.templates`, `crm_email_settings.template_toggles` or
`auto_send_enabled` on a schedule.** `grep` for `isTriggerEnabled|autoSendEnabled|daysBefore` outside
the CRM Settings module itself returns nothing. The toggles gate only the *manual* dispatch endpoint
`POST /api/crm-settings/email-settings` with an `action`.

An administrator who switches Birthday on and sets "7" will get no birthday emails, ever, and no
indication of that.

**(b) The message body is never used.** `CrmAdvancedEmailService.sendWeddingCongratulations`,
`sendSeasonalWishes` and their siblings build their bodies from hardcoded template literals in the
service. The `template` string the administrator writes on the Triggers screen is saved to
`crm_settings.templates` and read back only by the form that wrote it.

**Fix:** either build the scheduler (a daily sweep over lead birthdays/anniversaries honouring
`daysBefore` and the toggles, rendering the saved template — 2–3 days with tests), or relabel the
screen honestly and remove "Days Before" until it does something (2 hours). The second is the
correct pre-launch call; shipping the first under time pressure is how half-working automation gets
into production.

### S-H4 — the CRM profile form bypasses the duplicate-name guard the Users module enforces

`PUT /api/crm-settings/profile` validates name length, username uniqueness and email uniqueness. It
does **not** apply the rule `users.service.ts` enforces: a name already held by another account —
active *or* deactivated — is refused.

Runtime, as the Admin (Priya Raman), with the agent Dana Okafor already on the books:

```
PUT /api/crm-settings/profile  { name: "Dana Okafor", ... }  →  200
{"id":2,"name":"Dana Okafor", ... ,"message":"Personal information updated successfully"}
```

Two accounts now share one name. That is **U-C1**, the finding the Users audit opened with — where
`findFirst({ where: { name } })` resolves a commission profile to whichever row the planner reaches
first, and a deal pays the wrong percentage. The Users module was hardened at the point of entry;
this endpoint is a second point of entry that was not.

The `PersonResolver` work of 2026-08-03 reduces the blast radius — transactions written since then
carry `agent_user_id` — but the name fallback still serves every row that predates it, and the
deterministic tie-break is a mitigation, not a fix.

Reachable by `manager` and `admin` only (the endpoint is `@Screen('settings','view')`, held by those
two roles). That bounds it; it does not close it, and an Admin renaming themselves to an agent's
name is an ordinary typo away.

**Fix:** call the same name-uniqueness check the Users service uses. 1–2 hours including a test
proving both entry points refuse the same input.

### S-H5 — Settings is single-tenant while the schema is multi-tenant

`company_settings` **is** the tenant table: `users`, `leads`, `transactions`, `campaigns`,
`invoices` and fourteen more carry `company_id` referencing `company_settings.id`. The intent is one
row per brokerage.

Every Settings code path is hardcoded to row 1:

- `CompanySettingsService.current()` — `findUnique({ where: { id: 1 } })`
- `CompanySettingsService.update()` — `update({ where: { id: 1 } })`
- `storeLogo` / `removeLogo` — `where: { id: 1 }`
- `InvoiceNumberService.next()` — `where: { id: 1 }`

And the CRM side is worse — it does not filter by tenant *at all*:

- `getEmailSettings()` / `saveEmailSettings()` — `findFirst({ orderBy: { id: 'asc' } })`
- `isTriggerEnabled()` / `autoSendEnabled()` — same

The audit brief describes a brokerage **with multiple offices**. On that deployment: every office
edits one shared branding and banking row; `crm_email_settings` reads whichever row has the lowest
id regardless of company, so one office's trigger configuration governs all of them; and the invoice
counter is shared, so two offices interleave a single number series.

Today there is exactly one `company_settings` row, so nothing is currently wrong. The finding is
that **the module cannot become multi-office without being rewritten**, while the schema and
`tenancy.spec.ts` say that is the direction. `crm_settings` and `crm_email_settings` also carry
`company_id` columns that no query reads — the groundwork is laid and unused.

**Fix:** resolve the tenant from the session and filter on it, in both services. 1–2 days.
**Or** decide the product is single-brokerage and record that decision — deleting the unused
`company_id` groundwork is a bigger change than honouring it, so state the constraint and gate on
it. The wrong outcome is leaving it ambiguous, which is where it sits now.

---

## MEDIUM

### S-M1 — the logo accepts any bytes wearing an image extension

`POST /api/company-settings/logo` with `file_name: "evil.png"` and a body of
`<script>alert(1)</script>` → **200**, stored at `branding/logo-<random>.png`.

This is the same defect as **U-L1**, which was fixed for user avatars on 2026-08-03 by adding
`sniffImage()` to `user-photo.service.ts`. The fix was not applied to the logo, which is the *more*
exposed of the two: the logo endpoint is deliberately unauthenticated and the file is embedded in
invoices, receipts and client-facing email.

**Fix:** lift `sniffImage()` into a shared module and call it here. 1 hour. Include SVG handling —
see S-M2.

### S-M2 — SVG logos are accepted and served as `image/svg+xml` with script intact

`.svg` is explicitly on the allow-list. Uploading an SVG containing `<script>window.__xss=1</script>`
succeeds, and `GET /api/company-settings/logo` returns it with `Content-Type: image/svg+xml` and the
script tag present in the body.

**Measured mitigation, which changes the severity.** The response carries helmet's CSP:

```
default-src 'self'; script-src 'self'; script-src-attr 'none'; object-src 'none'; ...
```

`script-src 'self'` without `'unsafe-inline'` blocks the inline `<script>`, and `script-src-attr
'none'` blocks `onload=`. `X-Content-Type-Options: nosniff` is set. **So this is not a live XSS on
the API origin**, and I am not reporting it as one.

It remains a defence-in-depth gap on three counts: mail clients do not honour CSP and the logo is
embedded in outgoing email; the endpoint sets `Cache-Control: public, max-age=31536000, immutable`
for versioned URLs, so a CDN or reverse proxy in front of it may serve the file without the API's
CSP header; and the guarantee currently rests entirely on one header staying configured.

**Fix:** either drop `.svg` from the allow-list (raster only — simplest, and a logo does not need
SVG for the uses listed in the UI), or parse and sanitise the SVG and serve it with
`Content-Disposition: attachment` plus a restrictive per-response CSP. 2 hours for the former.

### S-M3 — an email differing only in capitalisation returns 500

The Users module was fixed for case-insensitive email and username (U-H5), backed by the functional
unique indexes `users_email_lower_key` / `users_username_lower_key`. `crm-settings.saveProfile`
pre-checks with a **case-sensitive** `findFirst`, so the check passes and the write hits the index:

```
PUT /api/crm-settings/profile  { email: "AGENT@TEST.LOCAL" }
→ 500  {"statusCode":500,"message":"Internal server error"}
```

The Users module translates P2002 into a 422 with a field error. This path leaks it as a 500. The
user is told the server broke; the truth is that the address is taken.

**Fix:** reuse the case-insensitive check and the `rethrowUniqueViolation()` translation already in
`users.service.ts`. 1 hour.

### S-M4 — the invoice counter can be rewound onto an already-issued number

`next_invoice_no` is editable in Company Settings, validated only as `@IsInt() @Min(1)`. Nothing
compares it against numbers already issued, and the UI offers no warning.

`InvoiceNumberService.next()` returns `invoice_prefix + next_invoice_no`, then increments.
`invoices.invoice_no` is `UNIQUE`. Demonstrated in a rolled-back transaction:

```
issued:                      INV-601107
next allocation after rewind: INV-601107  — collides: true
RESULT: insert rejected — P2002
```

The unique index means this **fails loudly rather than producing duplicate invoice numbers**, which
is why it is Medium and not High. The cost is that invoicing stops until someone works out that a
Settings edit is the cause — and the failure surfaces in the Invoices module, far from where it was
caused.

Adjacent, noted but not audited (Invoices is out of scope): `next()` is a read-then-update with no
locking, so two concurrent invoice creations under READ COMMITTED can both read the same counter.
The same unique index catches it the same way.

**Fix:** in Settings, refuse a value at or below the highest issued number on the current prefix,
with a message naming that number. 2–3 hours.

### S-M5 — a counter above the 32-bit column returns 500

`next_invoice_no: 2147483648` → **500**. `@Min(1)` with no `@Max`, against an `Int` (int4) column.
Postgres rejects it and the error is unhandled.

**Fix:** `@Max(2147483647)`, or widen the column. 15 minutes.

### S-M6 — concurrent edits silently overwrite

Two tabs, both Super Admin, both holding the same loaded row; each saves a different phone number:

```
first: 200   second: 200   final: "222-222-2222"   second warned: false
```

No version column, no `If-Match`, no conflict detection. In a brokerage where several administrators
maintain branding and banking, the second save wins and the first person is never told their change
was discarded. Because the form PUTs its whole state, this discards **every** field the first
administrator changed, not just the one that overlapped.

**Fix:** optimistic concurrency on `updated_at` — send it back, compare, 409 on mismatch. 3–4 hours
including the client-side reload prompt.

### S-M7 — Save is not disabled while saving

`disabledWhileSaving: false`; a double click issued **2** `PUT` requests. Both succeed, both write,
both write an audit entry. Harmless in outcome, wrong in behaviour, and the same class the Users
audit caught (there it produced a 500).

**Fix:** the `saving` state already exists on the component — bind it to `disabled`. 15 minutes.

### S-M8 — two settings fields are unbounded

`thank_you_note` and `deposit_heading` are `@db.Text` with `@IsString()` and **no `MaxLength`**. A
2 MB `thank_you_note` was accepted with a 200.

`company_settings` is read by `current()` on effectively every request that needs branding, and the
row is serialized whole. A multi-megabyte field is a permanent tax on every one of those reads, and
both fields are printed on documents where the layout assumes a sentence.

**Fix:** `@MaxLength(2000)` on both, matching what the document templates can render. 30 minutes.

### S-M9 — settings values are interpolated into HTML email with no escaping

`renderTemplate()` substitutes `{{ company_name }}` and friends with `String(value)` and no HTML
escaping. Demonstrated:

```
input:  Smith & Jones Realty
output: <p>Regards,<br>Smith & Jones Realty</p>       ← bare & in an HTML document

input:  <img src=x onerror=alert(1)>
output: <p>Regards,<br><img src=x onerror=alert(1)></p>
```

The injection half is bounded — only a Super Admin can write these fields, and a Super Admin can
already edit the email templates directly, so this is not an escalation.

**The correctness half is not hypothetical.** The shipped default for `company.email` is
`info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca` — a literal `&` that is already being
emitted into HTML email as an unterminated entity. Any brokerage named "Smith & Jones" hits it on
day one.

**Fix:** escape by default in `renderTemplate`, with an explicit opt-out for the variables that are
intentionally HTML (`logo_img`). 2–3 hours; the risk is the opt-out list, so it needs a test per
HTML-bearing variable.

### S-M10 — `crm_settings` has no foreign keys, and deleting a user strands its row

`crm_email_settings`, `crm_email_log` and `crm_broadcasts` each carry a real FK to
`company_settings`. `crm_settings` carries **none** — measured: `crm_settings FK count: 0` — despite
having both a `company_id` and a `user_id`.

Consequence, measured in a rolled-back transaction: create a user, create their `crm_settings` row,
delete the user → **the settings row survives**, holding their signature, forwarding address and
preferences. The Users module's `orphanRisk()` deletion guard counts eight tables and
`crm_settings` is not one of them, so nothing warns about it either.

Ids are not reused, so no future user inherits the row; the effect is permanent dead rows carrying a
departed person's mail-forwarding address.

**Fix:** add the FKs (`user_id → users ON DELETE CASCADE`, `company_id → company_settings`) and add
`crm_settings` to `orphanRisk()`. 2–3 hours including the migration and its pre-flight.

### S-M11 — the Settings screen overflows horizontally on a phone

At 390 × 844 (iPhone 14 class), `document.scrollWidth - clientWidth` = **157 px**. The page scrolls
sideways; the `.g3` field grid does not collapse.

Administrators do edit banking details from a phone. **Fix:** collapse `.g3`/`.g2` to one column
below ~600 px. 1–2 hours.

### S-M12 — form inputs have no programmatic labels

Six of six inputs on Company Settings have no association between their visible `<label>` and the
control:

```tsx
<div className="field"><label>{l}</label><input value={...} /></div>
```

No `htmlFor`/`id` pair, no wrapping, no `aria-label`. Screen readers announce an unlabelled edit
field; clicking the label does not focus the input. The same pattern repeats through
`CrmSettingsPanel`. (The `Toggle` component *does* wrap its input in the label and is correct.)

This is a WCAG 2.1 §1.3.1 / §4.1.2 failure — relevant under AODA for an Ontario brokerage.

**Fix:** generate an id per field and pair it. 2–3 hours across both panels.

---

## LOW

| ID | Finding |
|---|---|
| **S-L1** | No trimming on any company settings text field. `"  Padded Brokerage  "` is stored verbatim. The Users module was fixed for this (U-M1); Settings was not. |
| **S-L2** | A whitespace-only name passes `@IsNotEmpty`, is written, and is then silently replaced by the hardcoded factory default `"GetHomeRealty INC"` on the next read, because `current()` self-heals anything `phpBlank`. The administrator sees someone else's brokerage name appear. |
| **S-L3** | `currency` is `@MaxLength(8)` with no allow-list. `"CANADIAN"` was accepted and stored; it then prints on invoices where a 3-letter ISO code is expected. |
| **S-L4** | The company `email` field has no `@IsEmail()`. `"not-an-email"` was accepted and stored. It is printed on client-facing documents. |
| **S-L5** | `GET /crm-settings/email-log` and `/broadcasts` take `limit` uncapped (`Number(limit) || 100` straight into `take`). The test dataset was too small to demonstrate impact — reported as latent, not measured. |
| **S-L6** | The CRM Settings SMTP host/port/user fields are stored and displayed but never used to send anything — sending goes through `mail_accounts`. **The help text says so** ("kept for reference"), so this is a dead configuration surface rather than a misleading one. Noted for removal, not as a defect. |
| **S-L7** | The per-user `signature` (5,000 chars) is interpolated into outgoing HTML email unsanitised. Bounded — a user can only set their own, and it goes out under their own name — but it is unsanitised user HTML reaching client inboxes. |

---

## What is genuinely well built

Recorded because an audit that lists only faults misrepresents the module.

- **CSRF is real.** A write without `X-XSRF-TOKEN` returns **419**, verified per role. An
  unauthenticated `PUT` also returns 419.
- **Mass assignment is closed.** The global `ValidationPipe({ whitelist: true })` strips unknown
  keys; sending `feature_flags` and `id` alongside a valid body changed neither. The profile form
  refuses `role`, `status` and `password` — confirmed at runtime, the role was unchanged after the
  attempt.
- **The read-only rendering is correct.** `canEdit = can('settings','edit')` disables every input,
  hides Save, and prints "Read-only — only administrators can change company settings." I expected
  this to be the usual view/edit oversight and it was not. (The *grant* path is still broken —
  S-H2 — but the rendering is right.)
- **Path traversal is defended twice**, on both the read (`logoFile`) and the delete
  (`removeFile`), each re-resolving against `STORAGE_ROOT` and refusing anything outside it — even
  though the stored value is written by the same service.
- **`STORAGE_ROOT` is explicit and validated**, with a comment explaining precisely which deployment
  bug (cwd-relative paths under systemd/pm2/Docker) it exists to prevent.
- **The logo endpoint's caching is properly thought through** — ETag, conditional `304`, and a
  deliberate split between the version-pinned immutable URL and the revalidating bare one.
- **The DTO is a genuine allow-list** with per-field length caps matching the column widths, and the
  `@Transform(toNumber)` carries a comment explaining exactly why implicit conversion cannot work.
- **CRM settings validation is careful**: `validateNotifications`, `validatePreferences` and
  `validateTriggerTemplates` each rebuild the object from a known key set rather than merging what
  arrived, so an unexpected key cannot survive a round trip.
- **React escapes stored values.** A company name of `<img src=x onerror=...>` rendered inert on
  screen — the `onerror` did not fire.
- **The failure state is handled.** With every CRM settings read forced to 500, the panel shows
  "CRM settings are unavailable" rather than a blank screen or a crash.

---

## Findings by category

**Functional** — S-H3 (triggers never fire; message never used), S-L6 (inert SMTP fields).
**Workflow** — S-M6 (silent overwrite), S-M7 (double submit), S-M4 (counter rewind).
**Business logic** — S-H4 (duplicate name), S-M4, S-L2 (name reverts to factory default).
**UI/UX** — S-M11 (mobile overflow), S-M12 (labels), S-H2 (a form that cannot save).
**Database** — S-M10 (no FKs, stranded rows), S-H5 (tenant filtering), S-M5 (int4).
**Performance** — S-M8 (unbounded fields on a hot read), S-L5 (uncapped limit).
**Security** — S-H1 (banking exposure), S-M1 (no content check), S-M2 (SVG), S-M9 (unescaped
email), S-L7 (signature).
**Permissions** — S-H2 (grant does nothing), S-H1, S-H4.
**API** — S-M3 (500 on collision), S-M5 (500 on overflow).
**Deployment** — S-H5 is the only one; environment handling, storage root and config validation are
sound.

---

## Priority order

| # | ID | Why this position |
|---|---|---|
| 1 | **S-H1** | Data already exposed to live roles. Fix is an hour and needs no migration. |
| 2 | **S-H2** | The product offers a control that does not work. Cheap, and it is a trust problem. |
| 3 | **S-H3** | Decide before launch: build the scheduler or relabel. Do not ship it as-is. |
| 4 | **S-H4** | Reopens the audit's original finding through a second door. |
| 5 | **S-M1 / S-M2** | Same fix, already written for avatars — lift and reuse. |
| 6 | **S-M4 / S-M5** | Financial and cheap. |
| 7 | **S-M3 / S-M6 / S-M7** | Correctness and data loss. |
| 8 | **S-M9** | Needs care in the opt-out list; do not rush it. |
| 9 | **S-M11 / S-M12** | Accessibility carries regulatory weight in Ontario. |
| 10 | **S-H5** | Largest, and not urgent while one brokerage runs. Make the decision now, do the work later. |
| 11 | LOW band | After launch. |

### Estimated fix time

| Band | Effort |
|---|---|
| High (S-H1, S-H2, S-H4) | ~1 day |
| S-H3 | 2 hours to relabel, or 2–3 days to build |
| Medium | ~3 days |
| S-H5 | 1–2 days, or a recorded decision |
| Low | ~1 day |
| **Pre-launch minimum** (High minus S-H5, plus S-M1/2/4/5) | **~2 days** |

---

## Recommendations

1. **Do the two capability fixes together.** S-H1 and S-H2 are the same disease — a check written as
   a role or a guard instead of as the question being asked. `authz.ts` already exists for this and
   already carries the warning; adding `company.read-banking` and settling `settings.edit` is one
   focused change, not two.
2. **Decide S-H3 this week, not at launch.** The honest relabel is two hours. The scheduler is days.
   The one unacceptable outcome is shipping a screen that promises automatic birthday emails to a
   brokerage that will believe it.
3. **Lift `sniffImage()` out of the Users module.** It was written on 2026-08-03 for avatars and the
   logo has the same hole. A defect fixed in one of two identical places is the pattern this
   codebase keeps repeating — the deletion guard did the same thing yesterday.
4. **Put a uniqueness guard on `next_invoice_no` rather than documenting it.** A warning in the UI
   is not a control; the field is one keystroke from stopping invoicing.
5. **Record the tenancy decision in `docs/`.** Single-brokerage or multi-office — either is
   defensible, and the current state (schema says one thing, every query says another) is the only
   answer that guarantees someone gets it wrong later.
6. **Add the settings tables to the tenancy and orphan-risk tests.** `tenancy.spec.ts` already
   checks that every root table has `company_id`; it does not check that anything *filters* on it.
   That gap is what let S-H5 through.

---

## MODULE STATUS

### NOT PRODUCTION READY — *as assessed before the 2026-08-03 remediation*

> **Superseded in part.** All five High findings were fixed the same day — see **Remediation —
> 2026-08-03**. The Medium and Low bands remain open, so the module is **not yet production ready**,
> but the three blocking defects named below are closed. The original assessment is kept unedited.

**Justification.**

The security perimeter would pass. I could not forge, inject, escalate or mass-assign my way through
this module, session handling is sound, CSRF is enforced everywhere, and the filesystem handling is
better than most. If the question were "can an outsider break in through Settings", the answer is
no.

It is blocked because **three of its controls report success and do not work**, and a brokerage
cannot tell the difference from the screen.

An administrator grants `settings: edit`, watches the permission appear, opens the form, edits it and
presses Save — and gets a 403 telling them they are not an administrator. Another switches on
Birthday emails, sets seven days, saves, and receives a success toast; no birthday email will ever
be sent, and the message they wrote is not the message that would be sent if one were. A CRM
coordinator with no access to a single transaction screen can read the brokerage's operating account
number with one request.

None of these is discovered by the person who configured it. They are discovered by the client who
did not get the email, or by the payment that went to the wrong account.

**S-H1, S-H2 and S-H4 must be fixed before go-live** — together about a day, none requiring a
migration. **S-H3 needs a decision before go-live**, and relabelling is an acceptable answer.
**S-H5 needs a recorded decision, not necessarily code.** The Medium band should be scheduled
immediately after; S-M1, S-M2, S-M4 and S-M5 are each under three hours and two of them reuse code
that already exists in this repository.

Re-audit after the High band. The Medium band alone would not hold up a launch.

---

## Remediation — 2026-08-03

All five High findings addressed. No other module's behaviour changes: verified by the full server
suite (753) and the full browser suite (158), both green.

| ID | What changed | Sensitivity check |
|---|---|---|
| **S-H1** | New capability `company.read-banking` in `authz.ts`, set at `ROLE_RANK.accounting`. The controller asks the capability instead of `isAgent(user)`. | Reverted → the `crm` role receives all six fields again; the test fails. |
| **S-H2** | `PUT /company-settings`, `POST /logo` and `DELETE /logo` move from `AdminGuard` to `@Screen('settings','edit')`. | Reverted → granting `settings: edit` still 403s; the test fails. |
| **S-H3** | Relabelled. "Automatic sending" → "Allow CRM emails"; both screens now state that nothing sends on a schedule; the **Days Before** field is removed. | n/a — a wording change, covered by the client build. |
| **S-H4** | `saveProfile` refuses a name another account holds, active or deactivated. | Reverted → 2 unit tests and 1 browser test fail. |
| **S-H5** | `TENANT_ID` in `core/tenant.ts` records the single-brokerage decision; the four `crm_email_settings` reads and writes that had **no tenant filter at all** now carry one. | Reverted → a second brokerage's row governs this one; 2 tests fail. |

### Why the threshold for S-H1 is `accounting` and not something stricter

`accounting` and `documentation` share rank 60, so one threshold admits both and excludes `crm` (40)
and `agent` (20) — exactly the line the product already draws. Setting it higher would take the
numbers away from the two roles whose job is to produce the documents that print them, which would
have been a second bug introduced while fixing the first.

### What S-H3 does and does not do

**It relabels; it does not build the scheduler.** The switches, the stored values and the API are
untouched, so nothing is lost if the sweep is built later. What changed is that the screens no
longer claim an automation that does not exist:

- "Automatic sending — master switch for the triggers below" → "Allow CRM emails — master switch,
  turn off to block every send below".
- CRM Triggers now says, in bold: *these are sent by hand, not on a schedule*, and names where they
  are sent from.
- The per-trigger "Message" is relabelled **"Note"**, because the wording of the email is fixed in
  `CrmAdvancedEmailService` and the saved string never reaches a recipient.
- **Days Before is removed** rather than disabled. It configured a schedule with nothing behind it;
  leaving it visible-but-inert would still promise the automation. The stored value is untouched and
  still round-trips through the API.

Building the sweep remains the larger option and is a separate decision — it would reach into Leads
(for birthdays and anniversaries) and the mail system, which is outside this module.

### What S-H5 does and does not do

**It records the decision and closes the unscoped reads; it does not make the product multi-tenant.**
`crm_email_settings` was read four times with `findFirst({ orderBy: { id: 'asc' } })` and no tenant
filter — on a second brokerage that returns whichever row has the lowest id and silently governs
both. Those four now filter on `TENANT_ID`, and `core/tenant.ts` states plainly that the product is
single-brokerage today, what is still not done, and what the constant is for.

The `company_settings.id = 1` hardcoding in `CompanySettingsService` and `InvoiceNumberService`
remains. Changing it means resolving the tenant from the session and giving each brokerage its own
invoice counter — that reaches into Invoices and was explicitly out of scope for this remediation.

### One process note

The S-H4 browser test **corrupted the seed data the first time it ran**. Against a build without the
fix the rename succeeds, and a test whose only assertion is "it was refused" left `admin@test.local`
renamed to a working agent's name, with two accounts sharing it for every test that followed. The
test now restores the name in a `finally`. A probe for a guard has to undo the thing it probes for,
for the case where the guard is missing.

Separately, the revert script used for the sensitivity checks **reported "restored" without
restoring** — its empty-string guard made the S-H4 restore a silent no-op. A `grep` for the guard
text caught it before the rebuild. The sensitivity result itself was still valid; the restore was
not, and the fix was re-applied by hand.

---

## Runtime coverage

Everything above marked "measured", "demonstrated" or "confirmed at runtime" came from Playwright
against the running application and a live Postgres database, not from reading code.

| Probe | Coverage |
|---|---|
| Role reachability | 6 roles × 5 endpoints |
| Write authorization | 6 roles × 6 write endpoints |
| Field validation | 16 cases (empty, over-length, unicode, emoji, XSS, SQLi, negative, overflow, mass assignment) |
| Logo | unauthenticated fetch, header inspection, SVG-with-script, non-image-as-PNG |
| Profile form | duplicate name, case-colliding email, role/status/password injection |
| Workflow | two-tab concurrency, double-click, forced-500 failure state |
| UI | 3 roles screenshotted, mobile viewport, label association |
| Database | index and FK inventory, user-deletion orphan probe, invoice-counter collision |

Screenshots: `e2e/audit-shots/settings/`.

**Not covered, and stated rather than implied:** session-timeout mid-edit, server restart mid-save,
database restart, genuine network-failure injection, and load testing at brokerage scale. Those need
a staging environment; this ran against a local single-instance stack.

**Probe hygiene.** All three probe spec files were deleted. Every value the probes wrote to
`company_settings`, `users` and `roles` was restored to its seeded state and verified. The 148-test
browser suite was re-run afterwards to confirm the shared test database was left usable.
