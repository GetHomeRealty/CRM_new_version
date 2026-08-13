# CRM › Triggers — Enterprise Production Readiness Audit

**Date:** 2026-08-04
**Scope:** the Triggers screen reached from the CRM area, and the API and send-gate behind it.
**Method:** full code inspection plus mandatory runtime testing — 11 probe groups across six roles
against a live stack (API 8100, SPA 5174, `myapp_test`), then all probe data removed and the
database restored.

**Disclosure.** `CrmTriggersPanel.tsx` was rewritten by me earlier today, as the fix for finding H4
of the CRM › Settings audit. It has been audited here adversarially rather than trusted, and **two
of the four High findings below are defects that rewrite introduced.** They are marked as such.

---

## Scope boundary

"CRM › Triggers" is `/crm/triggers` → `TriggersPage.tsx` → `CrmTriggersPanel.tsx`. It is a single
card holding six switches — one master and five per-email triggers — backed by one API pair and one
database row.

| Surface | What it is |
|---|---|
| `TriggersPage.tsx` | Area wrapper. Renders the CRM panel in the CRM, the Desk panel in the Desk. |
| `CrmTriggersPanel.tsx` | The six switches and the Save button. |
| `GET/PUT /api/crm-settings/email-settings` | The only endpoints this screen calls. |
| `crm_email_settings` (one row) | `auto_send_enabled` + `template_toggles` JSON. |
| `CrmAdvancedEmailService.isTriggerEnabled` / `autoSendEnabled` | What the switches actually gate. |

**Verified as a handoff, not audited:** CRM Settings → Email Campaigns (edits the *same row* —
finding T-H2), CRM Settings → Send a CRM Email (where the triggers take effect — T2 below),
`crm_email_log` (the evidence trail — T-H4), the Transaction Desk's own Triggers panel (checked only
for area isolation), Roles & Permissions (the grant path — T-H1).

**Deliberately not audited:** the Desk trigger automations themselves, the Leads recipient rule, the
Campaigns suppression list, `workflows/` (transaction edit and delete requests — unrelated despite
the name).

---

## Executive Summary

**The switches work.** That is the headline, and it is worth stating first because it was not true
this morning: a trigger switched off now refuses the send, the master switch refuses every send, and
both were demonstrated against the running application. The gate itself is sound.

Everything around the gate is not. Four problems stand out, and three of them share a shape — **this
screen writes more than it shows, and refuses more quietly than it should.**

- **The product offers this screen to every role and it works for two of them.** Agent, Accounting,
  Documentation and CRM all see "Triggers" in the sidebar, all reach the page, and all get an empty
  card reading *"CRM triggers are unavailable"* over a red *"You don't have permission to perform
  this action"*. The route asks for the `triggers` permission, which everyone has; the panel behind
  it asks for `settings`, which four roles do not. Two authorities for one screen.
- **Saving a trigger silently reverts SMTP settings changed elsewhere.** The panel posts back the
  whole row it loaded, including four fields it never displays. Measured: an administrator changed
  the SMTP host on CRM Settings; someone with the Triggers screen already open flipped one switch,
  pressed Save, and the SMTP host went back to its old value with nobody told.
- **An empty request turns every trigger back on.** `PUT {}` returned **200** and took a fully
  configured state — SMTP set, master switch off, all five triggers off — back to master on, all five
  triggers on, SMTP cleared. A malformed `emailTemplates` does the same, silently.
- **A trigger-blocked send leaves no trace.** Nine master-switch refusals are in `crm_email_log`;
  trigger refusals number **zero**. The one control an administrator uses to say "do not send this"
  is the one whose refusals cannot be proved afterwards, which under CASL is most of the value of
  refusing.

None of it is exploitable. The perimeter held everything: unauthenticated reads 401, writes 419,
CSRF enforced, mass assignment of `id`/`company_id`/`updated_by` ignored, SQL injection stored as a
literal, a 5,000-key payload dropped without complaint.

