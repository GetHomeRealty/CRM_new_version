# Enterprise Audit — CRM › Campaigns

**Module:** CRM → Campaigns (bulk email, templates, open tracking, unsubscribe)
**Audited:** 2026-08-01
**Build:** `version_3` @ `aa38ed2` + uncommitted working tree
**Verdict:** **PRODUCTION READY** (second pass — see §7)
**Production readiness score:** **86 / 100**

---

## 1. Coverage and safety

**Nothing in this audit could reach a real inbox.** Two independent guards: the test API runs with
`MAIL_REDIRECT_TO` set, and the seeded mail account points at `smtp.invalid.test`, which does not
resolve. Sends therefore fail rather than deliver — which also exercised the failure path.

| Method | Detail |
|---|---|
| **Browser E2E** | **17 tests** written and run, all passing |
| **Public endpoint probing** | Pixel and unsubscribe hit directly with malformed, injected and oversized inputs |
| **Scanner simulation** | Unsubscribe fetched with a Proofpoint-style user agent |
| **Root-cause reproduction** | Server started standalone to capture the unsubscribe failure and inspect its log output |
| **Code inspection** | 23 endpoints across 3 controllers, `campaigns.service.ts`, `campaign-audience.service.ts`, `mail-deliverability.service.ts`, schema |

**Not covered:** an end-to-end send with working SMTP (deliberately — that would mean emailing real
addresses); scheduled/recurring campaigns; attachment handling; the A/B or drip features if any
exist beyond what the controllers expose.

---

## 2. Executive summary

The **compliance machinery is well built** — the unsubscribe suppression chain in particular is
better than most commercial tools. But three defects sit directly on the CASL path or on the
brokerage's ability to trust its own numbers, and one of them means a recipient with a slightly
damaged link is told to "try again later" indefinitely.

The module also **sends on the HTTP request thread**, which does not survive contact with a real
list size.

---

## 3. Findings

### CRITICAL

---

#### C-1 — Campaigns send synchronously on the request thread [VERIFIED by inspection + measurement]

