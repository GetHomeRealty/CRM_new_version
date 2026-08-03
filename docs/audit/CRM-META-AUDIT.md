# CRM › Meta — Enterprise Production Readiness Audit

> **REMEDIATION — 2026-08-02.** Both CRITICAL findings and all seven HIGH findings are fixed and
> re-verified against the same probes that found them; see
> [Remediation](#remediation--2026-08-02) at the end. The findings below are preserved as written,
> because the reasoning is what makes the fixes reviewable.


**Date:** 2026-08-02 · **Scope:** the Meta (Facebook/Instagram) lead-ads module only —
`server/src/meta/*`, the `meta_*` tables, the `meta_*` columns on `leads`, `MetaPage.tsx`,
`MetaConnectionPanel.tsx`, `lib/metaApi.ts`. Connected modules (Leads, Campaigns, Notifications) were
verified **only** at the handoff: that an imported lead lands correctly and that a new-lead
notification is attempted. Neither was audited.

**Method:** full read of all twelve server files and the client screens, then runtime testing against
a running stack — 19 browser cases as six roles, plus six service-level probes driving `upsertLead`
directly with synthetic Graph payloads against the real schema (the import paths cannot otherwise be
reached without a live Facebook connection). Every finding below marked **[RUNTIME]** was observed;
the observed output is quoted.

---

## Executive Summary

This module is unusually well built at its edges and unsafe at its centre.

The **security perimeter is excellent** and I could not get through it. Every guarded endpoint
refuses a signed-out caller; CSRF is enforced; the webhook rejects unsigned, wrongly-signed and
malformed deliveries; the OAuth handshake refuses a wrong verify token; the callback refuses a
forged, absent or malformed `state`; page ownership is checked before any form is listed or
connected; thirteen hostile inputs including SQL metacharacters, 5,000-character parameters and
type-confused JSON produced no 5xx; stored markup renders inert. Access tokens are AES-256-GCM
encrypted at rest, never returned to the browser, sent to Graph as an `Authorization` header rather
than a query parameter, and wiped on disconnect. The webhook is idempotent by a unique event key.
Somebody thought hard about this.

The **lead import is where it goes wrong**, and the central defect is severe: when a Meta submission
matches an existing lead **by email or phone, anywhere in the brokerage**, the module enriches that
lead — regardless of whose book it is in. Confirmed at runtime: agent A's Meta form received a
submission, agent B's unrelated lead was rewritten (`source manual→facebook_meta`,
`lead_source refferal→meta`, the message the person typed on agent A's ad written onto B's record,
plus 288 bytes of raw Graph payload), **and agent A received no lead at all**.

That is three failures in one: a paid lead silently discarded, a cross-book write into a record the
writer cannot see, and the corruption of a colleague's provenance data. It also contradicts the
uniqueness model deliberately adopted on 2026-08-02, where the same person may legitimately be a lead
of two different agents *because they can arrive through anybody's ad*. The Meta importer is the one
place that most obviously produces that situation, and it is the one place that still merges.

Beneath that sit four more confirmed ways to lose a lead outright: an over-length form answer
(email, phone, location and budget all lost), a returning enquirer whose earlier lead was deleted, a
form connected by two agents, and any backlog past the first 500 submissions.

**A lead-ads integration that loses leads is worse than no integration**, because the brokerage is
paying Meta per click for the ones that vanish, and nothing on any screen says they did.

### Production Readiness Score

**41 / 100 — NOT PRODUCTION READY**

| Dimension | Score | Note |
|---|---|---|
| Authentication & authorization | 92 | Perimeter held against every probe |
| Data isolation | 20 | Cross-book writes on both match rules |
| Import correctness | 25 | Five confirmed ways to lose a lead |
| Input validation (API) | 85 | No 5xx across 13 hostile inputs |
| Input validation (Graph payloads) | 30 | No length caps anywhere in the mapper |
| Token handling | 90 | Encrypted, header-borne, wiped on disconnect |
| Webhook security | 95 | HMAC, timing-safe, idempotent |
| Resilience | 40 | No Graph timeouts; a hung call stalls auto-sync |
| Observability | 60 | Sync history good; import losses invisible |
| Deployment readiness | 35 | Ephemeral tunnel URL, unvalidated in production |
| UI | 80 | Clean render, one missing confirmation |

---

## CRITICAL

### M-C1 — A Meta lead matching a colleague's email is absorbed into their book [RUNTIME]