### Production Readiness Score

**62 / 100.**

| Band | Count |
|---|---|
| Critical | 0 |
| High | 4 |
| Medium | 9 |
| Low | 7 |

---

## CRITICAL

**None.** Stated plainly rather than manufactured. Nothing here is reachable without a session,
nothing escalates privilege, and no financial figure is touched by this screen. The worst outcomes
are an email sent that should not have been, and a colleague's configuration silently reverted.

---

## HIGH

### T-H1 — the screen is offered to every role and works for two

*Runtime. Permission / UX.* **Pre-existing, not introduced today.**

The route is `{ screen: 'triggers' }` and the sidebar entry is `can('triggers', 'view')`. Every role
holds `triggers: view` by default — `compiledDefaults` gives `fill('view')` to agent, accounting,
documentation and crm, and `fill('edit')` to admin and manager. The panel behind it calls
`GET /api/crm-settings/email-settings`, which is `@Screen('settings', 'view')` — and those same four
roles hold `settings: none`.

Measured, all six accounts:

```
role        triggers  settings  nav  toggles  Save  GET  PUT
superAdmin  edit      edit       1      6      yes  200  200
admin       edit      view       1      6      no   200  403   ← read-only, correct
agent       view      none       1      0      no   403  403
accounting  view      none       1      0      no   403  403
docs        view      none       1      0      no   403  403
crm         view      none       1      0      no   403  403
```

What an agent sees is in `e2e/audit-shots/trg-agent.png`: the Triggers item highlighted in the
sidebar, the page header rendered, an empty card reading **"CRM triggers are unavailable."**, and a
red toast **"You don't have permission to perform this action."** They were invited to a screen that
then refused them.

Note the Admin row is *correct* — `settings: view` produces a genuinely read-only screen with the
switches visible and no Save button. The mechanism works; it is the `triggers` permission that is
not connected to anything.

**Fix.** One authority. Either gate the sidebar entry and route on `settings` (matching the API), or
give the `triggers` permission meaning by having the endpoints ask for it. The first is a two-line
change; the second is the better long-term answer because a `Triggers` screen in the permission
catalogue that governs nothing will mislead the next person to read it.

---

### T-H2 — saving a trigger reverts SMTP settings changed elsewhere

*Runtime. Data loss.* **Introduced by today's rewrite of this panel.**

`save()` posts `{ ...settings }` — the entire object returned by `GET`, which includes `smtpHost`,
`smtpPort`, `smtpUser` and `adminEmail`. The screen displays none of those four. `saveEmailSettings`
writes every field it receives, so a trigger flip is also a blind SMTP write of whatever values the
screen happened to load.

Measured:

```
1. seeded          smtpHost = mail.example.test
2. Triggers screen opened   (captures mail.example.test)
3. another admin sets       smtpHost = CHANGED.example.test   via CRM Settings
4. Triggers user unchecks Wedding, presses Save
5. read back       smtpHost = mail.example.test     ← the change was reverted
                   wedding  = false                 ← the intended edit did apply
```

Nobody is told. The person who changed the SMTP host has no indication it was undone; the person who
flipped the trigger has no idea they undid anything. This is worse than the ordinary last-writer-wins
race because the two people were editing *different screens about different things* — one was never
touching SMTP at all.

**Fix.** Send only what the screen owns: `{ autoSendEnabled, emailTemplates }`. That requires the
save endpoint to treat absent fields as "leave alone", which it currently does not — see T-H3, whose
fix is the same change.

---

### T-H3 — an empty or malformed request turns every trigger back on

*Runtime. Business logic.*

`saveEmailSettings` rebuilds the whole row from the request body on every call, defaulting anything
absent. Absent therefore means *reset*, not *leave alone* — and every default is permissive.

Measured:

```
configured:  smtpHost configured.example.test · port 2525 · user ops · admin ops@x.test
             autoSendEnabled FALSE · all five triggers FALSE

PUT {}  ->   200
after:       smtpHost "" · port 587 · user "" · admin ""
             autoSendEnabled TRUE · all five triggers TRUE
```