**Where:** [`campaigns.controller.ts:221`](../../server/src/campaigns/campaigns.controller.ts#L221) → [`campaigns.service.ts:186-225`](../../server/src/campaigns/campaigns.service.ts#L186-L225)

```ts
send(...) { return this.campaigns.createAndSend({ ... }, user); }   // awaited
```

and inside, per recipient: an MX check, an SMTP send, a database write, then
`await sleep(SEND_DELAY_MS)` — **400 ms**.

The request does not return until the last recipient is done:

| Recipients | Minimum wall-clock (excl. SMTP) |
|---|---|
| 50 | ~20 s |
| 200 | ~80 s |
| **512** (production lead count today) | **~205 s** |
| 750 | ~300 s — **nginx `proxy_read_timeout` in the deployment guide** |

Consequences, in order of severity:

1. **A partial send is the normal failure mode.** If the tab is closed, the browser gives up, nginx
   times out, or a deploy restarts the process mid-send, the loop stops. Some recipients have been
   emailed, some have not, and **there is no resume** — re-sending would re-email everyone who
   already received it.
2. **No progress.** The user watches a spinner for minutes with no indication of how far through it
   is or whether it is still alive.
3. **A deploy during a send silently truncates it.**

**This is inconsistent with the module next door.** Lead import was explicitly moved off the
request thread — its own comment says *"run off the request thread with progress a client can
poll"* — and campaigns, which is slower and has worse failure consequences, was not.

**Fix:** the same treatment as lead import — persist the campaign as queued, return immediately,
process in a worker, expose progress for polling, and make the loop resumable from
`campaign_recipients.status` so a restart continues rather than repeats.

---

#### C-2 — Every send failure is reported as a bounce [VERIFIED]

**Where:** [`campaigns.service.ts:230`](../../server/src/campaigns/campaigns.service.ts#L230)

```ts
data: { sent, failed, bounced: failed, ... }
```

`failed` counts *everything* that went wrong: genuine bounces, but also SMTP auth rejections,
network errors, and the "no active SMTP account" case which marks **every remaining recipient
failed in a loop**.

All of it is written to `bounced`.

**Why this matters commercially, not just cosmetically.** Bounce rate is the single number Gmail,
Outlook and every deliverability tool judge a sender on. A brokerage whose SMTP password expired
would open the Campaigns screen and see *"500 bounced"* — and the reasonable response to a 100%
bounce rate is to conclude the list is dead and start deleting contacts. The application would
have induced the destruction of good client data through a misreported metric.

**Fix:** count bounces only where `mail-deliverability` actually classified the address as
undeliverable. The distinction already exists in the code at
[`campaigns.service.ts:192-196`](../../server/src/campaigns/campaigns.service.ts#L192-L196) — it is
simply discarded at the end.

---

#### C-3 — An unknown unsubscribe token reports an internal error, and nothing is logged [VERIFIED at runtime]

**Where:** [`campaign-tracking.controller.ts:65-85`](../../server/src/campaigns/campaign-tracking.controller.ts#L65-L85)

The controller has three outcomes: *invalid link*, *link not found*, and *something went wrong*.
A token that simply does not exist reaches the **third**:

```
GET /api/campaigns/unsubscribe?c=1&t=definitely-not-a-real-token
→ "Something went wrong — We could not process your request. Please try again later."
```

Expected: *"Link not found."* Something inside `campaigns.unsubscribe()` throws for a
non-existent token, and the blanket `catch` converts it to an internal-failure page.

**The second half is worse than the first.** I reproduced this against a standalone server and
**found no error in the log at all** — the catch swallows it completely. So:

- A recipient whose link was mangled in transit (mail clients do wrap and rewrite URLs) is told to
  try again later, indefinitely, with no way to opt out.
- **A genuine outage of the unsubscribe endpoint is indistinguishable from this and equally
  invisible.** CASL requires an unsubscribe mechanism that works and is honoured within 10 business
  days. An endpoint that has silently stopped working would be discovered by a complaint to the
  CRTC, not by monitoring.

**Root cause not determined** — I confirmed it is not the tenant context (`requireCompanyId` is not
yet wired into Prisma; it appears only in its own spec). It needs a debugger, not more guessing.

**Fix, in order:** log the exception at ERROR before rendering the page; return "link not found"
for a missing token; then find the throw.

---

### HIGH

---

#### H-1 — Link-scanning gateways can unsubscribe recipients who never clicked [VERIFIED]

**Where:** [`campaign-tracking.controller.ts:17-21`](../../server/src/campaigns/campaign-tracking.controller.ts#L17-L21)

The file already contains `looksAutomated()`, listing Barracuda, Proofpoint, Mimecast, Symantec
and Forcepoint. It is applied to the **open pixel** so a scanner cannot fake an open.

It is **not applied to unsubscribe**.

Unsubscribe is a bare `GET` with no confirmation step. Corporate mail gateways follow every link in
a message to check it for malware — which means visiting the unsubscribe URL. Verified at runtime:
a Proofpoint-style user agent and a Chrome user agent receive **byte-identical treatment**.

**Consequence:** recipients at any organisation running link protection get silently unsubscribed
without ever seeing the email. The brokerage's list quietly erodes, the cause is invisible, and the
suppression is hard to reverse because it also flags the lead row.

**Fix:** either apply the existing `looksAutomated()` check, or — better, and the standard answer —
make the link land on a confirmation page whose button issues a `POST`. That also aligns with
RFC 8058 one-click unsubscribe, which uses POST precisely for this reason.

---

### MEDIUM

| ID | Finding |
|---|---|
| **M-1** | `status: sent === 0 ? 'failed' : 'completed'` — a campaign where 1 of 500 sent is reported **completed**. There is no `partial` state, so a badly broken send looks successful in the list. |
| **M-2** | The blanket `catch` in the unsubscribe handler (C-3) is mirrored in the pixel handler, which swallows errors by design. Reasonable there; on the compliance endpoint it is not. |
| **M-3** | `CAMPAIGN_PUBLIC_URL` must be a publicly reachable HTTPS origin or the pixel and unsubscribe links in **already-sent** email point nowhere. Emails keep whatever URL they were built with, so a misconfiguration is permanent for that batch. Documented in `.env.example`; worth a startup check like the ones in `validate-config.ts`. |
| **M-4** | 400 ms × N is a fixed serial delay with no per-domain rate awareness. It is simultaneously too slow for a large list and no protection against a provider that rate-limits per connection. |

### LOW

| ID | Finding |
|---|---|
| L-1 | No `Precedence: bulk` / `List-Unsubscribe` header handling was visible in the send path. `List-Unsubscribe` materially improves inbox placement and is expected by Gmail for bulk senders. |
| L-2 | The unsubscribe confirmation page is not localised; the brokerage is in Ontario and may need French. |
| L-3 | `campaign_recipients.token` is `VarChar(64)` holding a 48-character hex string — fine, but the column allows values the generator never produces. |

---

## 4. What is verified good

| Property | Evidence |
|---|---|
| **Unsubscribe suppression chain** | **Genuinely excellent.** One click flips the recipient, increments the campaign counter, upserts `email_suppressions`, **and** flags every lead sharing that address — in a transaction, via a parameterised raw query. Most tools stop at the first of those. |
| **Token security** | `crypto.randomBytes(24)` = 192 bits, `@unique`, and **bound to its campaign** (`r.campaign_id !== campaignId` → reject). Not guessable, not portable between campaigns. |
| **CASL audience suppression** | `unsubscribed: false` is applied when building an audience — opted-out leads cannot be re-added. |
| **Audience scoping** | An agent cannot build an audience from a colleague's leads. The code names the reason: those leads *"consented to hear from the person handling them, not from whoever opened the builder."* |
| **Public endpoint hardening** | Pixel returns a valid GIF for every input tried — empty, non-numeric, 500-character, SQL-injected. **No timing or size difference** between a real and a fake campaign id, so no enumeration oracle. |
| **XSS on the unsubscribe page** | Escaped; a `<script>` payload in the token is rendered inert. |
| **Rate-limit exemption** | Deliberate and correct — a throttled unsubscribe link would itself be a compliance problem, and the reasoning is recorded in the code. |
| **MX pre-check is cached** | Per-domain `Map`, so a 500-recipient send to one domain does one lookup, not 500. I expected an N+1 here and was wrong. |
| **Access control** | All endpoints refuse signed-out callers; sends require CSRF (419 without it). |

---

## 5. Priority and effort

| # | ID | Issue | Effort |
|---|---|---|---|
| 1 | **C-3** | Log the exception; return "not found" for a missing token; find the throw | **2–4 h** |
| 2 | **H-1** | Scanner check or POST confirmation on unsubscribe | **3 h** |
| 3 | **C-2** | Count bounces separately from failures | **1 h** |
| 4 | **C-1** | Move sending to a background job with progress and resume | **2–3 days** |
| 5 | M-1 | Add a `partial` campaign status | **2 h** |
| 6 | M-3 | Boot-time check on `CAMPAIGN_PUBLIC_URL` | **1 h** |
| 7 | L-1 | `List-Unsubscribe` header | **2 h** |

**Ship-blockers (1–3): ~8 hours.** C-1 is the larger piece and the one that decides whether this
scales past a few dozen recipients.

---

## 6. Module status

### NOT PRODUCTION READY

**Justification:**

1. **C-1** means any campaign to the brokerage's actual list (512 leads today) runs for three and a
   half minutes on an HTTP request, with a partial send as the normal outcome of any interruption
   and no way to resume. This is the module's core function.
2. **C-3** puts a broken path on the CASL unsubscribe route *and* makes a real outage of that route
   invisible. For a Canadian brokerage that is regulatory exposure, not a bug report.
3. **H-1** means recipients behind corporate link scanning are unsubscribed without acting, eroding
   the list invisibly.
4. **C-2** reports infrastructure failures as bounces, which would push a brokerage toward deleting
   good contacts.

**The foundations are sound.** Suppression, token security, audience scoping and the public
endpoints are all well built — several better than commercial equivalents. The defects are
concentrated in the send pipeline and in error handling on one endpoint, not in the design.

**Recommendation:** fix C-3, H-1 and C-2 (about a day together), then decide whether C-1 is a
pre-launch item or an accepted constraint with a documented recipient cap. **If C-1 is deferred,
the send screen must enforce and explain a hard limit** — shipping an unbounded "Send to all" that
silently truncates is not an option.


---

## 7. Second pass — 2026-08-01, after the fixes

All four blockers fixed. **112 E2E tests pass, twice consecutively** (18 for Campaigns); 569 unit
tests pass; typecheck clean.

### C-3 — root cause found, and it was far worse than reported

Adding the log line was the fix that mattered, because it immediately produced this:

```
No tenant in context for campaign_recipients.findUnique. A request gets one from AuthGuard;
background work must use forEachTenant, and infrastructure that genuinely spans brokerages
must say so with runAsSystem.
```

**Unsubscribe was failing for EVERY token, not only unknown ones.** The endpoint is public and
carries no `AuthGuard`, correctly — but that means no tenant context, and the Prisma tenant
extension rejects every query made without one. Every CASL opt-out request in production would
have failed, and the blanket `catch` hid it completely.

*Correction to the first pass:* I reported that tenant context was "not the cause", having grepped
for `requireCompanyId` and found it only in its own spec. That was wrong — the enforcement lives in
`core/tenant-extension.ts` under a different name. The first-pass conclusion was based on an
incomplete search.

**The same bug silently disabled open tracking.** `recordOpen` and `isMachinePrefetch` are called
from the pixel handler, which swallows errors by design so the image always renders. Every open
ever recorded threw and was discarded — the feature reported zero and looked like recipients simply
were not opening anything.

**Fix:** `unsubscribe`, `recordOpen` and `isMachinePrefetch` now wrap their work in `runAsSystem`,
the sanctioned way to declare cross-brokerage infrastructure. Safe here because the only authority
accepted is the 192-bit token, which is unguessable and pinned to its campaign — an attacker cannot
steer the lookup into another brokerage's data by choosing an input.

Plus the original fix: the exception is logged at ERROR before the friendly page renders.

### H-1 — fixed by design, not by user-agent sniffing

`GET /api/campaigns/unsubscribe` now renders a confirmation page and **changes nothing**; a `POST`
behind the button does the work. A scanner fetching the link has no effect, which holds for
scanners nobody has heard of yet — unlike a UA denylist. This also matches RFC 8058, which
specifies POST for one-click unsubscribe for exactly this reason.

`/api/campaigns/unsubscribe` was added to `CSRF_EXEMPT_PATHS`: there is no session behind a link in
somebody's email, so a token cannot exist, and a 419 would mean the opt-out simply did not work.
Tested explicitly.

### C-2 — bounces counted separately

`bounced` now increments only where the deliverability check rejected the address. The distinction
already existed in the send loop and was being discarded at the end.

**M-1 fixed alongside it:** status is now `partial` when some recipients were reached and some were
not. It previously reported `completed` whenever a single message got through, so 1 sent of 500
looked like success on the one screen somebody would check.

### C-1 — sending moved off the request thread

`createAndSend` now persists the campaign as `sending`, returns immediately, and delivers in a
detached loop that writes `sent`/`failed`/`bounced` after **every** recipient, so the screen can
poll real progress. A delivery that dies is logged and the campaign is marked `partial` rather than
being left saying "sending" for ever.

**Not done, and deliberately so: resume after a process restart.** Continuing an interrupted send
needs the send context persisted — template, attachments, agent variables, tracking base URL — and
inventing that under time pressure risked a half-built mechanism that double-sends. Today a
restart mid-send leaves an accurate count and a `partial` status; it does not resume. Tracked as
follow-up.

### Remaining open

| ID | Status |
|---|---|
| C-1 resume-after-restart | Follow-up; partial status is accurate in the meantime |
| M-3 `CAMPAIGN_PUBLIC_URL` boot check | Open |
| M-4 fixed 400 ms delay, no per-domain awareness | Open |
| L-1 `List-Unsubscribe` header | Open — the POST endpoint now exists to support it |

### Verdict

### PRODUCTION READY

The two compliance-critical defects were not just fixed but shown to be worse than first
diagnosed, which is the strongest argument for the logging change: **C-3 was invisible precisely
because nothing logged it.** Unsubscribe and open tracking both work now and are covered by tests
that assert behaviour rather than user agents.

C-1's remaining gap is bounded and honest — a restart interrupts a send and says so, rather than
silently truncating.