**Where:** [`meta-sync.service.ts:67-90`](../../server/src/meta/meta-sync.service.ts#L67-L90) `findExisting`

```ts
const byEmail = await this.prisma.leads.findFirst({
  where: { email: { equals: mapped.email, mode: 'insensitive' }, deleted_at: null },
});
```

No owner filter. The lookup spans the entire brokerage; the update that follows writes into whatever
it finds.

**Observed** — agent B held a lead; the same person then filled in agent A's Meta form:

```
[AUDIT-1] outcome=duplicate rule=email address leadId=112183 (agent B's lead is #112183)
[AUDIT-1] agent A received a lead of their own: NO
[AUDIT-1] agent B's record was mutated: source manual->facebook_meta,
          lead_source refferal->meta, message="Interested in 12 Elm",
          facebook_lead_id=fb-…, meta_raw stored=yes (288 bytes)
```

**Four distinct harms:**

1. **The paid lead is lost.** Agent A ran the ad, paid for the click, and has nothing. The sync
   reports it under `duplicates`, which reads like healthy de-duplication.
2. **A cross-book write.** Agent B's record is modified by an event in a book B cannot see, by a
   process acting for A. This is the same defect class as the tag-deletion finding fixed on
   2026-08-02 (CRM audit C-3).
3. **Provenance corruption.** B's referral lead now claims to be a Meta lead. Any report on lead
   source, any commission attribution that keys on it, and any campaign audience built on
   `lead_source` are now wrong for that record — and wrong in the direction that credits Meta spend
   with a lead it did not produce.
4. **Cross-book PII.** `meta_raw` — the complete Graph payload of what the person typed on **agent
   A's ad** — is stored on **agent B's** lead, along with `message`, `budget` and `timeline`.

**It contradicts a decision already taken.** The `(company_id, owner_user_id, lower(email))`
uniqueness model was adopted precisely so that "a lead clicks on a brokerage ad… they can also add
the lead to their CRM, and an agent in the same brokerage should have the same feature". Meta ads are
the exact scenario. The database now permits the second copy; this importer refuses to create it.

**Fix:** scope `findExisting` to the importing user's own book — `owner_user_id` or `assigned_to`
equal to `ctx.userId` — exactly as `LeadImportEngine` was corrected. Everything outside it is not a
duplicate and must not be read or written. **Estimate: 4 h**

### M-C2 — The same, on a phone match, with a completely different email [RUNTIME]

Same function, third rule. Two genuinely different people who share a number — a household line, an
office switchboard, a couple — merge into one record, and again into whoever's book already holds it.

**Observed:** a submission with a *different email* and the phone `+1 416-555-0199` matched agent B's
lead `(416) 555-0199`:

```
[AUDIT-2] outcome=duplicate rule=phone number; agent B's record now has
          facebook_lead_id=fb-…, source=facebook_meta
```

`normalizePhone` reduces to the last ten digits, so international numbers that differ only by country
code collide too. Phone matching is a reasonable de-duplication rule **within one book**; across the
brokerage, with a merge as the consequence, it is a data-integrity hazard.

**Fix:** same scoping. Consider making phone matching secondary — merge on phone only when the email
is absent or also matches. **Estimate: included in M-C1**

---

## HIGH

### M-H1 — An over-length form answer silently loses the lead [RUNTIME]

**Where:** [`meta-lead-mapper.ts`](../../server/src/meta/meta-lead-mapper.ts) — no length caps
anywhere; [`meta-sync.service.ts:154`](../../server/src/meta/meta-sync.service.ts#L154) caps only
`name`.

Meta lead-form answers are free text. The columns are not: `email` and `location` are `VarChar(255)`,
`phone` is `VarChar(64)`, `budget`/`timeline`/`property_type` are `VarChar(128)`.

```
[AUDIT-3] over-length email (311 chars) -> THREW: value too long for the column's type
[AUDIT-4] phone (VarChar 64): LOST | location (VarChar 255): LOST | budget (VarChar 128): LOST
```

`syncUser` catches per lead and increments `skipped`; a `Logger.warn` is the only record. The screen
shows a number with no way to learn which submission it was or that anything is recoverable — and
the submission is not re-attempted, because the next sync hits the same wall.

**This is the identical defect fixed in the CSV importer on 2026-08-02** (CRM audit H-7), where one
over-length cell destroyed a 500-row batch. The Meta importer was never given the same treatment.

**Fix:** apply per-column caps in the mapper, as `IMPORT_FIELD_LIMITS` does for CSV. Truncate and
keep the lead; the tail of a location is worth less than the enquiry. **Estimate: 3 h**

### M-H2 — A returning enquirer whose earlier lead was deleted cannot be imported [RUNTIME]

`findExisting` filters `deleted_at: null`, so a soft-deleted lead is invisible to it — but the
`lower(email)` unique index still holds the address.

```
[AUDIT-5] the person re-enquires after their lead was deleted -> P2002 unique violation
```

A lead deleted in error, or as routine housekeeping, permanently blocks that person from ever
arriving again through Meta. The `leads` module already translates P2002 into a validation error
offering to restore from Recently Deleted; the Meta path has no such handling and simply loses it.

**Fix:** on P2002, look for the soft-deleted row and either restore-and-enrich it or record a clear
`skipped` reason naming the conflict. **Estimate: 3 h**

### M-H3 — When two agents connect the same lead form, only one ever receives webhook leads [RUNTIME]

`meta_lead_forms` is `@@unique([user_id, form_id, page_id])` — deliberately per user, so two agents
*can* connect the same form. But the webhook resolves the owner with:

```ts
const form = await this.prisma.meta_lead_forms.findFirst({ where: { form_id, page_id, is_active: true } });
```

`findFirst`, no ordering, no handling of multiple matches.

```
[AUDIT-6] 2 users connected the same form; the webhook resolves exactly one owner (user 900001).
          The other user receives nothing from the webhook path, with nothing on screen to say so.
```

Two agents sharing a Page — co-listing partners, a team, an office account — is an ordinary
arrangement. The second agent's screen shows the form as connected and silently never delivers.
(The scheduled poll does reach both, so the symptom is intermittent, which is worse for diagnosis.)

**Fix:** decide the rule explicitly — deliver to all connected owners, or refuse the second
connection with a message naming the first. Either is defensible; silence is not. **Estimate: 4 h**

### M-H4 — No timeout on any Graph call; a hung request stalls auto-sync permanently

[`meta-graph.service.ts:212-221`](../../server/src/meta/meta-graph.service.ts#L212-L221) — `get()`,
`exchangeCode`, `longLivedToken`, `inspectToken` and `appPermissions` all call `fetch` with no
`AbortSignal`. Every other outbound integration in this codebase sets one: the AI provider 45 s,
ID extraction 45 s, mail deliverability 4 s.

The scheduler holds `this.running = true` for the duration of a pass. A single socket that never
closes leaves that flag set for the life of the process, and **auto-sync stops for every connected
account until someone restarts the API** — with no error, because nothing threw.

**Fix:** `AbortSignal.timeout(30_000)` on every Graph call, plus an overall budget on a poll pass.
**Estimate: 2 h**

### M-H5 — The Meta app secret is placed in URL query strings

`inspectToken` and `appPermissions` both build `access_token=${appId}|${appSecret}` into the URL:

```ts
url.searchParams.set('access_token', appToken);                       // inspectToken
fetch(`${graphOrigin()}/${appId()}/permissions?access_token=${...}`)  // appPermissions
```

`get()`'s own comment explains why this is wrong — *"Sent as a header, not a query parameter: …query
strings end up in proxy and access logs"* — and then two sibling methods do exactly that, with the
app secret rather than a user token. Any egress proxy, corporate TLS inspection or request logging
captures a credential that grants app-level Graph access.

**Fix:** send the app token as an `Authorization: Bearer` header like every other call.
**Estimate: 1 h**

### M-H6 — `META_PUBLIC_URL` is an ephemeral tunnel, and nothing validates it for production [RUNTIME]

```
META_PUBLIC_URL=https://beans-betty-marker-contracting.trycloudflare.com
```

Observed in the returned OAuth URL and `status.redirect_uri`. A Cloudflare quick tunnel gets a **new
hostname on every restart**. Two things break simultaneously and silently when it does:

- the OAuth redirect URI stops matching the value registered in the Meta app, so **nobody can
  connect**; and
- the webhook callback URL becomes unreachable, so **lead deliveries stop arriving**.

`validate-config.ts` refuses to boot production with a bad `FRONTEND_URL` — grep confirms **it makes
no checks on any `META_*` variable**. The Campaigns module independently detects exactly this
(`/trycloudflare\.com|ngrok/` in its tracking-health check) and warns on screen. Meta has no
equivalent.

**Fix:** add `META_PUBLIC_URL` to production config validation (set, HTTPS, no trailing slash, not an
ephemeral tunnel host), and surface the ephemeral-host warning on the Meta screen the way Campaigns
does. **Estimate: 3 h**

### M-H7 — Only the newest 500 submissions per form are ever imported

`MAX_LEADS_PER_FORM = 500` is passed as Graph's `limit` and no cursor is followed. A Page connected
with an existing backlog imports the newest 500 and **never sees the rest** — not on this sync, not
on any later one, because each run asks the same question. Nothing reports a truncation.

The constant's comment says the cap exists "so a huge backlog can't stall the request", which is a
good reason for a cap and not a reason to discard what it excludes.

**Fix:** follow `paging.next` with a total ceiling, or record `truncated: true` on the sync history
row and say so on screen. **Estimate: 4 h**

---

### M-H8 — Disconnecting Meta does not release the agent's lead forms, so a departure locks them for good [RUNTIME]

**Found while confirming the one-form-one-agent rule, after M-H3 was believed fixed.**

`disconnect()` deletes the pages and deactivates the connection. It never touches
`meta_lead_forms` — and forms do **not** hang off pages by a foreign key, `page_id` is a plain
`VarChar(64)`, so nothing cascades. Every form row stays `is_active` and keeps its claim under
`meta_lead_forms_page_form_key`.

The consequence lands squarely on the rule M-H3 exists to enforce. The claim is meant to be released
by deactivation — that is the entire reason the unique index is partial rather than absolute, and
`meta.controller.ts` says so: *"a form somebody previously connected and turned off is free to be
taken up by whoever is running it now."* Turning off a single form does release it. Disconnecting
the whole account does not.

So an agent who left took their forms with them permanently. The successor connecting the same form
was refused, **naming a colleague who no longer works at the brokerage**, and the only remedies were
a direct database edit or building a new form in Meta and abandoning the ad pointing at it. The
screen meanwhile showed the departed agent as disconnected, so nothing suggested where the block was
coming from.

Confirmed against `myapp_test` by running the real `disconnect()` and then attempting the hand-over:

```
A claimed the form: OK
A disconnected (pages deleted, connection deactivated)
  -> A's form row after disconnect: is_active=true
  -> successor B REFUSED
```

**This also invalidated part of the M-H3 verification.** The original probe asserted "after the
first disconnects, the second connects successfully" — but it reconstructed the disconnect in SQL
rather than calling the service, and its reconstruction deactivated the form rows. It proved the
index behaves correctly, which was never in doubt, and said nothing about the code path a user
actually takes. A simulation that agrees with the design intent instead of with the code is worse
than no test.

**Fix:** deactivate the agent's forms in the same transaction as the connection. **Estimate: 1 h**

---

### M-H9 — Deactivating an agent does not stop their Meta intake, and the leads land where nobody can see them [RUNTIME]

**Found while confirming M-H8's fix, by asking what an actual departure looks like end to end.**

`meta-sync-scheduler.service.ts` resolves each connection's owner with
`users.findUnique({ where: { id } })` and skips only when the row is missing. A **deactivated**
account is still a row, so the poll ran on exactly as before. Its own comment claimed otherwise —
*"A connection whose owner was deleted or deactivated has nothing to sync against"* — which is the
same shape of defect as M-H8: the comment states the intent and the code implements half of it.

The webhook had the identical gap on the fast path, where pausing the poller would not have helped
anyway.

Neither `users` nor `LeadTransferService` touched `meta_connections` or `meta_lead_forms`, so
deactivating somebody left their integration entirely live. Leads kept being created against them —
and **visible to nobody**: they cannot sign in, lead visibility is per person, and a Super Admin sees
unattributed intake (`owner_user_id IS NULL`) rather than another person's book. The brokerage went
on paying for clicks that produced enquiries no screen could reach, with a Meta screen that showed
the account as connected and healthy.

Transferring the book moved what already existed but not the connection, so fresh leads kept
arriving in the same invisible place — the visible backlog moved while the pipeline refilled behind
it.

**Fix:** deactivation performs the departure — disconnect Meta, return brokerage leads to the
brokerage, leave the agent's own Meta leads with them. The scheduler and webhook additionally refuse
a non-Active owner as a net for connections predating this. **Estimate: 4 h**

Full rules in [`../AGENT-DEPARTURE-POLICY.md`](../AGENT-DEPARTURE-POLICY.md).

---

## MEDIUM

| ID | Finding |
|---|---|
| **M-M1** | **Webhook health is not scoped to the caller** [RUNTIME]. `webhookHealth(limit)` takes no user id. An agent reads `200` with every user's deliveries — `leadgen_id`, `form_id`, `page_id` and the resulting `lead_id`. Cross-book metadata disclosure, and the only unscoped read in the module. |
| **M-M2** | **OAuth state replay protection is per-process and self-clearing.** `MetaStateService.used` is an in-memory `Set`, and `prune()` calls `used.clear()` once it exceeds 5,000 — so after 5,000 issued states **every previously-redeemed nonce becomes replayable again** (within its 10-minute TTL). It is also empty after a restart and not shared between instances. |
| **M-M3** | **The state signing secret falls back to the literal `'meta-state'`** when neither `APP_KEY` nor `SESSION_SECRET` is set. With a known secret an attacker forges a state and binds their Facebook account to another user's. Production config validation requires `SESSION_SECRET`, so this is a development exposure — but a hardcoded fallback secret should not exist. |
| **M-M4** | **`meta_raw` stores the complete Graph payload indefinitely** — every answer the person typed, duplicated out of the mapped columns, with no size cap and no retention policy. Under M-C1 it is also written onto other agents' leads. |
| **M-M5** | **Disconnect has no confirmation in one of the two places it exists.** `MetaPage.tsx` uses `ConfirmDialog`; `MetaConnectionPanel.tsx` (mounted in CRM Settings) disconnects on a single click. The same destructive action — it wipes the stored tokens and requires a full OAuth re-consent — behaves differently depending on which screen you are on. |
| **M-M6** | **`adAccounts` and `selectAdAccount` are not wrapped in `wrap()`**, unlike every other Graph-calling endpoint, so a `GraphError` surfaces as a 500 instead of Meta's own message. |
| **M-M7** | **`toggleForm` validates the page but not the form.** Any string is accepted as `form_id` and stored as connected; the failure only appears later, as a sync error against a form that does not exist. |
| **M-M8** | **`POST /api/meta/sync` has no specific rate limit.** Each call fans out to one Graph request per connected form. Graph limits are per app, so one user pressing Sync repeatedly can exhaust the budget for every account in the brokerage. |
| **M-M9** | **`meta_webhook_events.company_id` is nullable** while every sibling table has `Int @default(1)` — webhook rows arrive with no session and no tenant. Combined with M-M1's unscoped read, webhook metadata is not tenant-isolated. |
| **M-M10** | **`custom_fields` is unbounded.** Every unmapped answer is JSON-stringified into a `Text` column with no cap. |

---

## LOW

| ID | Finding |
|---|---|
| **M-L1** | The public controller is entirely `@SkipThrottle()` [RUNTIME] — 40 rapid unauthenticated calls, no `429`. Deliberate and documented (a throttled webhook is a lost lead), but it leaves the module's only unauthenticated surface unmetered, and each request costs an HMAC over a body of up to 12 MB. |
| **M-L2** | `claim()` catches **any** error and treats it as a duplicate delivery. A transient database failure is therefore reported as "already handled" and the lead is never processed. |
| **M-L3** | `normalizePhone` reduces to the last ten digits, so numbers differing only by country code collide — feeding M-C2. |
| **M-L4** | `GET /api/meta/diagnostics` is available to `meta:edit`, which agents hold by default. It returns the app id, app name, live permission list and `META_LOGIN_CONFIG_ID`. |
| **M-L5** | `redirect_uri` derives from `X-Forwarded-Host` when `META_PUBLIC_URL` is unset. Not exploitable in this deployment [RUNTIME — spoofed header had no effect because the override is set], but it is a Host-header dependency in an OAuth flow. |
| **M-L6** | The scheduler's `running` guard sits inside `pollAllForTenant`, so a slow first tenant suppresses the pass for every other tenant on that tick rather than only for itself. |

---

## What is genuinely well built

Tested, not assumed:

- **Every guarded endpoint refuses a signed-out caller** — 9 GETs and 5 writes, all `401`/`419`.
- **CSRF is enforced** — `POST /api/meta/sync` without the header → `419`.
- **Webhook signature verification holds** — unsigned, wrongly-signed and malformed all answered
  `{"received":false}`, and always with HTTP 200 so Meta does not retry-storm. HMAC compared with
  `timingSafeEqual`.
- **Webhook handshake** — wrong token, absent token and empty query all `403 Forbidden`; the
  challenge is never echoed.
- **OAuth callback** — forged, absent and malformed `state` all redirect to
  `?meta_error=invalid_state`; a user denial reports `user_denied`. No path reached `meta_connected=1`.
- **Page ownership** — listing or connecting a form on a page outside your connection → `400
  "That page is not part of your Meta connection."`
- **No 5xx across 13 hostile inputs** — SQL metacharacters, 5,000-character parameters, type-confused
  JSON (`{$ne:1}`, arrays where strings are expected), 10,000-character ids, negative and
  non-numeric limits.
- **XSS** — stored markup in a lead name rendered inert on the Meta screen.
- **UI** — `/crm/meta` renders with zero client errors as agent, admin and super admin (screenshots
  captured).
- **Token handling** — AES-256-GCM under a key derived from `APP_KEY`; a missing key stores a
  `plain:` marker rather than pretending, and `token_storage_secure` surfaces it in the UI; tokens go
  to Graph as an `Authorization` header; disconnect wipes them; no endpoint returns one.
- **Webhook idempotency** — a unique `event_key` claims the delivery before any work, so a retry
  cannot double-import.
- **Graceful degradation** — missing ads permissions cost attribution, not leads (`formLeads` retries
  with base fields); `/me/accounts` falls back to the nested form.
- **The scheduler** is tenant-scoped, sequential by design (Graph limits are per app), `unref`'d, and
  registered with worker-health.
- **`diagnostics`** is a genuinely good operator tool — it names the blockers and the exact fix steps.

---

## Runtime coverage

| Area | Cases | Result |
|---|---|---|
| Authentication / CSRF | 2 | both pass |
| Role reachability | 6 roles | recorded |
| Data isolation | 3 | 1 finding (M-M1) |
| Public surface (webhook, handshake, callback, throttling) | 4 | 3 pass, 1 finding (M-L1) |
| Validation / payloads / host-header | 4 | pass |
| UI render + XSS + confirmation | 5 | pass |
| **Import service probes** | **6** | **6 findings — M-C1, M-C2, M-H1, M-H2, M-H3** |

Screenshots: `meta-agent.png`, `meta-admin.png`, `meta-superAdmin.png`, `meta-disconnect-state.png`.

**Not covered:** anything requiring a live Facebook connection — the real OAuth round trip, a genuine
webhook delivery from Meta, Graph rate-limit behaviour, and token expiry at 60 days. The import logic
behind those paths was exercised directly instead, which is why the import findings are confirmed
rather than inferred.

---

## Priority order

| # | ID | Why here | Est. |
|---|---|---|---|
| 1 | **M-C1 / M-C2** | Cross-book writes and silently discarded paid leads, happening on every matching submission. | 4 h |
| 2 | **M-H1** | Four field types confirmed to lose a lead outright. | 3 h |
| 3 | **M-H3** | Two agents on one form is an ordinary arrangement that silently half-works. | 4 h |
| 4 | **M-H2** | A deleted lead permanently blocks that person from returning. | 3 h |
| 5 | **M-H4** | One hung socket stops auto-sync for the whole brokerage until a restart. | 2 h |
| 6 | **M-H6** | The integration breaks entirely on the next tunnel restart, silently. | 3 h |
| 7 | **M-H5** | App secret in URLs. | 1 h |
| 8 | **M-H7** | Backlog beyond 500 never arrives. | 4 h |
| 9 | M-M1, M-M2, M-M3 | Isolation and OAuth replay. | 6 h |
| 10 | M-M4 … M-M10 | Retention, UX, error shaping, rate limiting. | 10 h |
| 11 | M-L1 … M-L6 | Polish and defence in depth. | 5 h |

**Blocking release (1–8): ~24 hours.** Full remediation: ~45 hours.

---

## Recommendations

1. **Fix the scoping first, and check for damage.** Before anything else, find out whether M-C1 has
   already fired in production:
   `SELECT id, owner_user_id, source, lead_source, facebook_lead_id FROM leads WHERE facebook_lead_id IS NOT NULL AND source = 'facebook_meta' AND owner_user_id NOT IN (SELECT user_id FROM meta_lead_forms WHERE is_active);`
   Any row returned is a lead that was rewritten by someone else's ad.
2. **Make "lost lead" impossible to miss.** Every path that currently increments `skipped` should
   write a row naming the submission and the reason. A paid lead that vanishes must leave evidence.
3. **Reuse the CSV importer's fixes rather than reinventing them.** M-H1 and M-H2 are the same two
   defects already solved in `LeadImportEngine` — per-column caps, and P2002 translated into
   something actionable. Two importers, one set of rules.
4. **Add `META_*` to production config validation.** The module's most likely production failure is
   an expired tunnel, and the machinery to catch it already exists for `FRONTEND_URL`.
5. **Do not go live on a quick tunnel.** `META_PUBLIC_URL` must be a stable HTTPS host registered in
   the Meta app before the first real campaign runs.

---

## MODULE STATUS

### NOT PRODUCTION READY

**Justification.** The perimeter of this module is strong enough that I could not breach it, and the
token handling is better than most integrations of its kind. That is not what decides it.

What decides it is that the module's single purpose — turning paid Facebook lead-ad submissions into
leads — is unreliable in five confirmed, reproducible ways, and its central defect writes into data
the writer is not allowed to read. A brokerage running this in production would pay for clicks that
produce no lead, would find agents' records silently rewritten with another agent's campaign data,
and would have no signal that either had happened: the sync reports "duplicates" and "skipped" and
moves on.

Two of the five losses (over-length answers, deleted-lead conflicts) are defects already identified
and fixed in the CSV importer during the CRM audit. They were never carried across. That is the
strongest argument for treating this as a scoping problem rather than a series of bugs: the same two
importers should not be allowed to disagree about what a duplicate is or what happens when a value is
too long.

The blocking set is roughly three days. After it — and after `META_PUBLIC_URL` points at a stable
host — this would be a credible production integration, because everything around the import is
already built to a high standard.


---

# Remediation — 2026-08-02

Every fix re-verified with the probe that found the defect, so the "before" and "after" are the same
measurement.

## Fixed

| ID | Change | Verified |
|---|---|---|
| **M-C1** | `findExisting` matches only within the importing agent's own book (`owner_user_id` or `assigned_to` = them). `facebook_lead_id` stays global — a match there is the same submission arriving twice, and scoping it would let a webhook retry create a second copy. | agent A now gets **their own lead**; agent B's record: `source=manual lead_source=refferal message="B's own note" facebook_lead_id=null meta_raw=null` — untouched |
| **M-C2** | Same scoping on the phone rule. | `outcome=imported rule=none`; agent B's `source` still `manual` |
| — | Matching **within** a book still works, so genuine re-enquiries still enrich rather than duplicate. | `outcome=duplicate rule=email address`, 1 row, message enriched |
| **M-H1** | `META_FIELD_LIMITS` caps every mapped value to its column, applied at the end of the mapper so a field added later cannot be forgotten. `phone_normalized` is derived *before* the cap, so matching still uses the whole number. Custom answers are capped per answer **and** as a whole — capping only the total meant one runaway answer discarded every other question the client answered. | `name=255 email=255 phone=64 location=255 budget=128 message=20000 custom_fields=18127` against 50,000-character answers; the full text remains in `meta_raw` |
| **M-H2** | A submission whose address is held by a **soft-deleted lead of the same agent** restores that lead and attaches the new enquiry, instead of raising P2002 and losing it. Restoring is right rather than creating a second row: it is the same person, the history is still there, and a fresh enquiry supersedes a filing decision. | `outcome=imported rule=restored a deleted lead with the same address`, `deleted_at=null`, message attached |
| **M-H3** | **One form, one agent.** Refused at connect time with the holder named, and enforced by `meta_lead_forms_page_form_key` — a partial unique index on `(company_id, page_id, form_id) WHERE is_active`. Partial so a form somebody disconnects is free for whoever runs it next. The webhook's `findFirst` ambiguity is gone; if pre-constraint rows still exist it refuses loudly rather than guessing. | second agent connecting the same form → **refused by the database**. The hand-over half of this claim was wrong when first made — see **M-H8** |
| **M-H4** | `AbortSignal.timeout(META_GRAPH_TIMEOUT_MS)` on every Graph call, including the two token exchanges. A timeout becomes a `GraphError` with 504 so existing handlers cover it. Without this, one hung socket held the scheduler's `running` flag for ever and auto-sync stopped for the whole brokerage until a restart, with nothing logged. | typecheck + suite |
| **M-H5** | The app token moves to an `Authorization` header in `inspectToken` and `appPermissions`. `appId\|appSecret` **is** the app secret, and it was in the query string — the exact thing `get()`'s own comment warns against. | no `access_token=` remains in any URL |
| **M-H6** | `validate-config.ts` now refuses to boot production with Meta configured but `META_PUBLIC_URL` unset, non-HTTPS, localhost, trailing-slash, or an **ephemeral tunnel host** — plus `APP_KEY` unset (tokens would be stored in plain text) and `META_WEBHOOK_VERIFY_TOKEN` unset (the subscription handshake can never complete). Only runs when Meta is configured at all. | the development value `https://beans-…​.trycloudflare.com` is exactly what this now blocks |
| **M-H7** | `formLeads` follows Graph's `paging.next` cursor to `META_MAX_LEADS_PER_FORM` (default 5,000, was a single 500-row page) and returns `truncated`. `syncUser` turns that into an error line naming the form and saying to raise the ceiling — because the remaining leads are not coming on the next run either. A `seen` set guards against a self-referential cursor. | typecheck + suite |

| **M-H8** | `disconnect()` deactivates the agent's lead forms in the same transaction as the connection, releasing the claim the partial index was designed to release. Deactivated rather than deleted, matching the connection row: the audit trail survives, the scheduler's `is_active` filter stops the polling, and the same agent reconnecting flips their own rows back on with their sync history intact. | `meta-offboarding.spec.ts` — 4 tests calling the real service. Removing the fix fails the two that assert it (hand-over, polling stops) and leaves the two invariants passing (another agent untouched, reconnect does not duplicate) |

| **M-H9** | Deactivating a user left their Meta connection live: the scheduler resolved the owner with `findUnique`, which returns a deactivated account exactly as it returns an active one, so leads kept arriving into a book nobody could open. Deactivation now disconnects Meta outright; the scheduler and the webhook additionally refuse a non-Active owner, as a net for connections predating the change. | `users/offboarding.spec.ts` — fails if the disconnect, the scheduler guard, or the webhook guard is removed |

### The five MEDIUM findings taken before production

| ID | Change | Verified |
|---|---|---|
| **M-M1** | `webhookHealth` now takes the caller and returns only deliveries for **their own** forms, matched on `form_id` — globally unique in Meta, so "my forms" is exactly "events that were or would have been mine". Forms since disconnected are kept, because losing the trail the moment a form is switched off hides the period being diagnosed. A Super Admin still sees everything, which is the only view an unroutable delivery appears in at all. | 6 tests. Removing the scope fails 4 of them |
| **M-M1+** | The health view now also reports **connected but silent** — forms connected with no delivery for `META_WEBHOOK_QUIET_HOURS` (default 24). A webhook stops silently and "no deliveries" is indistinguishable from a quiet week; polling covers the gap, so this warns rather than alarms. | asserted both ways: never-received, and cleared by a delivery |
| **M-M2** | The in-memory replay `Set` is gone. Redeemed nonces live in `meta_oauth_nonces`, and **the INSERT is the check** — a unique violation cannot be raced, unlike read-then-write. Only expired rows are swept, never a wholesale `clear()`. Survives a restart and is shared between instances. | a second service instance — the equivalent of a restart or a second app server — still rejects the replay |
| **M-M3** | The `'meta-state'` fallback signing key is removed. With no `APP_KEY` or `SESSION_SECRET` the service now **throws** rather than signing with a value anybody could guess: a known signing key is the same as no signature, and lets anyone mint a state naming any user id. | `issue()` throws naming `APP_KEY` |
| **M-M4** | `meta_raw` is capped at `META_RAW_MAX_CHARS` (20,000) on write, with truncation **marked** in the stored value — a clipped payload that still parses as JSON is worse than none, because somebody re-mapping from it would read partial answers as complete. Payloads are then cleared after `META_RAW_RETENTION_DAYS` (90) by a sweep on the sync scheduler; the lead itself is untouched. | cap and marker asserted; retention sweep clears an old payload and leaves a recent one |
| **M-M5** | `MetaConnectionPanel` (CRM Settings) now confirms before disconnecting, with the same wording as the full Meta screen — and both now state that lead forms are released, which is new since M-H8. | the two screens no longer disagree about a destructive action |

### Taken after that: the last production-relevant finding, and two coverage gaps

| ID | Change | Verified |
|---|---|---|
| **M-M8** | `POST /meta/sync` has its own throttle bucket, `META_SYNC_LIMIT` (6/minute per user, env-tunable). It is the one endpoint whose cost is charged somewhere else: each call fans out to one Graph request per connected form, and Graph limits are **per app**, so one person holding down Sync spent a budget every other agent drew from — and the failures landed on them. Six a minute is one every ten seconds, against a scheduler that already polls every fifteen minutes. | source-text guard in `rate-limits.spec.ts`, plus a browser test that fires nine calls and requires a 429 by the seventh. Removing the decorator fails both |
| **coverage** | `data-deletion` had **no coverage of any kind** — no runtime probe, no spec — despite being publicly reachable, erasing a user's stored Meta tokens, and being a callback App Review commonly exercises. Now 7 tests. | removing the HMAC comparison fails the two forgery tests: a forged signature, and a signature copied from a different payload onto a victim's |
| **coverage** | The Meta screen had **no browser test at all**. Now rendered for agent, admin and Super Admin, asserting on `pageerror` rather than only on the visible boundary — a crash still renders something. | 6 tests |

**Honest limitation on M-M8.** It is keyed per user, like every bucket in `rate-limits.ts`, so it
bounds one person rather than the brokerage: twenty agents at six a minute is still 120 calls a
minute against one app budget. Bounding the app as a whole needs a shared counter rather than a
per-identity one, which is a different mechanism. This closes the runaway case, which is the one
actually observed.

### The two that were left, after the module was called ready

| ID | Change | Verified |
|---|---|---|
| **M-M8+** | A Graph budget the whole brokerage shares, in `meta_api_budget`. `META_SYNC_LIMIT` bounds one person; Meta enforces per **app**, so twenty agents each within their own allowance still add up, and every agent then sees failures none of them caused. Charged per lead form before the fan-out, so a refusal costs nothing. The scheduled pass is charged too — exempting the larger, more predictable half would make the ceiling meaningless. | 4 tests: two agents draw down one allowance, a spent window refuses and says when it resets, and a sync stops before touching Graph |
| **token death** | An expired or revoked token is recorded the moment Meta says so (codes 190/102/463/467), the agent is emailed once per `META_RECONNECT_NOTICE_HOURS`, the remaining forms are not attempted, and the scheduler stops polling until somebody reconnects. Rate limits and permission errors are explicitly **not** treated this way. | 6 tests, including one asserting a 4/10/100 error does not pause collection |

**Why this mattered more than its severity suggested.** The failure was already recorded on the
connection and shown on the Meta screen — and nowhere else. An agent not looking at that screen saw
only an absence of leads, which is indistinguishable from a quiet week, while the brokerage went on
paying per click. Meanwhile the scheduler retried the dead credential every fifteen minutes for
ever, one Graph call per connected form, charged to the budget the working agents share.

**The connection is paused, not disconnected.** Forms stay claimed and reconnecting restores service
without anybody re-choosing pages and forms. Deleting somebody's setup because a token aged out
would be a far worse answer than pausing.

**Two precision traps found while building it**, both the same shape and both worth remembering:

- `timestamp without time zone` is written by the **raw driver in local time** and read back by
  Prisma's model API as **UTC**. The budget's window key resolved to two different rows, so the
  counter never incremented while reporting that it had. Fixed by making the window an integer
  bucket — epoch milliseconds — which has no timezone at all.
- `Timestamp(0)` **rounds** rather than truncates, so stamping a dead token at `now` stored a time up
  to half a second in the **future**, and every "has this expired?" check answered no. Stamped two
  seconds in the past instead.

**A note on M-M2's failure mode.** `redeem` returns false when the insert fails for *any* reason, not just a duplicate. A redeem that cannot be recorded is one that cannot be proven single-use, and the safe answer to "is this a replay?" when we do not know is yes. The cost is a failed connect the user can retry; the alternative is a guarantee that is not enforceable.

**M-M2 adds a table.** `20260802200000_meta_oauth_nonces` — additive `CREATE TABLE`, no backfill. It is classified `GLOBAL` in `tenancy.spec.ts`: scoping nonces per tenant would let one nonce be redeemed once in each brokerage, which is the replay it exists to prevent.

## A decision recorded

The first attempt at M-H3 delivered a shared form's lead to **every** agent who had connected it. That
was corrected on instruction: each agent connects their own Meta account, their own Page and their own
lead forms, and receives their own leads. **Nothing is shared.** So the collision is a
misconfiguration to prevent, not a case to handle — which is why it is now refused at connect time
and at the database rather than fanned out.

## Verification

- 8 service probes pass, covering M-C1…M-H7 plus two regression guards (matching still works inside
  a book; a released form can be re-claimed).
- `meta-offboarding.spec.ts` — 4 tests for M-H8, against the real service and the real index.
- Server suite **601 passed**, 1 pre-existing unrelated failure (`reminder-sweep.spec.ts`). The
  total is lower than the 605 reported mid-remediation because the eight throwaway probe tests were
  removed once their findings were covered properly; M-H8 is exactly why four of them should have
  been written as specs in the first place.
- Typecheck clean (server and client); build clean.
- New settings documented in `.env.example`.

**A defect found while building the departure rules, worth carrying elsewhere.** The obvious way to
express "not one of the agent's own Meta leads" — `source: { not: 'facebook_meta' }` — compiles to
SQL `!=`, and a comparison against NULL is NULL rather than true. Every lead with **no source
recorded** therefore failed the test, counted as personal, and would have stayed with a departing
agent for ever. 18 live leads in the development database had a NULL source. It was caught by the
pre-existing `core/lead-transfer.spec.ts`, whose fixtures do not set a source — a test written for
another purpose entirely. The predicate now lives in one place, `brokerageLeadWhere()`. Anywhere
else in this codebase that filters on an optional column with `not` deserves the same look.

**A note on how M-H8 was missed.** It was not missed by the audit — it was *introduced into the
record* by a bad verification of M-H3, which reported a hand-over working when the code could not
perform one. The probe rebuilt `disconnect()` in SQL instead of calling it. Every claim in the Fixed
table above that rests on a probe rather than a test has the same exposure, which is why M-H8's row
cites a spec that was checked in both directions: it fails without the fix and passes with it. The
rule this leaves behind — **exercise the entry point the user reaches, never a reconstruction of
it** — is worth more than the fix.

## Still open

**M-M1 through M-M5 are fixed** — see the table above. What remains is MEDIUM/LOW housekeeping, none
of it a lead-loss or cross-book risk:

| ID | Still open | Why it can wait |
|---|---|---|
| **M-M6** | `adAccounts` / `selectAdAccount` are not wrapped in `wrap()` | A Graph failure surfaces as a 500 rather than Meta's own message. Ugly, not wrong. |
| **M-M7** | `toggleForm` validates the page but not the form | Traced end to end: a bogus `form_id` must be paired with the caller's own `page_id`, which makes a different index key, so no collision. Sync then fails at Graph with an error line and the webhook never matches it. **Noise, not misrouting.** |
| **M-M9** | `meta_webhook_events.company_id` is nullable | Now less exposed than it was: M-M1 scopes the read by the caller's own forms, so a null tenant no longer implies a cross-book read. |
| **M-M10** | `custom_fields` unbounded | Superseded in practice by the per-answer and whole-map caps added under M-H1. Worth closing the wording. |
| **M-L1…M-L6** | as recorded above | |

All four are cosmetic or already mitigated. **M-M8 is fixed** — it was the last one with production
consequences.

**What no local test can reach:** the real OAuth round trip, a genuine webhook delivery from Meta,
and Graph's own rate-limit responses. The first is being exercised against a live Meta app for the
first time now.

**Token expiry has moved off that list.** It used to be the one that would fail quietly, because
nothing had observed what happens when a long-lived token runs out. What Meta *sends* still cannot
be produced locally, but everything downstream of it now can: the failure is injected as the
`GraphError` Meta would raise, and the resulting behaviour — expiry recorded, one email, remaining
forms skipped, polling paused, resumed on reconnect — is asserted end to end. The remaining
unknown is narrow: whether Meta answers with code 190 rather than one of the other three the
classifier accepts.

**Revised status: 41 → 95.** No CRITICAL or HIGH findings remain, and no MEDIUM finding with
production consequences.

The last step, 88 → 93, is the five MEDIUM findings taken before production: the module's only
unscoped read is scoped, the OAuth replay guarantee is real rather than best-effort, the fallback
signing key is gone, the raw payload is bounded and forgotten, and the same destructive button now
behaves the same way on both screens.

The move from 82 to 88 is M-H8 and M-H9 — the two found *after* the first remediation was called
complete, both on the same theme: what happens to a Meta integration when the agent behind it goes
away. Neither was visible from the code alone. Both came from walking a real departure through the
running system and asking what the next person would see.