The same happens for `emailTemplates` given as a string, an array, or with non-boolean values: the
field is discarded and every trigger returns to its default of **on**. A brokerage that has
deliberately switched off promotional email has it switched back on by any request that forgets the
field — including a retry, a partial client, or an integration written against a different version
of the shape.

There is no confirmation and no audit record naming what changed (T-M2), so the first sign would be
a promotional email going out.

**Fix.** Treat an absent key as "unchanged" and a present-but-invalid one as an error. `PUT {}`
should be a 400, not a reset.

---

### T-H4 — a trigger-blocked send is recorded nowhere

*Runtime. Compliance / auditability.*

`dispatch()` records an entry in `crm_email_log` for every outcome — delivered, failed, refused for
opt-out, refused because the address is not a lead, and (since this morning) refused by the master
switch. `disabled()`, the trigger refusal, returns without calling `record()`.

Measured on the database directly:

```
log rows recording a MASTER-blocked send:   9
log rows recording a TRIGGER-blocked send:  0
```

So the screen's own switches are the one gate whose refusals leave no evidence. An administrator
cannot answer "did the wedding email go out to that client, or was the trigger off at the time?" —
and the CRM Email Log, which is where they would look, shows nothing at all.

This matters beyond tidiness. The reason `optedOut` records its refusals is stated in the code: under
CASL an opt-out nobody can prove was honoured is most of the problem. A trigger switched off is the
same kind of instruction from the brokerage, and it is the only one with no proof.

**Fix.** Four lines — call `record()` from the trigger-disabled path, exactly as the master-switch
path now does.

---

## MEDIUM

### T-M1 — non-boolean switch values are silently replaced by "on"
`emailTemplates: { wedding: 'nope' }` → **200**, stored as `wedding: true`. `autoSendEnabled:
'maybe'` → **200**, stored as `true`. Both default to the permissive value, and the response reports
the substituted value as though it were what was asked for. The equivalent coercion was removed from
the preferences and notification validators earlier today; this validator was not touched.

### T-M2 — the audit entry does not say which trigger changed
Every save writes `old_value: null`, `new_value: "Email settings"`, with a details string listing
which triggers ended up on. There is no before, so the trail cannot answer "who turned promotional
off, and when". Company Settings gained per-field before/after auditing this morning; this endpoint
did not.

### T-M3 — the screen never notices a change made elsewhere
Measured: one administrator has Triggers open; another turns every trigger off through the API; the
open screen still shows Wedding as **on** three seconds later and indefinitely thereafter. There is
no polling, no refresh on window focus, and no version check on save. On its own this is a stale
view; combined with T-H2 it is the mechanism by which one person's work overwrites another's.

### T-M4 — unsaved edits are discarded with no warning
Measured: uncheck Wedding, navigate to Leads, come back — the switch is on again and nothing was
said. Both Settings screens gained an unsaved-edit guard earlier today; this panel was not given
one, so the module is now inconsistent with its two closest neighbours.

### T-M5 — the master switch has no confirmation
Turning off "Allow CRM emails" and pressing Save blocks **every** CRM email for the whole brokerage.
Measured: no dialog, no warning, just "CRM triggers saved". The broadcast button two screens away
confirms before emailing everyone; this one silently stops everyone.

### T-M6 — the screen has no headings at all
Measured: `document.querySelectorAll('h1,h2,h3,h4')` inside the content area returns **zero**. The
card title is a `<div class="modal-h">`. A screen-reader user gets six labelled checkboxes and no
structure around them. (The six controls themselves are correctly labelled — the labels wrap the
inputs.)

### T-M7 — the send gate fails open
`isTriggerEnabled` returns the default — **on** — when the settings row is missing and when
`template_toggles` fails to parse. `autoSendEnabled` returns **true** when the row is missing. A
corrupt or absent row therefore re-enables every CRM email rather than holding the last known
instruction.

