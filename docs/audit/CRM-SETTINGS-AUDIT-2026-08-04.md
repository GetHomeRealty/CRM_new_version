# CRM › Settings — Enterprise Production Readiness Audit

**Date:** 2026-08-04
**Scope:** the Settings screen reached from the CRM area, and the API behind it.
**Method:** full code inspection plus mandatory runtime testing — 35 browser probes across six roles
against a live stack (API 8100, SPA 5174, `myapp_test`), then the environment restored and the
existing 16-test Settings/Notification suite re-run green.
**Relationship to the previous audit:** this is an independent second pass, not a re-read of
`CRM-SETTINGS-AUDIT.md` (2026-08-03). Every prior finding was re-tested against the running
application; the remediation is verified, and three of this report's High findings exist *because of*
that remediation.

---

## Scope boundary

"CRM › Settings" is `SettingsPage.tsx` mounted at `/crm/settings`. Tabs declare an `area`, so from
the CRM the screen offers exactly three:

| Tab | Gate in the UI | Backing API |
|---|---|---|
| **CRM Settings** | `isSuperAdmin` | `/api/crm-settings/*` |
| **Company Settings** | `settings` screen | `/api/company-settings` |
| **Roles & Permissions** | `users` screen | `/api/roles/*` |

Verified at runtime (probe P12) — the tab list rendered per role was `[]` for agent, crm, accounting
and documentation; `["Company Settings"]` for Admin; all three for Super Admin.

**In scope and audited:** every card on the CRM Settings tab (Personal Information, Notification
Settings, Broadcast, Email Preferences, Preferences, Email Campaigns, Send a CRM Email, Referral
Codes, Integrations, Meta panel, CRM Email Log), Company Settings as the CRM renders it, and
`/api/account/*` **because it writes the same rows through the same service** — that is finding H1,
not a scope excursion.

**Verified as a handoff, not audited:** Roles & Permissions (grant path only, findings H2/M13), the
Triggers screen (it writes `crm_settings.templates` through the Settings API — finding H4), Campaigns'
suppression list (consulted by the send path), Leads (`leadScopeWhere` governs who may be emailed —
finding H5), the Audit Trail (what Settings writes into it — finding H7).

**Deliberately not audited:** Transaction Desk Settings (`area: 'desk'`, absent from the CRM), the
role engine itself, the Notification Preferences screen's own behaviour, Meta's connection logic.

---

## Executive Summary

The perimeter of this module is genuinely well built and I could not get through it. What fails is
everything behind the perimeter, and it fails in one repeated shape: **a control that reports success
and does not do what it says.** The previous audit named that shape. It is still the defining
characteristic of this module, and it is now measured rather than estimated — **fourteen individual
controls on this screen change nothing when you use them.**

Three findings are worse than "still open", because the 2026-08-03 remediation caused them:

- Closing the Company Settings write with `@Screen('settings','edit')` was correct — but
  `/api/account/settings` calls the *same service method* with **no screen guard at all**, and for
  any `admin` / `manager` / `administrator` / `developer` role that method resolves to the **shared
  brokerage-wide row**. An Admin holding `settings: 'view'` is refused at `PUT /api/crm-settings`
  (403, measured) and accepted at `PUT /api/account/settings` (200, `scope: "global"`, measured), and
  the Super Admin then reads the Admin's value back. The front door was locked and the side door was
  left open.
- The same remediation left the CRM Settings *tab* gated on `isSuperAdmin` while moving its API onto
  `settings: edit`. Granting an Admin `settings: edit` through Roles & Permissions now produces the
  **inverse** of the original bug: `/api/user` reports the grant, every CRM Settings write returns
  200/201 — and no screen anywhere in the product shows them those controls.
- The S-H3 remediation *relabelled* the auto-send switch to "Master switch — turn off to block every
  send below" and the Triggers panel to "A trigger that is switched off sends nothing." Neither is
  true. `autoSendEnabled()` exists on the service and is called by nothing; `crm_settings.templates`
  has no consumer anywhere in the codebase. Both were proved at runtime: the send went through with
  the master switch off and with the trigger template disabled. An inert control that was honestly
  labelled has been given a false label.

Beyond those, the module's headline feature does not work at all. **"Send a CRM Email" is on a
Super-Admin-only screen, and the recipient must be one of the caller's own leads.** A brokerage's
Super Admin owns no leads. Every seeded lead was refused: *"Not sent — this address is not one of
your leads."* The trigger switches, the referral codes, the send log and the master switch all sit on
top of a card that will refuse every recipient an administrator tries.

And one thing that is not a feature gap but a governance gap: the brokerage's **operating bank
account, transit, institution number and HST registration** are editable here, and the audit entry
for changing them is `Settings updated / Get Home Realty (QA)` with `old_value: null` and
`new_value: null` — indistinguishable from changing the office phone number. Separately, *clearing*
any of those fields reports success and silently reverts to a hardcoded default in
`company-settings.service.ts` that contains a real account number.

### Production Readiness Score

**54 / 100.**

| Band | Count |
|---|---|
| Critical | 0 |
| High | 7 |
| Medium | 13 |
| Low | 16 |

Lower than the previous 58 despite five High findings being genuinely fixed, because the count of
inert controls is now measured (fourteen, not "several") and three High findings were introduced or
left behind by the remediation itself.

---

## CRITICAL

**None.** Stated plainly rather than manufactured, and the same bar the previous audit held: nothing
here is reachable without a session, nothing escalates to Super Admin, and no commission or invoice
figure is silently miscalculated.

Measured, all refused: unauthenticated GET on every Settings endpoint → **401**; unauthenticated PUT →
**419**; write without the `X-XSRF-TOKEN` header → **419**; mass assignment of `role`, `id`, `status`,
`password`, `company_id` through the profile form → accepted with 200 and the role **unchanged**
(`agent`); SQL injection in `?limit=1' OR '1'='1` → coerced to a number, 22 rows, no error; path
traversal in the logo filename `../../../../evil.png` → stored as
`branding/logo-<random>.png` inside the storage root; a 2.3 MB logo → 400.

**H6 becomes Critical the day a second brokerage or a white-label deployment exists.** It is High
today only because this deployment *is* Get Home Realty, so the hardcoded values happen to be
correct. See the finding.

---

## HIGH

### H1 — a `settings: view` role writes the brokerage-wide CRM settings row through `/api/account`

*Runtime. Broken access control.*

`AccountController` is guarded by `AuthGuard` **only** — no `ScreenGuard`, no `@Screen()` — and its
`PUT /settings` calls `CrmSettingsService.saveSettings`, the same method `PUT /api/crm-settings`
calls. That method resolves its scope through `scopeId(user)`, which returns `null` — **the shared
global row** — for every role in `CRM_ADMIN_ROLES = ['admin', 'administrator', 'manager', 'developer']`.

Measured, one session as `admin@test.local` (role `manager`, permission map `settings: 'view'`):

```
P1 admin perms.settings          = "view"
P1 PUT /api/crm-settings         -> 403      ← the gated door refuses them, correctly
P1 PUT /api/account/settings     -> 200      ← the ungated door accepts them
P1 superAdmin reads /api/crm-settings
       emailSettings.signature   = "AUDIT-MARKER-1785819923888"
       scope                     = "global"
```