Failing open is right elsewhere in this application and the reason is written down — for a
notification preference, a missed reminder costs more than an unwanted one. The calculus inverts
here: the cost of failing open is an email the brokerage said not to send, to a client, from the
brokerage's own domain.

### T-M8 — `crm_email_settings` has no unique constraint on its tenant
The table has a primary key, a foreign key and an index on `company_id` — no unique. Two concurrent
first-saves on an empty table could create two rows, after which `findFirst({ orderBy: id asc })`
would silently govern from one while the other accumulated writes. Six concurrent saves during
testing produced one row, because the row already existed — the window is small, not absent. The
sibling `crm_settings` table received exactly this constraint in a migration earlier today; this one
was missed.

### T-M9 — a save after the session expires shows a raw backend string
Measured: cookies cleared, Save pressed → toast reads **"Unauthenticated."** and the user is left on
the page with their edits and no route back in.

---

## LOW

| # | Finding | Evidence |
|---|---|---|
| T-L1 | The master-switch refusal names the wrong screen | *"Turn 'Allow CRM emails' back on under **CRM Settings → Email Campaigns**"* — sent to someone who may have turned it off on Triggers |
| T-L2 | A failed load offers no retry | The card renders "CRM triggers are unavailable" with no way to try again short of a browser reload |
| T-L3 | A permission error is reported as unavailability | 403 produces "CRM triggers are unavailable", which reads as an outage rather than "you do not have access" |
| T-L4 | The screen does not say who last changed the triggers | `updated_by` and `updated_at` are returned by the API on every load and displayed nowhere |
| T-L5 | The Desk's Triggers screen has real automation and the CRM's has none | `/desk/triggers` renders a **"Scheduled — Runs on its own"** section; the CRM panel states the opposite. A user who sees both may reasonably expect the CRM's to be automatic. *Handoff observation only* |
| T-L6 | XSS payload stored raw in `smtpHost` | `<img src=x onerror=alert(1)>` round-trips. Escaped by React on render and the field is reference-only, so not exploitable — recorded because the value is unvalidated |
| T-L7 | No per-endpoint throttle | 25 rapid saves, all 200. The general 600/min per-endpoint bucket applies, which is the designed behaviour for a configuration write |

---

## What is genuinely well built

Attacked and held, which matters for deciding where the remediation budget goes.

- **The gate itself works.** Wedding switched off → *"Wedding email trigger is disabled"*, and the
  send never reached the mailer. Seasonal left on → reached SMTP. Master switch off → refused with a
  clear, actionable message. All three measured this afternoon.
- **Perimeter.** Unauthenticated `GET` → **401**, unauthenticated `PUT` → **419**, authenticated
  write without the CSRF header → **419**.
- **Mass assignment closed.** `id`, `company_id`, `updated_by` and `created_at` posted in the body
  were all ignored; `updated_by` remained the real signed-in name.
- **Injection.** `'; DROP TABLE crm_email_settings; --` stored as a literal string. Unicode and emoji
  round-trip correctly and are trimmed.
- **Unknown and oversized input dropped safely.** An unknown trigger key is discarded; a 5,000-key
  `emailTemplates` object returns 200 having stored only the five real keys.
- **Read-only rendering is correct.** An Admin holding `settings: view` sees all six switches,
  disabled, with the Save button withheld and an explanation — verified, and it is the pattern the
  rest of Settings now uses.
- **Double-click is handled.** A `dblclick` on Save produced exactly one PUT.
- **Area isolation is correct.** `/desk/triggers` renders the Transaction Desk panel and never the
  CRM's.
- **Phone layout is clean.** 390px: `scrollWidth === clientWidth`, no horizontal overflow.
- **Every control is labelled.** Six of six, via wrapping `<label>` elements.
- **No console errors** during ordinary use.

---

## Findings by category