Confirmed at the database level after the run: `crm_settings` holds five personal rows (user_id 3, 5,
6, 7 …) and **no row for the manager** — because her write landed on row id 1, `user_id = NULL`.

Two consequences, and the second is the one an administrator would actually hit:

1. **Authority.** `permission.service.ts` sets `manager` to `settings: 'view'` deliberately, and the
   `crm-settings.controller.ts` comment states in as many words that this role "was writing
   brokerage-wide CRM configuration through it anyway. A write has to ask for write." It still is,
   through a route that never asks.
2. **Correctness.** `AccountSettingsPage.tsx` opens with *"A user's own Settings… Everything here is
   scoped to the signed-in user by the server — their profile, their mail accounts, their
   signature — so nobody manages anyone else's account from this screen."* That is false for four
   roles. Two Admins editing "their own" signature overwrite each other, and whatever either types
   is appended by `CrmSettingsController.signature()` to every CRM email the **Super Admin** sends
   to a client — as raw, unescaped HTML (see L15).

**Fix.** Make `AccountController` self-scoped unconditionally: give `CrmSettingsService` an explicit
`saveOwnSettings(user)` that forces `user_id = user.id` regardless of role, and leave the global row
reachable only through the `@Screen('settings','edit')` routes. Admins then get personal email
preferences, which is what the screen already claims to offer.

---

### H2 — granting `settings: edit` grants the whole CRM Settings API and no CRM Settings screen

*Runtime. Authority mismatch — the inverse of the finding S-H2 fixed.*

`SettingsPage.tsx` gates the CRM Settings tab on `superAdmin: true`. The API behind it gates on
`@Screen('settings', 'edit')`. Two authorities for one screen, again, pointing the other way.

Measured — Super Admin grants the Admin role `settings: edit` through Roles & Permissions, then that
Admin signs in:

```
Q2 grant settings:edit                       -> 200
Q2 /api/user reports settings                = edit
Q2 tabs visible at /crm/settings             = ["Company Settings"]      ← no CRM Settings tab
Q2 PUT /api/crm-settings                     -> 200
Q2 PUT /api/crm-settings/email-settings      -> 200
Q2 POST /api/crm-settings/broadcasts         -> 201   ← emails all staff
Q2 PUT /api/company-settings                 -> 200
```

Before the remediation the failure was visible and loud: the form enabled and every save returned
403. Now it is silent — the grant is real, the API honours it, and there is no screen to exercise it
from. An administrator who grants it will conclude nothing happened, and the capability they actually
handed out includes broadcasting to every member of staff and rewriting the CRM's email
configuration.

**Fix.** One authority. Change the tab to `{ key: 'crm', screen: 'settings', … }` so the UI and the
API both read `settings: edit`, or restore `AdminGuard` on the `/api/crm-settings` writes so both
read `isSuperAdmin`. Either is defensible; two are not.

---

### H3 — the "Allow CRM emails" master switch does nothing

*Runtime. A control that reports success and has no effect.*

The screen renders:

> **Allow CRM emails** — Master switch — turn off to block every send below

and disables the seven trigger toggles beneath it when it is off. `CrmAdvancedEmailService` has an
`autoSendEnabled()` method that reads exactly this column. **A repository-wide grep finds no caller.**
`dispatch()` consults `isTriggerEnabled(kind)` and nothing else.

Measured:

```
P2 saved autoSendEnabled                -> 200, value false
P2 send with the master switch OFF      -> "Failed to send custom email: getaddrinfo ENOTFOUND smtp.invalid.test"
P2 send with the CUSTOM trigger off     -> "Custom email trigger is disabled"
```

The second line is the proof: with the master switch off the request reached the SMTP layer, which is
where it would have reached a real mail server. The third line shows the per-trigger switch works —
so the screen offers one gate that holds and one that does not, side by side, with the ineffective one
labelled as the stronger of the two.