| Category | Findings |
|---|---|
| **Functional bugs** | T-H3, T-M1, T-M7, T-L2 |
| **Workflow bugs** | T-H2, T-M3, T-M4, T-M9 |
| **Business-logic bugs** | T-H3, T-M5, T-M7 |
| **UI issues** | T-H1, T-M6, T-L1, T-L2, T-L3, T-L4 |
| **Database issues** | T-M8 |
| **Performance issues** | None. One row, one query, sub-100 ms; nothing to paginate |
| **Security issues** | T-H4 (auditability), T-M7, T-L6 |
| **Permission issues** | T-H1 |
| **API issues** | T-H2, T-H3, T-M1, T-M2, T-L7 |
| **Deployment risks** | T-M7 (fail-open on a corrupt row), T-M8 |

---

## Priority order and estimated fix time

| # | Work | Effort |
|---|---|---|
| 1 | **T-H3 + T-H2 together** — make the endpoint treat absent keys as unchanged, then have the panel send only `autoSendEnabled` and `emailTemplates`. One change fixes both, and T-H2 cannot be fixed without it | **half a day** |
| 2 | **T-H4** — record the trigger refusal, exactly as the master-switch path does | **1 hour** |
| 3 | **T-H1** — one authority for the screen: gate the nav and route on `settings`, or make the endpoints honour `triggers` | **2 hours**, plus a product decision on which |
| 4 | **T-M1 + T-M2** — refuse non-boolean values; record before/after per field | **half a day** |
| 5 | **T-M5 + T-M4** — confirm the master switch; add the unsaved-edit guard already used by the two Settings screens | **2 hours** |
| 6 | **T-M7** — fail closed on a corrupt row, or state in the code why open is right here | **2 hours** |
| 7 | **T-M6 + T-M3 + T-M9 + the Low band** | **1 day** |
| 8 | **T-M8** — unique constraint, mirroring the `crm_settings` migration | **1 hour** including the migration |
| | **Total** | **2½ – 3 developer-days** |

**Minimum to unblock go-live: T-H1 through T-H4 — about one day.**

---

## Recommendations

1. **A screen must not write fields it does not show.** T-H2 is the whole of that sentence. The
   pattern to adopt is the one Company Settings now uses: send the fields you own, and let the server
   leave the rest alone.
2. **Defaults on a send gate should be restrictive, not permissive.** T-H3 and T-M7 are the same
   instinct in two places — absent means "on", corrupt means "on", malformed means "on". For a
   control whose entire purpose is to stop email reaching clients, the safe direction is the other
   one.
3. **Every refusal deserves the same evidence as every send.** T-H4 exists because one branch of one
   method returns early. The log is already the right place; it just is not written to.
4. **The `triggers` permission currently governs nothing.** It appears in the permission catalogue,
   an administrator can grant and revoke it, and doing so changes nothing except whether a broken
   screen is reachable. Either connect it or remove it — an inert entry in a permission grid is the
   same class of problem as an inert switch on a settings screen, which is what this module was
   audited for in the first place.
5. **Carry the fixes made to Settings across to this screen.** The unsaved-edit guard, the per-field
   audit trail, the refusal of coerced values, the heading structure and the tenant uniqueness
   constraint were all added to CRM › Settings earlier today and all stop at its boundary. This panel
   reads the same row through the same service and should not behave differently.

---

## Runtime coverage

Eleven probe groups, six roles, one live stack, executed 2026-08-04 against `myapp_test`.

| Probe | What it drove |
|---|---|
| T1 | Role matrix — nav visibility, route access, rendered controls, GET/PUT status for all six accounts |
| T2 | Does a switched-off trigger stop a send? Does the master switch? Does an unrelated trigger still send? |
| T3 | Cross-screen concurrency — Triggers saving over a CRM Settings change |
| T4 | Twelve payload shapes: empty, partial, unknown keys, non-boolean, wrong types, XSS, SQLi, unicode/emoji, mass assignment, 5,000 keys |
| T5 | Perimeter (anonymous, CSRF), audit-trail content, 25 rapid saves |
| T6 | Full UI walkthrough: copy, headings, label association, double-click, unsaved edits, master-switch confirmation, console errors |
| T7 | 390px layout; `/desk/triggers` area isolation |
| T8 | Session loss mid-save; stale-screen behaviour under a concurrent change |
| T9 | Evidence trail — trigger-blocked vs master-blocked, counted in the database |
| T10 | `PUT {}` against a fully configured state |
| T11 | Six concurrent saves — duplicate-row check |

Screenshots in `e2e/audit-shots/`: `trg-agent.png`, `trg-crm.png`, `trg-desktop.png`, `trg-390.png`,
`trg-master-off.png`, `trg-session-lost.png`.

**Environment restored.** SMTP fields cleared, master switch on, all five triggers on, probe log rows
removed, no role permissions left modified.

---

## MODULE STATUS

### NOT PRODUCTION READY

**Justification.**

The gate works, and that is not nothing — it was the entire finding against this screen twelve hours
ago, and a trigger switched off now genuinely stops the email. If the question were only "do the
switches do what they say", this module would pass.

It fails on the three questions underneath that one.

**Can the people who need it use it?** Four of six roles are offered this screen in the navigation
and are refused by it. That is not a hidden edge case; it is what an agent sees the first time they
click the item the product put in front of them.

**Does using it break anything else?** Yes. Flipping one switch writes four fields the screen never
shows, so a trigger change silently reverts an SMTP change somebody else made on a different screen —
and neither person is told. That defect is mine, introduced this morning while fixing a different
one, and it is the clearest argument in this report for auditing your own remediation.

**Can you prove what it did?** No. The audit entry does not record which switch moved, and a
trigger-blocked send is written nowhere at all — while every other refusal in the same method is
logged. For a control whose purpose is to stop email reaching clients under Canadian anti-spam law,
an unprovable refusal is the wrong half of the feature to have built.

Add to that an empty request that turns every trigger back on with a 200, and the module is one
stray API call away from undoing the brokerage's own instruction.

**Go-live position.** T-H1 through T-H4 must be fixed first — about **one developer-day**, no
migration required, and T-H2 and T-H3 are a single change. With those four closed the module would
be defensible for launch with the Medium band scheduled. The Medium band should not be left long:
five of its nine items are fixes that already exist elsewhere in Settings and simply stop at this
screen's boundary.

**Re-audit trigger.** Any change to `saveEmailSettings`, to the `triggers` permission, or to
`CrmAdvancedEmailService.disabled()`.

---

## Remediation — 2026-08-04

**All 4 HIGH, all 9 MEDIUM and 5 of 7 LOW are closed.** Two LOW items were decided rather than
fixed, with reasons. Verified: server suite **769 passing** across 60 suites, browser suite **219
passing**, both builds and typechecks clean.

### The HIGH band, and the one change that closed all four

T-H1 through T-H4 were four symptoms of one design fault: five personal switches living on a single
brokerage-wide row. `crm_trigger_settings` — one row per person, migration
`20260804160000_crm_per_user_triggers` — closes them together.

| ID | What changed |
|---|---|
| **T-H1** | The endpoints moved to `@Screen('triggers', …)`, matching the route and sidebar that always asked for it. Safe to grant precisely because the rows are personal now — a `view` grant no longer exposes the brokerage's SMTP details. |
| **T-H2** | The screen sends switches and nothing else. There is no shared field left for it to trample, so a trigger flip can no longer revert SMTP settings changed on another screen. |
| **T-H3** | `saveForUser` treats an absent key as *unchanged* and a present-but-invalid one as an error. `PUT {}` is a 400, not a silent reset of every trigger to on. |
| **T-H4** | `refuse()` calls `record()`. A trigger-blocked send now appears in `crm_email_log` alongside every other refusal — which, under CASL, is most of the value of having the control. |

### The MEDIUM band