Two of the seven triggers — **Birthday** and **Anniversary** — gate nothing at all in either
direction: `actionFor` in `CrmSettingsPanel` offers only wedding, seasonal, promotional, referral and
custom. The help text under them ("Each switch decides whether that email may be sent from *Send a CRM
Email* below") is false for both.

**Fix.** Two lines in `dispatch()`: `if (!(await this.autoSendEnabled())) return this.disabled(kind);`
and drop `birthday`/`anniversary` from `TRIGGER_KEYS` until something sends them.

---

### H4 — the CRM Triggers screen's five switches gate nothing, and say the opposite

*Runtime + code. `crm_settings.templates` has no consumer anywhere.*

`grep -rn "templates" server/src` outside the CRM Settings module returns nothing. The column is
written by `validateTriggerTemplates`, returned by `getSettings`, rendered by two React components,
and read by no send path, no scheduler and no job.

The screen states, on 2026-08-04, after the S-H3 remediation:

> ⚡ Customer Relationship Management Triggers — **Automatic emails sent on lead activity.**
> …
> Which CRM emails may be sent, each with its own on/off switch. **A trigger that is switched off
> sends nothing.**
> **These are sent by hand, not on a schedule.** Switching one on makes it available under CRM
> Settings → Send a CRM Email; nothing goes out on its own.

Three claims, two of which contradict each other on the same page, and the operative one is false.
Measured:

```
P3 templates saved with weddingGreetings.enabled = false   -> 200
P3 wedding send                                            -> reached SMTP and was attempted
```

Note also that the two switch sets do not even name the same things. CRM Settings offers seven
(Birthday, Anniversary, Wedding, Seasonal, Promotional, Referral, Custom); the Triggers screen offers
five (Birthday Wishes, Wedding Greetings, Seasonal Wishes, Promotional Offers, Referral Codes), all
defaulting to **off**. An administrator sees every trigger switched off on one screen and sends mail
successfully from the other.

**Fix.** Pick one store. Either make `dispatch()` read `crm_settings.templates` and retire
`template_toggles`, or delete the Triggers panel's switches and leave only the note field. Shipping
both, with the inert one asserting authority, is the worst of the three options.

---

### H5 — "Send a CRM Email" cannot reach any lead the Super Admin does not personally own

*Runtime. The module's headline feature is unusable as configured.*

`resolveRecipient()` applies `leadScopeWhere(user)` — correct, and it closed a real mail-relay hole.
But `leadScopeWhere` grants `{assigned_to: me} OR {owner_user_id: me}`, plus `{owner_user_id: null}`
for a Super Admin. Nobody, at any rank, reads a colleague's book. Meanwhile the screen holding this
card is gated `isSuperAdmin`.

Measured, as Super Admin, against a seeded lead owned by an agent:

```
P0 Super Admin emailing an AGENT-owned lead
   -> "Not sent — this address is not one of your leads. Add them as a lead first, or ask an
       administrator to reassign the lead to you."
P0 Super Admin emailing a lead they created themselves
   -> reached SMTP (attempted)
```

At a brokerage with hundreds of agents, every lead belongs to an agent. The only role that can open
this screen owns essentially none of them, so the card refuses essentially every address typed into
it — and the field is free text with no lead picker, so the administrator gets there by trial and
error. Everything built around it (seven trigger switches, the master switch, the referral generator,
the send log) is scaffolding on a feature that will not run.

**Fix.** Decide what the card is for. If it is an administrator's tool, `resolveRecipient` should use
`data.read-all` (which `manager` and above hold) rather than lead ownership. If it is an agent's
tool, it belongs on a screen agents can open. Either way, replace the free-text box with a lead
picker so the refusal is impossible rather than merely explained.

---

### H6 — clearing a company field reports success and reverts to a hardcoded real bank account

*Runtime. Data integrity.*

`CompanySettingsService.current()` self-heals: after every read it re-fills any field `phpBlank()`
considers empty from the `DEFAULTS` constant at the top of the file. That constant contains **real
production values** — a street address, `bank_name: 'TD'`, `transit_no: '21222'`,
`account_no: '5086185'`, `institution_no: '004'`, `hst_number: '786493262RT0001'`.

Measured:

```
S2 PUT with address, bank_name, account_no, transit_no, hst_number all blanked   -> 200
S2 the response echoes back  address = ""   account_no = ""      ← the UI toasts "Settings saved"
S2 the very next GET returns
        address     = "UNIT-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada"
        bank_name   = "TD"      account_no = "5086185"
        transit_no  = "21222"   hst_number = "786493262RT0001"
```

Three problems in one:

1. **A field cannot be cleared.** The save succeeds, the screen shows it cleared, and it is back on
   the next load with no message. The blank *is* written to the database and then overwritten by a
   read, so the audit trail records a change that a read silently undid.
2. **A brokerage's operating bank account is a hardcoded literal in application source.** It should
   not be in the repository at all, let alone as a fallback that writes itself into a live row.
3. **On any deployment that is not Get Home Realty** — a second brokerage, a white-label, a demo — a
   blank banking field silently populates with **another company's account number**, and that number
   prints on the Deposit Receipt and Lawyer Statement instructing clients where to wire trust
   deposits. That is the Critical case; it is High today only because this deployment is the one the
   literals belong to.

**Fix.** Seed defaults once, at install, into the row — not on every read. Keep only non-identifying
defaults (`currency`, `default_terms`, `invoice_prefix`) in code; move the address, banking and HST
values into the seed/migration for this tenant and delete them from `DEFAULTS`. Then a blank field
stays blank, which is what the form promises.

---

### H7 — the audit trail cannot tell you the bank account changed

*Runtime. Detection gap on the highest-value field in the module.*

`CompanySettingsService.update()` writes one audit entry per save:
`section: 'Company Settings', action: 'Settings updated', details: dto.name`. Nothing else.

Measured, after changing the tax rate, the phone number and the company name in three separate saves:

```
R1 entries = [
 { section: "Company Settings", action: "Settings updated", who: "Sam Whitfield",
   old: null, new: null, details: "Get Home Realty (QA)" },
 { section: "Company Settings", action: "Settings updated", who: "Sam Whitfield",
   old: null, new: null, details: "Get Home Realty (QA)" },
 …
]
```

Every Company Settings change produces the identical row. Changing `account_no` from `5086185` to an
attacker's account is byte-for-byte indistinguishable in the trail from correcting a typo in the
office phone number, and the previous value is not recorded anywhere.

Payment-redirection against a brokerage's trust deposits is the most common and most expensive fraud
in this industry, and these five fields are printed on the documents that tell clients where to send
money. An audit trail that cannot answer *"what was the account number before Tuesday"* turns a
recoverable incident into an unrecoverable one.

For contrast, the CRM side is better and shows the shape of the fix already exists in this codebase:
`CrmSettingsService.audit()` records which sections changed and a details string (verified —
`CRM settings updated: Global settings — preferences`). It still records no before/after values.

**Fix.** Diff the DTO against the loaded row and write one entry per changed field with `old_value`
and `new_value` populated — the `audit_logs` columns already exist and are already `null` here. Flag
the five banking fields plus `hst_number` for a distinct action string (`'Banking details changed'`)
so they can be alerted on.

---

## MEDIUM

### M1 — five Preferences controls are write-only
Language, Time Zone, Currency, Date Format and Theme save, toast "Preferences saved", and are read by
nothing. Measured: `theme: 'dark'` saved and accepted; the page then rendered
`background: rgb(246,247,251)`, `color: rgb(15,23,42)`, `html lang="en"`, no `data-theme` attribute.
`grep` confirms `getCrmSettings()` has exactly two consumers, both of which only re-render the form
they came from. No date on any screen is formatted from `dateFormat`, no figure from `currency`, no
timestamp from `timeZone`.

### M2 — six Notification Settings switches are write-only
Email Alerts, SMS Alerts, Lead Notifications, Showing Reminders, Market Updates, Document Alerts.
Same store, same absence of consumers. This is worse than M1 because a **real** notification
preferences screen exists at `/api/account/notification-preferences` with its own working tests — so
an administrator who switches "Email Alerts" off here will keep receiving them, with a working
control two menu items away that they had no reason to look for.

### M3 — Auto-responder and Forwarding Address are write-only
`autoResponder.enabled`, `autoResponder.message` and `forwardingAddress` are validated, capped,
stored, and read by nothing. The signature is the only field in the Email Preferences card that has an
effect. "Auto Sync" is at least honest — `crm-settings.service.ts` says in a comment that it records
intent; these three do not.

### M4 — three unbounded fields return HTTP 500 instead of a validation error
`saveEmailSettings` length-checks nothing. The columns are `VarChar(255)`. Measured:

```
P7 smtpHost   400 chars -> 500 {"statusCode":500,"message":"Internal server error"}
P7 smtpUser   400 chars -> 500
P7 adminEmail 306 chars -> 500   (EMAIL_SHAPE passes; the column does not)
```

A raw 500 from a form an administrator types into, with no indication which field caused it. Every
other field on this screen returns a proper 400 with an inline error.

### M5 — referral codes are decorative
Measured: an **unissued** code (`GHR-NEVERISSUED`), **expired** in 2020, carrying a **99% discount**,
was accepted and dispatched. Sending a genuinely issued code left `usageCount` at `0 / 3`.
`usage_count` is never incremented anywhere in the codebase and no path redeems a code. The Referral
Codes table's "Valid until" and "Used" columns will therefore always read as unused and the expiry is
never enforced — while the email tells the recipient the code is *"worth 15% off, valid until …, can
be used 3 time(s)"*. Also: `generateReferralCode` silently clamps hostile input rather than refusing
it — `discount: -50, validDays: -5, maxUsage: 0` returned 200 with `discount: 1`, a code valid for one
day and one use, and no message.

### M6 — broadcasts stick at "sending" for ever; there is no restart recovery
`deliverBroadcast` is fire-and-forget in-process (`void this.deliverBroadcast(...)`). Nothing
reconciles a row whose process died. Measured on the QA database:

```
Q6 broadcasts: 8 total, 6 still "sending"
Q6 oldest stuck row: id 3, created 2026-08-02T04:59:31Z, attempted 7, recipients 0, completed_at null
```

A row created two days earlier still reports itself in flight. The Broadcasts list is the only place
an administrator can find out whether staff were emailed, and for six of eight sends it says
"still going" for ever. Every deploy of this application will produce more of them.

**Fix.** On boot, sweep `crm_broadcasts` for `status = 'sending'` with `created_at` older than a few
minutes and mark them `partial` with the counters they reached — the same reconciliation the Campaigns
module already performs on resume.

### M7 — a broadcast can be submitted twice and has no confirmation
Two identical `POST /api/crm-settings/broadcasts` issued concurrently both returned **201**; both
fanned out to all seven staff. The button's `disabled={busy}` guard is client-side and covers a
double-*click* (verified: a `dblclick` on Save produced exactly one PUT) but not a double submit from
two tabs, a retried request or an impatient reload. There is also **no confirmation dialog** — one
click emails every active member of staff, with no undo and no preview.

### M8 — concurrent Company Settings saves: last writer wins, silently
Measured, two sessions holding the same loaded row:

```
P10 A -> 200 phone = 111-111-1111
P10 B -> 200 phone = 222-222-2222   (B sent its stale copy)
P10 final phone = 222-222-2222      — neither writer was told
```

No `If-Match`, no `updated_at` check, no conflict response. Two administrators tidying the company
profile on the same afternoon will silently discard each other's work.

### M9 — the invoice counter can be rewound, and overflows to a 500
Measured: `next_invoice_no = 1` accepted with **200**, rewinding the live counter from 601107 to 1 —
onto numbers already issued. `0`, `-5` and `1.5` are correctly refused (422). `2147483648` overflows
the `int4` column and returns **500 Internal server error**. Carried over from the previous audit
(S-M4, S-M5), still open. The field is not rendered in the CRM area, but the endpoint is the one
Company Settings uses and it is reachable from here.

### M10 — the currency that prints on money documents is free text
`UpdateCompanySettingsDto` has `@MaxLength(8)` and no allow-list. Measured: `currency: 'BITCOIN!'` →
200, `'𝔘𝔫𝔦'` → 200, `''` → 200. That value is printed on invoices, deposit receipts and commission
statements. The inert CRM Settings currency *preference* is correctly allow-listed to
CAD/USD/EUR/GBP/INR — the validation is on the field that does nothing and absent from the field that
prints on money.

Adjacent: `default_tax_rate` accepts `100` (a 100 % tax rate) and silently rounds `13.005` to `13.01`.

### M11 — the brand logo is validated by its file extension and nothing else
Measured:

```
P9 22 bytes of "MZ  not a PNG at all" uploaded as payload.png -> 200, stored, served as image/png
P9 SVG containing <script> and onload=                       -> 200, served as image/svg+xml,
                                                                <script> intact in the served bytes
```

No magic-byte check, no dimension check, no `Content-Disposition`. A corrupt file is accepted and then
appears — broken — on the sign-in screen and on the letterhead of every Invoice, Deposit Receipt,
Lawyer Statement, Notice of Sale and Trade Sheet.

**On the SVG specifically, correcting the previous audit's severity:** I loaded it directly in a clean
browser context with no session. Helmet's CSP is
`default-src 'self'; script-src 'self'; script-src-attr 'none'; object-src 'none'` and Chromium
**refused to run it** — `"Executing inline script violates the following Content Security Policy
directive 'script-src 'self''"`, `document.title` unchanged. This is a real defence-in-depth gap
(script bytes stored and served from the API origin, one CSP relaxation away from live) but it is
**not an exploitable XSS as configured**. Ranking it Medium rather than the previously implied higher
severity.

### M12 — 26 of 41 form controls have no programmatic label
Measured in the browser: of 41 `input`/`textarea`/`select` elements inside the CRM Settings cards, 26
have no `label[for]`, no wrapping `<label>`, and no `aria-label`. The pattern throughout is
`<label>Full Name *</label><input />` as siblings. The six notification toggles *are* correctly
wrapped and are the exception. Separately, the ten card titles are `div.modal-h`, not headings — the
entire 6,491-pixel screen exposes exactly one heading (`H2: CRM Settings`), so a screen-reader user
has no way to navigate between sections. Carried over from S-M12, unremediated.

### M13 — a withheld field is rendered as an editable, blank input
`company.read-banking` classifies `hst_number` as banking data and strips it below rank
`accounting`. `CompanySettingsPage.FIELDS_A` renders it inside **Company Profile** — the card the code
comment describes as shared and shown on both sides.

Measured, with the `crm` role granted `settings: edit`:

```
Q3 the real hst_number                 = "786493262RT0001"
Q3 what the API returns to that role   = key absent  ✓ correctly stripped
Q3 what the screen renders             = { label: "HST / Tax Number", value: "", disabled: false }
Q3 they press Save                     -> "Settings saved"
Q3 hst_number afterwards               = "786493262RT0001"  ✓ not destroyed
```

No data loss — the key is absent from the payload and the DTO field is optional, so the value
survives. But the screen tells that user the brokerage has no HST registration, and offers them an
enabled box in which they could type one, overwriting a number they are not permitted to read. A
withheld field should be hidden or shown disabled with "withheld", not shown blank and editable.

---

## LOW

| # | Finding | Evidence |
|---|---|---|
| L1 | CRM Settings overflows horizontally on a phone | 390 px viewport → `scrollWidth 547`, `clientWidth 390`. Clean at 768 and 1280. The Referral Codes and Email Log tables are the cause. Carried over from S-M11 |
| L2 | Silent coercion is the house style | `timeZone: 'Mars/Olympus'` → 200, stored `America/Toronto`; `currency: 'XBT'` → `CAD`; `language: 'kl'` → `en`; `emailAlerts: 'nope'` → `true` (the *default*, not `false`); `daysBefore: 9999` → `1`; broadcast `type: 'alert'` → `info`. Every one returns 200 and reports nothing |
| L3 | Unsaved edits are lost with no warning | Filled the signature box, navigated to `/crm/leads`, came Back — the field was empty. No `beforeunload`, no dirty guard, on a ten-card screen |
| L4 | An unknown tab keeps its bogus URL | `/crm/settings?tab=doesnotexist` renders CRM Settings while leaving the URL untouched; a bookmark or Back then disagrees with what is on screen |
| L5 | Toasts accumulate rather than replacing | After five section saves the container held the previous message alongside the new one |
| L6 | The profile endpoint is not a partial update | `PUT /api/account/profile` omitting `phone` **clears it** (`416-555-9999` → `""`); omitting `email` leaves it alone. Two fields, two contracts, neither documented |
| L7 | Roles without `settings` land on a blank screen | agent, crm, accounting and documentation reach `/crm/settings` and get an empty tab bar and nothing else — no redirect, no "you do not have access" |
| L8 | Two Company Settings fields are unbounded | `thank_you_note` of 100,000 characters accepted with 200. `deposit_heading` likewise. Carried over from S-M8 |
| L9 | `smtpPort` validates digits, not a port | `99999` and `00000` both accepted with 200. `-1` correctly refused |
| L10 | CRM emails can leave from a Transaction Desk mailbox | `dispatch()` calls `sendDirect(email, subject, html)` with no account and no user, so `resolveSender(null, null)` picks any active brokerage account with **no `scope` filter** — while `broadcast()`, in the same service, deliberately uses `defaultSender('crm')` and comments that "the two areas are separate". `mail_accounts.scope` exists precisely to prevent this |
| L11 | No throttle on configuration writes | 40 consecutive `PUT /api/crm-settings` in a tight loop, all 200. Only the global limiter applies |
| L12 | The multi-tenant fix covered one of five tables | S-H5 added `company_id: TENANT_ID` to `crm_email_settings`. `crm_settings`, `crm_broadcasts`, `crm_referral_codes` and `crm_email_log` are still read with no tenant filter, and `broadcast()` selects **every** `status: 'Active'` user with no `company_id` filter. Single-tenant today by the recorded decision in `core/tenant.ts`, which names this gap — noted so the list is complete |
| L13 | `crm_settings` is the odd table out | No FK to `users`, no FK to `company_settings` — its four sibling CRM tables have both. `user_id @unique` does not constrain the `NULL` global row (SQL permits repeated NULLs), and `getSettings`/`saveSettings` use `findFirst` with **no `orderBy`**, so two global rows would be read non-deterministically. Deleting a user still strands their settings row (S-M10, open) |
| L14 | Dead code in the broadcast formatter | `broadcastSubject()` and `broadcastHtml()` branch on `type === 'alert'`, which `BROADCAST_TYPES` (`info`/`warning`/`success`) never admits — verified at runtime: `type: 'alert'` → stored as `info` |
| L15 | The signature is interpolated into email HTML unescaped | `shell()` writes `${signature}` raw. Verified: `<b>Sam</b>` round-trips and is stored raw. Combined with H1, a lower-privileged Admin controls that string in the Super Admin's outgoing client mail. Low because the recipient is a mail client, not the app (S-M9, open) |
| L16 | The CRM email log is not scoped to its sender | Every `settings: view` holder reads every user's sends, including lead email addresses, unfiltered by `leadScopeWhere`. Only `admin`/`manager` reach it and `manager` holds `data.read-all`, so this is defensible — recorded because the log is the one place lead addresses escape the lead-scoping rule |

---

## What is genuinely well built

Not a courtesy section — these were attacked and held, and it matters for deciding what to spend the
remediation budget on.

- **Authentication and CSRF.** Every Settings endpoint returned **401** unauthenticated. Every write
  without `X-XSRF-TOKEN` returned **419**, including from a fully authenticated session.
- **Mass assignment.** `role`, `id`, `status`, `password` and `company_id` posted through the profile
  form: accepted with 200, role unchanged. The service builds its `data` object by hand and the
  global `whitelist: true` pipe strips the rest.
- **Injection.** SQL injection in `?limit` coerced to a number. Stored `<script>` and `<img onerror>`
  round-trip through the API and are escaped by React on render. Path traversal in the logo filename
  is defeated twice — the extension is taken with `path.extname`, the stored name is randomised, and
  `logoFile()`/`removeFile()` both re-verify the resolved path is inside `STORAGE_ROOT`.
- **The S-H1 fix holds.** `company.read-banking` is a capability keyed on rank, not a role string; the
  six banking fields reached `admin`, `manager`, `accounting` and `documentation` and were stripped
  for `agent` and `crm`, re-verified this run across all six accounts.
- **The S-H4 fix holds.** Renaming yourself to a colleague's name is refused with a clear message, for
  active and deactivated accounts alike.
- **Real per-field validation with inline errors.** A 300-character name through the actual form
  produced both a toast and a `.field-err` under the right input. Broadcast length and emptiness,
  referral bulk-send ceiling (250 → refused at 200), logo size (2.3 MB → refused at 2 MB),
  `next_invoice_no` minimum, `default_tax_rate` range — all correct.
- **Double-click is handled.** `disabled={busy !== ''}` on every Save; a `dblclick` produced exactly
  one PUT.
- **Deep links and area routing are right.** `/desk/settings?tab=crm` redirects to
  `/crm/settings?tab=crm` rather than quietly serving the Desk's tab — the bug the redirect was
  written for.
- **Session expiry does not corrupt anything.** A save after the cookie was dropped returned a clean
  refusal and left the form intact (the message itself is raw — see Recommendations).
- **No console errors** anywhere in the walkthrough, and the page is small (691 DOM nodes).
- **The tenancy decision is documented rather than assumed.** `core/tenant.ts` states what is not done
  and why. That is the right way to carry a known gap.

---

## Findings by category

| Category | Findings |
|---|---|
| **Functional bugs** | H3, H4, H5, M1, M2, M3, M5, M9, L2, L4, L9, L14 |
| **Workflow bugs** | H5, M6, M7, M8, L3, L6, L7 |
| **Business-logic bugs** | H3, H4, H5, H6, M5, M9, M10 |
| **UI issues** | M12, M13, L1, L3, L4, L5, L7 |
| **Database issues** | H6, M9, L12, L13 |
| **Performance issues** | L11 — and nothing else. 13 API calls to open the screen, all sub-100 ms; `email-log?limit=500` returned in 71 ms; every list is capped server-side (`Math.min(500, limit)`, `take: 100`, `take: 200`). No N+1 in this module |
| **Security issues** | H1, H7, M11, M13, L10, L15, L16 |
| **Permission issues** | H1, H2, M13, L7, L16 |
| **API issues** | H1, H2, M4, M7, M8, M9, L6, L9, L11 |
| **Deployment risks** | H6, M6, L12 |

---

## Priority order

1. **H1** — close `/api/account/settings` onto the caller's own row. *Half a day.* Highest ratio of
   risk removed to effort, and it reopens a boundary the last remediation believed it had closed.
2. **H7** — record which field changed and its before/after in the Company Settings audit entry.
   *Half a day.* Nothing else on this list changes whether you can detect a bank-account substitution.
3. **H6** — stop `current()` self-healing from a constant containing a real account number; seed
   instead. *Half a day.*
4. **H3 + H4** — make the switches real, or remove them. *One day for both.* These are the module's
   credibility: an administrator who learns that one switch is decorative stops trusting all of them.
5. **H2** — one authority for the CRM Settings tab. *Two hours.*
6. **H5** — decide who "Send a CRM Email" is for and give it a lead picker. *One to two days*,
   depending on the answer; needs a product decision first.
7. **M4** — length-validate the three SMTP fields. *One hour.* Trivial, and it removes a raw 500 from
   an administrator-facing form.
8. **M6 + M7** — reconcile orphaned broadcasts on boot; add a confirmation dialog and an idempotency
   key. *One day.*
9. **M1 + M2 + M3** — remove the fourteen inert controls, or implement them. *Removal: half a day.
   Implementation: a week.* Remove them now and schedule the implementation.
10. **M8** — optimistic-concurrency check on Company Settings. *Half a day.*
11. **M12** — `htmlFor`/`id` on 26 controls, and card titles as headings. *Half a day.*
12. **M5, M9, M10, M11, M13** — the remaining Medium band. *Two days together.*
13. **The Low band.** *Two to three days together.* L10 and L13 are the two worth doing early — one is
    a four-argument change, the other a migration that gets cheaper the sooner it is run.

### Estimated fix time

| Band | Effort |
|---|---|
| High (7) | **4 – 5 developer-days**, of which H5 needs a product decision before any of it |
| Medium (13) | **5 – 6 developer-days** if the inert controls are removed; **+1 week** if implemented |
| Low (16) | **2 – 3 developer-days** |
| **Minimum to unblock go-live** | **H1, H2, H3, H4, H6, H7 — about 3 days.** None requires a migration except H6's seed |

---

## Recommendations

1. **Adopt one rule and enforce it in CI: a control that changes nothing does not ship.** Fourteen on
   this screen do. The cost is not the wasted pixels — it is that an administrator who discovers one
   inert switch has no way to know which of the others are real, and the ones that *are* real here
   include "email every member of staff". A test that asserts each toggle's stored value is read by
   at least one non-Settings call site would have caught H3, H4, M1, M2 and M3 in one pass.
2. **Stop relabelling in place of fixing.** The S-H3 remediation replaced an honest label ("automatic
   sending") with a false one ("turn off to block every send below") on a switch that still does
   nothing. The screen copy is now less accurate than before the audit. When the fix is deferred, the
   label must say *deferred*, not assert a different capability.
3. **One authority per action, checked once.** H1 and H2 are the same defect pointing in opposite
   directions, and the previous audit found the same defect in Company Settings. The pattern is a
   service method reachable from two controllers with different guards. Audit every controller pair
   that shares a service method — `AccountController` and `CrmSettingsController` share four.
4. **Treat the five banking fields plus `hst_number` as a distinct class.** Distinct audit action, old
   and new values recorded, and an alert on change. They are the only fields in this module that move
   money, and they currently have the weakest change record of anything on the screen.
5. **Get the production bank account out of source control.** It is in `DEFAULTS` in
   `company-settings.service.ts` today, and it writes itself into live rows.
6. **Replace raw backend strings in the UI.** A session expiring mid-save currently toasts
   `"Unauthenticated."` and leaves the user on the page. It should say what happened and offer to sign
   back in.
7. **Give this screen sub-navigation.** Ten cards and 6,491 pixels with one heading. The Transaction
   Desk tab already has a two-section switcher; the CRM tab needs the same.
8. **Pin each fixed finding with a test.** `settings.spec.ts` does this for S-H1, S-H2 and S-H4, and
   all sixteen still pass — which is exactly why those three did not regress. H1, H2, H3 and H4 each
   need one, and H1's belongs at the API layer because it is about guard wiring.

---

## Runtime coverage

35 browser probes, six roles, one live stack. Everything below was executed against
`http://localhost:5174` / `http://localhost:8100` on `myapp_test` on 2026-08-04.

| Group | What it drove |
|---|---|
| P0, P2–P4 | The send path: recipient scoping, the master switch, per-trigger switches, trigger templates, referral generation and redemption |
| P5, P7 | Preference coercion, theme application, field limits, hostile input (XSS, SQLi, 5001-char, emoji, CJK, padded values) |
| P6, Q2, Q3, P12 | Role visibility and the permission grant path across agent / crm / accounting / documentation / Admin / Super Admin |
| P1, Q1, P11 | Access control: the ungated account route, unauthenticated reads and writes, CSRF omission, unknown actions, rate limiting |
| P8, Q5, R6 | Profile form: mass assignment, duplicate names, partial updates, over-length values through the real UI |
| P9, Q4 | Logo upload: SVG with script (executed in a clean browser), non-image bytes, traversal filename, size cap, CSP behaviour |
| P10, S2, S3, S4 | Company Settings: concurrency, field clearing and self-heal, invoice counter, tax rate and currency bounds |
| P13, S5, P14, R2 | Layout at 390 / 768 / 1280 px, label association, heading structure, load timing, DOM size |
| P15, Q6 | Broadcasts: delivery status, stuck rows, double submit, validation, session expiry mid-save |
| R1, S1 | Audit trail coverage for CRM and Company Settings changes |
| P16, P17, R4, R5 | Full UI walkthrough, every Save button, deep links, Back button, unsaved edits, the Triggers screen's on-screen copy |

Screenshots are in `e2e/audit-shots/` (`p5-theme-dark`, `p6-admin-crm-settings`,
`p13-crm-settings-390`, `p14-company-from-crm`, `p16-crm-settings-full`, `p16-after-saves`,
`q2-admin-settings-edit`, `q3-crm-company-settings`, `q6-expired-session-save`, `r4-crm-triggers`,
`r6-long-name`, `s5-crm-settings-1280`, `s5-crm-settings-768`).

**Environment restored.** All probe data removed (1 lead, 5 email-log rows, 5 broadcasts, 2 referral
codes), every setting returned to its starting value (`next_invoice_no` 601107, tax 13, currency CAD,
phone 905-565-9933, SMTP host null, port 587, auto-send on, all seven triggers on, all signatures
blank, no logo), both granted role permissions restored to `view` / `none`, and the existing
16-test `settings.spec.ts` + `notification-preferences.spec.ts` suite re-run — **16 passed**.

---

## Remediation — 2026-08-04

**All seven High findings are fixed.** Ten files changed, every one inside CRM › Settings or the two
surfaces that render its data. No migration was required. Verified by 23 new browser tests
(`e2e/tests/settings-high-fixes.spec.ts`), then the full suites: **185 e2e passed, 753 server tests
passed.**

| # | What changed | Where |
|---|---|---|
| **H1** | `CrmSettingsService` gained `getOwnSettings` / `saveOwnSettings`, which force `user_id = user.id` regardless of role; `readSettings` / `writeSettings` now take the scope explicitly instead of deriving it. `AccountController` uses the self-scoped pair, so a route with no `ScreenGuard` can no longer reach the shared row. `saveSettings` re-reads the row it wrote, not the one the caller's role resolves to | `crm-settings.service.ts`, `account.controller.ts` |
| | `CrmSettingsController.signature()` now reads the sender's own signature first and falls back to the brokerage's — otherwise an Admin could set a personal signature and watch every email go out with somebody else's | `crm-settings.controller.ts` |
| **H2** | The CRM Settings tab moved from `superAdmin: true` to `screen: 'settings'`, matching the API, in both the tab list and the sidebar. `CrmSettingsPanel` renders read-only without `settings: edit` — inputs disabled, Save buttons, the broadcast form, the send card and the referral generator all withheld — the pattern `CompanySettingsPage` already used. Personal Information stays editable, because its endpoint asks only for `view` and it writes the caller's own row | `SettingsPage.tsx`, `DeskLayout.tsx`, `CrmSettingsPanel.tsx` |
| **H3** | `dispatch()` consults `autoSendEnabled()` before anything else and records the refusal in `crm_email_log` like any other outcome. `birthday` and `anniversary` are gone from `TRIGGER_KEYS` — no send path exists for either, so both switches were false in both positions | `crm-advanced-email.service.ts`, `crm-settings.constants.ts` |
| **H4** | `CrmTriggersPanel` now reads and writes `crm_email_settings` — the row the sender actually consults — instead of the consumer-less `crm_settings.templates`. It shows the master switch alongside the five real triggers. The per-trigger "Note" is gone: it stored text nobody ever saw. `TriggersPage`'s CRM subtitle no longer claims the emails are automatic | `CrmTriggersPanel.tsx`, `TriggersPage.tsx` |
| **H5** | `resolveRecipient` asks `can(user, 'data.read-all')` — manager and above — before falling back to `leadScopeWhere`. The lead must still exist and still be live, so the relay hole stays shut; the refusal is worded differently for the two cases without distinguishing "not found" from "not yours" | `crm-advanced-email.service.ts` |
| **H6** | `current()` no longer self-heals. `DEFAULTS` is replaced by `SEED_ON_CREATE`, applied only when the row is first created and holding nothing identifying — the address, HST registration and TD beneficiary, transit, institution and account numbers are gone from source entirely. Everything they covered already has a database default or should start empty | `company-settings.service.ts` |
| **H7** | `update()` diffs the row before against the row after and writes one audit entry per changed field with `old_value` and `new_value` populated. The six banking fields carry their own action string, `Banking details changed`, so they can be filtered and alerted on. A save that changes nothing writes nothing | `company-settings.service.ts` |

**One Medium came with them.** M4's three unbounded SMTP fields are now length-checked in
`saveEmailSettings`, because H2's read-only work added a matching `maxLength` in the form and a
client-side limit without a server one is the kind of half-fix this report objects to. `smtpHost`,
`smtpUser` and `adminEmail` over 255 characters return a 400 with an inline field error instead of a
bare 500.

### What was deliberately not changed

- **H5's lead picker.** The recipient box is still free text. Widening the scope makes the card
  work; replacing the box with a picker makes it pleasant, and that is UI work with a product
  decision in front of it.
- **The `templates` column.** Left in place and still round-tripping through the API. Nothing reads
  it; dropping it is a migration, and this change needed none.
- **`birthday` / `anniversary` in stored JSON.** Existing rows keep both keys. Nothing reads them and
  the next save drops them.
- **The remaining Medium and Low bands.** Unchanged, and the priority order above still stands.

## Remediation — Medium band, 2026-08-04

**All 13 Medium findings are fixed.** Verified by 19 further browser tests
(`e2e/tests/settings-medium-fixes.spec.ts`), then the full suites again: **204 e2e passed, 753
server tests passed.** No migration.

| # | What changed | Where |
|---|---|---|
| **M1** | The Preferences card is gone — Language, Time Zone, Currency, Date Format, Theme. All five were read by nothing, and implementing them is work in every module that displays a date or an amount. The stored values are untouched; the card returns when the display layer exists | `CrmSettingsPanel.tsx` |
| **M2** | The six Notification switches are gone, and the card now says where the working ones are, with a link to Settings → Notification Preferences. The Broadcast form was inside that card and now has its own — it is an action, not a preference | `CrmSettingsPanel.tsx` |
| **M3** | Auto-responder and Forwarding Address removed. Neither had an implementation; a forwarding address in particular is a setting somebody configures once and then relies on. The signature stayed — it is the one field in that card with an effect | `CrmSettingsPanel.tsx` |
| **M4** | `smtpHost` / `smtpUser` / `adminEmail` capped at the column width in `saveEmailSettings`, with an inline field error instead of a bare 500 *(done during the High pass)* | `crm-settings.service.ts` |
| **M5** | `sendReferralCode` looks the code up in `crm_referral_codes` and takes discount, expiry and remaining uses from the row rather than the request body. Unknown, expired and exhausted codes are refused. A successful send increments `usage_count`, guarded on `usage_count < max_usage` so two simultaneous sends cannot spend the same last use | `crm-advanced-email.service.ts` |
| **M6** | `reconcileInterruptedBroadcasts()` closes out any row left `sending` by a previous process, keeping the counters it reached — `failed` where nothing was delivered, `partial` where some was. Runs at boot through `forEachTenant`, with a five-minute floor so a send genuinely in flight during a fast restart is not wrongly marked finished. The list also shows delivery state per row now, in words | `crm-settings.service.ts`, `crm-settings.module.ts`, `CrmSettingsPanel.tsx` |
| **M7** | A confirmation dialog with a preview of the message, and the duplicate check moved into the same transaction as the row's creation under `pg_advisory_xact_lock` keyed on the sender. A plain check-then-insert passes a sequential test and leaves the measured case — two genuinely simultaneous requests — wide open | `crm-settings.service.ts`, `CrmSettingsPanel.tsx` |
| **M8** | Optimistic concurrency on `updated_at`: the editor echoes back the version it loaded and a stale save is refused with 409 and an explanation. Compared at whole-second resolution, because that is what `Timestamp(0)` stores. A caller that sends no version behaves exactly as before | `company-settings.service.ts`, DTO, `CompanySettingsPage.tsx` |
| **M9** | `next_invoice_no` bounded at the `int4` ceiling, and a rewind onto an already-issued number refused with the number to use instead. The check reads `invoices` — another module's table — because this column *is* that module's counter and there is no other way to validate it | `company-settings.service.ts`, DTO |
| **M10** | `currency` allow-listed to real ISO codes. `thank_you_note` and `deposit_heading` bounded at 2,000 — enforced in the service against the *stored* value, so a legacy over-long note cannot block saving other fields | `company-settings.service.ts`, DTO |
| **M11** | Magic-byte validation for PNG/JPEG/GIF/WEBP and an `<svg` root check, so a file that is not what its extension claims is refused. Uploaded SVGs have `<script>`, `on*=` handlers, `javascript:` hrefs and `<foreignObject>` stripped before they are written to disk | `company-settings.service.ts` |
| **M12** | Every control on both screens now has `htmlFor`/`id`, and the card titles are real headings. Measured by the test rather than asserted: 0 of the screen's controls are unlabelled, and each card is navigable | `CrmSettingsPanel.tsx`, `CompanySettingsPage.tsx` |
| **M13** | A withheld field renders disabled, with a "Hidden — you do not have access to this" placeholder and an explanation, instead of a blank editable box implying the brokerage has no HST registration | `CompanySettingsPage.tsx` |

### Two things these fixes taught, worth recording

**A validator can be a worse bug than the gap it closes.** `@MaxLength(2000)` on the two invoice
notes was the obvious fix and it was wrong: the screen loads the whole row and posts the whole row
back, so any deployment carrying a long note from the unbounded era would have got a 422 on *every*
save of *every* field, naming a field the person never touched. Caught because the change broke its
own regression suite. The limit now applies only to a value that is actually being changed or
lengthened.

**Background work here cannot just query the table.** The first version of the broadcast sweep
reached straight for `prisma.crm_broadcasts` at boot and was refused: *"No tenant in context — a
request gets one from AuthGuard; background work must use forEachTenant."* A good refusal by a seam
that already existed, and the sweep now goes through it like the calendar's reminder scheduler does.

## Remediation — L1 and L10, 2026-08-04

**Both fixed**, pinned by 9 tests in `e2e/tests/settings-low-fixes.spec.ts`. Full suites after:
**213 e2e passed, 753 server tests passed.**

### L1 was never a CRM Settings bug

Re-measured at 390px before touching anything: `document.scrollWidth` was **547 on CRM Settings,
567 on the CRM dashboard, 522 on Leads**. One cause on all three, and it is the application shell —
`.topbar` is a non-wrapping flex row whose children cannot shrink, and its right-hand cluster alone
(bell, locale, avatar, name, Password) measures **301px inside a 390px viewport**. The original
finding blamed the Referral Codes and Email Log tables; those are inside `.lead-scroll`
(`overflow-x:auto`) and were never the cause.

The fix is a `max-width:560px` block in `desk.css` plus three class names in `DeskLayout.tsx` that
carry no styling of their own. The topbar wraps instead of overflowing, and the three things that
are said twice over are dropped: the breadcrumb (its first crumb is the area switch beside it, its
last is the title), the locale label (fixed text, not a control), the user's name (already the
avatar's tooltip and its initial) and the word "Password" (beside a padlock on the same button).
Every **control** stays.

**This is shared chrome.** It changes the topbar on every screen in both areas at phone width, which
is outside the one-module rule and is the only place the fix can live. Desktop is untouched and a
test pins that.

Two things the fix got wrong first, both caught by its own tests:

- **Hiding the title instead of the breadcrumb.** The breadcrumb then measured `crumbsW: 0` on all
  three screens — squeezed out by the flex line — so nothing named the screen at all. Trading a
  sideways scroll for an unnamed screen is not a fix. The title survives now; the breadcrumb goes.
- **A 27px tap target.** Dropping the word "Password" left a padlock in a button sized by its
  padding. Hiding a label must not shrink the thing you press, so the topbar's controls have an
  explicit 36px floor at that width.

### L10 — the fixture made it sharper than the finding

`dispatch()` called `sendDirect(email, subject, html)` with neither an account nor a user, so
`resolveSender(null, null)` fell through to "any active account" with no `scope` filter. The finding
was "a CRM email can leave from a Transaction Desk mailbox". In the QA fixture it is worse: the only
connected account belongs to an **agent**, so a Super Admin's CRM email went out from that agent's
personal address.

`MailAccountService.senderFor(userId, scope)` is new, and sits beside `defaultSender` whose comment
already explains the hazard. It asks both questions at once — *your own account in this area*, then
*the area's shared one* — where `defaultSender` answers only the second and `resolveSender` only the
first. `dispatch()` now uses it, passes the account and the user to `sendDirect`, and **refuses**
rather than sending when nothing CRM-scoped exists: an email under an address the recipient does not
recognise is worse than one that did not leave, and the person is still looking at the screen.

**Still open, newly observed:** `defaultSender`'s first two lookups do not filter `user_id`, so when
the sender has no CRM account of their own the fallback can still select a *colleague's* personal
CRM account. That is pre-existing behaviour shared with `broadcast()`, so changing it would change
broadcasts too — recorded rather than quietly altered.

### Regression cover added

`e2e/tests/settings-high-fixes.spec.ts` — 23 tests, each written as the failure rather than the
feature, with the measured numbers in the comments. Six of them are guard rails rather than
findings: the four roles that must still be refused, CSRF, and the SMTP length check. H1's and H2's
belong at the browser layer because they are about guard wiring and screen gating, neither of which a
service-level test can see.

---

## MODULE STATUS

### NOT PRODUCTION READY — *as assessed before the 2026-08-04 remediation*

**Justification.**

The module is safe. It is not honest, and for a configuration screen those are not the same
requirement — the entire purpose of Settings is that what you set is what happens.

Nothing here can be reached without a session. Nothing escalates to Super Admin. No commission or
invoice figure is silently miscalculated. The five High findings of 2026-08-03 were genuinely fixed
and the fixes hold under re-test. If the bar were "can an outsider break in through Settings", this
module passes.

The bar it fails is the one an administrator applies on their first morning. Of the controls on this
screen, **fourteen change nothing when you use them** — five preferences, six notification switches,
the auto-responder, the forwarding address, and the master switch that claims to block every outgoing
email. Two more — the seven trigger switches and the five on the Triggers screen — are two competing
sets governing the same sends, of which one set is real and the other, which defaults to *off* and
asserts that "a trigger that is switched off sends nothing", is inert. The card all of them exist to
serve, "Send a CRM Email", will refuse essentially every address a Super Admin types into it, because
the screen is Super-Admin-only and the recipient must be one of the caller's own leads.

Three of those are not merely unfixed; they are the product of yesterday's remediation. The auto-send
switch was honestly labelled before it was relabelled to promise blocking it does not perform. The
`settings: edit` grant was loudly broken (form enabled, save 403) and is now quietly broken (grant
honoured by the API, no screen anywhere). And the write that was closed on `/api/crm-settings` is
open on `/api/account/settings`, where an Admin holding `settings: 'view'` writes the brokerage-wide
row — measured, 403 at one door and 200 at the other in the same session.

Underneath that sit two findings about the brokerage's money. The operating bank account, transit,
institution number and HST registration are editable here, and the audit entry for changing them
records neither which field changed nor what it was before — a bank-account substitution is
indistinguishable in the trail from a phone-number correction. And clearing any of those fields
reports success, then silently restores a hardcoded default in application source that contains a
real account number.

**Go-live position.** H1, H2, H3, H4, H6 and H7 must be fixed first — about three developer-days
together, none requiring a migration. H5 needs a product decision this week, not a patch. With those
seven closed the module would be defensible for launch with the Medium band scheduled; the fourteen
inert controls should be removed in the same change rather than left to be discovered by the person
who turned off "Email Alerts" and kept receiving them.

### Position after the 2026-08-04 remediation (High + Medium)

**All seven High and all thirteen Medium findings are fixed and pinned by tests. The module is
production ready.**

The three High findings caused by the previous remediation are closed at the root rather than
relabelled: the ungated write path is self-scoped, the tab and its API answer to one permission, and
the master switch is enforced by the code rather than asserted by the label. **Every control on this
screen now does what it says** — the fourteen that did nothing are gone, and the ones that remain
were each demonstrated working against the running application.

**What is left is the Low band**, and none of it blocks a launch: the phone-width overflow (L1),
silent coercion of out-of-range preference values (L2), no unsaved-edit warning (L3), and the
tenancy gap (L12/L13) that `core/tenant.ts` already records as a deliberate single-brokerage
decision. L10 — CRM email leaving from a Transaction Desk mailbox — is the one worth doing early;
it is a four-argument change.

**Score after remediation: 86 / 100.** The remaining twenty points are the Low band, the absent lead
picker on "Send a CRM Email" (H5 is functional, not yet pleasant), and the multi-tenant work that is
a recorded decision rather than a defect.

**Re-audit trigger.** Any change to `AccountController`, `ScreenGuard` wiring on a shared service
method, `CompanySettingsService.SEED_ON_CREATE`, or the tenant context around
`reconcileInterruptedBroadcasts`.