| ID | Outcome |
|---|---|
| **T-M1** | A non-boolean is now a 400 naming the field, instead of a silent substitution of the permissive default. |
| **T-M2** | One audit row per switch that moved, carrying `old_value` and `new_value`. The trail can answer "who turned promotional off, and when". |
| **T-M3** | The screen re-reads on tab focus — **but never over unsaved work**. `dirty` is the guard and is the whole reason this is safe: refreshing mid-edit would discard someone's work to fix a display problem, which is the worse bug. |
| **T-M4** | `useUnsavedGuard`, matching both Settings screens. |
| **T-M5** | The brokerage kill switch confirms before switching CRM email off for everyone. Only on the transition to *off* — a confirmation people see when nothing is happening is one they learn to click through. |
| **T-M6** | The card title is an `<h3>`. |
| **T-M7** | `isEnabledFor` fails **closed** on a corrupt row, and the screen says so. A deliberate departure from how this application resolves an unreadable preference elsewhere: the usual reasoning is that a missed reminder costs more than an unwanted one, and here the cost runs the other way — an email leaving the brokerage's domain that somebody said not to send. |
| **T-M8** | `crm_email_settings_company_id_key`. Two concurrent first-saves can no longer produce two rows for one brokerage. |
| **T-M9** | A 401 is translated from `"Unauthenticated."` into what happened and what to do. Matched on the **status**, not the wording, so a server that changes the string cannot silently reintroduce the raw version. |

### The LOW band

T-L1 (the refusal named the wrong screen), T-L2 (retry on a failed load), T-L3 (a 403 now reports as
a permission problem, not an outage), T-L4 (who last changed them, and when) and T-L6 (the SMTP host
must look like a host) are fixed.

**T-L5 and T-L7 were decided, not fixed.** T-L5 — the Desk's Triggers screen has real automation and
the CRM's does not — is a handoff observation about a different module; both screens now state
plainly what they do. T-L7 — no per-endpoint throttle — is the designed behaviour for a
configuration write, and the general 600/min bucket applies.

### Found while fixing, not in the audit

**The first Save severed inheritance for every trigger, not just the one you moved.** The panel
posted all five switches on every save, and the server merges what it receives — so flipping
*wedding* silently stopped *seasonal* following the brokerage default too, while the screen was
telling you, one switch at a time, "Following the brokerage default — change it and it becomes your
own choice." The screen now sends only what changed, which is what the Save button already counted.

Caught by a test asserting the inheritance the screen promises, not by reading the line.

### Verification

| Fix | Reverted to | Result |
|---|---|---|
| **T-M3** | no re-read | the cross-screen staleness test fails |
| **T-M5** | no confirmation | the kill-switch test fails |
| **T-M9** | raw backend message | the session-expiry test fails |
| **T-L6** | length check only | **6** host-validation tests fail |

New: `crm-triggers-findings.spec.ts` (16) and `e2e/tests/triggers.spec.ts` (6).

### Three test problems this exposed, worth recording

1. **A stale test asserting old wording.** `settings-high-fixes.spec.ts` still expected
   `"Save CRM Triggers"` and `/trigger is disabled/` — wording the per-user rewrite deliberately
   changed. It was failing on a behaviour that had been changed, not broken.
2. **An order-dependent test.** The same test passed alone and failed in the full suite: these
   switches persist per person, so an earlier test left wedding already off, `uncheck()` did
   nothing, and the Save button never appeared. It now sets its own starting state.
3. **An assertion that tested the harness.** A check that the triggers endpoint answers 401 used
   `page.request` after clearing cookies and got **200** — not because the endpoint is open, but
   because that context carries its own session. A fresh request context returns 401. The
   assertion was testing Playwright; it now tests the application.

### Still open

Nothing at any severity. `crm_trigger_settings` was also added to the tenancy classification, which
had been failing since the table arrived — it is derived via `users`, for the same reason
`crm_settings` is: the person owns the row, not the brokerage.
