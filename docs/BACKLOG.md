# Deferred work

Findings that were raised, understood and consciously **not** fixed yet. Each records why it was
safe to defer and what would make it urgent — so a decision to wait stays a decision rather than
quietly becoming an oversight.

Anything actually blocking release belongs in the module audits under [`audit/`](audit/), not here.

---

## Done

### B-5 — A departed agent's Meta forms keep collecting leads nobody can see — **DONE 2026-08-02**

Decided and built rather than deferred. The open question was whether deactivating a user should
automatically disconnect Meta; product answered **yes**, together with the ownership rule that made
the rest of it answerable:

- **Meta leads are personal** — the agent's own account, Page, form and ad spend. They stay with
  that agent and are never transferred.
- **Everything else belongs to the brokerage** and returns to it automatically on deactivation,
  unowned, where a Super Admin can hand it on.
- **Meta is disconnected** on deactivation, and **not reconnected** on reactivation: tokens expire,
  permissions change, Pages are removed, passwords change, so the agent signs in to Meta again.

Written up in full in [`AGENT-DEPARTURE-POLICY.md`](AGENT-DEPARTURE-POLICY.md). Implemented in
`OffboardingService.depart`, `LeadTransferService.returnToBrokerage`, and a provenance rule in
`lead.constants.ts`; covered by `users/offboarding.spec.ts`.

**One defect found while building it, worth remembering.** The obvious way to write "not a Meta
lead" — `source: { not: 'facebook_meta' }` — is wrong: it compiles to SQL `!=`, which is NULL for a
NULL source, so every lead with no source recorded was treated as personal and would have stayed
with the departing agent for ever. 18 live leads in the development database had a NULL source. It
was caught by the pre-existing `core/lead-transfer.spec.ts`, whose fixtures do not set a source.
The rule now lives in one place, `brokerageLeadWhere()`, with the reasoning attached.

Original write-up follows.

---

### B-5 (original)

**Raised:** 2026-08-02 · **From:** confirming the Meta form-ownership rule · **Effort:** ~1 h of code;
the decision it depends on is an offboarding one

Deactivating a user does not stop their Meta intake. Nothing in the Users module or
`LeadTransferService` touches `meta_connections` or `meta_lead_forms`, and
[`meta-sync-scheduler.service.ts`](../server/src/meta/meta-sync-scheduler.service.ts) resolves the
owner with `users.findUnique({ where: { id } })` — which returns a deactivated account exactly as it
returns an active one. So the poll keeps running, leads keep being created against the departed
agent, and **nobody can see them**: visibility is per person (B-A1), the departed agent cannot sign
in, and a Super Admin sees unattributed intake (`owner_user_id IS NULL`), not leads owned by a
specific person.

Transferring the book moves what already exists but not the connection, so new arrivals keep landing
in the same invisible place. That is the trap — the visible backlog moves and the pipeline keeps
filling behind it.

**Why it is not simply a bug to fix.** Skipping inactive users would stop the leads arriving at all,
which is not obviously better than arriving unseen — the brokerage has still paid for those clicks.
The reasonable behaviours are: deactivate the Meta connection when the user is deactivated; or route
arrivals to the successor named in the transfer; or leave the poll running and surface the connection
on an admin screen. Which is right depends on how offboarding actually runs here.

**Why deferring is safe.** The documented procedure closes it today —
[`META-LEAD-FORM-POLICY.md`](META-LEAD-FORM-POLICY.md) makes disconnecting Meta step one of
offboarding, ahead of the book transfer. This entry exists because a procedure nobody reads is not a
control.

**Half of this was a real defect and is fixed.** Following the procedure did not previously work:
`disconnect()` never deactivated the agent's lead forms, so the successor at step 3 was refused and
the form was locked to the departed agent for good. Fixed on 2026-08-02 in
`meta-connection.service.ts`, covered by `meta-offboarding.spec.ts`. What is left in this entry is
only the automation question — nothing *makes* anyone perform step 1.

**What makes it urgent.** The first actual departure of an agent who had Meta connected.

---

### B-4 — Calendar AI suggestions ungated, unrecorded and unsanitised — **DONE 2026-08-02**

Implemented rather than deferred once it was asked for. All three findings closed:

- **AI-2a, the gate.** `assertAiFeatureEnabled('calendar-followup-suggestions')` runs before the
  provider is even resolved, so "nobody has agreed to send client notes to a model" is answered
  before "no API key is configured" — they are different problems and the second is the wrong
  instruction to give when the first is true.
- **AI-2b, the record.** Every request writes an audit entry through the new shared
  `AiDisclosureService`, naming the provider, the model, and **which fields were actually populated**
  this time — an appointment with no notes discloses less than one with them, and a trail that could
  not tell those apart would be describing the feature rather than the request.
- **AI-2c, injection.** Every free-text field is passed through `safeForPrompt` with a per-field cap,
  the record is wrapped in `<record>` … `</record>`, and the system prompt states that everything
  inside is data and any instruction found there is to be ignored.

`safeForPrompt` moved from `lead-activity.service.ts` into `common/ai-provider.ts` rather than being
copied — this codebase has been bitten before by two copies of one idea drifting apart.

Both AI features now record through one writer under `category: 'AI'`, because "what has this
brokerage sent to AI vendors, and about whom" is asked from outside any module and has to be
answerable from one place.

Original write-up follows.

---

### B-1 — Paginate the lead recycle bin — **DONE 2026-08-01**

Implemented rather than deferred. `GET /api/leads/deleted` now takes `page`/`limit` and returns
`meta` in the same shape as the live list; the Recycle Bin modal has a pager. Ordering is
tie-broken by `id` so rows cannot swap pages between requests. Covered by five tests in
`e2e/tests/leads-part2.spec.ts`, including clamping of nonsense `limit`/`page` values and the
scope rule still holding.

Original write-up follows.

---

### B-1 (original)

**Raised:** 2026-08-01 · **From:** CRM › Leads audit, finding M-3 · **Deferred by:** product
**Effort:** ~2 h

[`leads.service.ts`](../server/src/leads/leads.service.ts) returns deleted leads with `take: 200`
and no paging:

```ts
const where = { deleted_at: { not: null }, ...this.scopeWhere(user) };
this.prisma.leads.findMany({ where, orderBy: { deleted_at: 'desc' }, take: 200 })
```

Past 200 soft-deleted leads, the oldest silently drop off the end. The rows are still in the
database and recoverable by an administrator with SQL, but **not by the user whose leads they
are** — and nothing on screen says anything is missing, which is the part that makes it a trap
rather than a limit.

**Why deferring is safe.** Production currently holds **zero** soft-deleted leads. There is no
automatic purge, so the count only rises through deliberate deletion.

**What makes it urgent.** Any of:
- soft-deleted leads approaching ~150 (check: `SELECT count(*) FROM leads WHERE deleted_at IS NOT NULL`)
- a bulk delete of any size, which can cross the threshold in one action
- lead retention obligations being implemented, since a purge job would move rows through this list

**When doing it:** paginate the same way the live list does (`page`/`limit`, `MAX_PER_PAGE`) and
return `meta` so the UI can show a pager. Worth adding a count to the screen regardless — "showing
200 of N" would have made the cap visible without any of this work.

**Related:** the same 200-row cap should be checked on any other recycle-bin-style list before it
is assumed to be leads-only.

---

## Open

### B-2 — `assertTransaction` answers 403 where it should answer 404 — **deferred to the Transaction Desk audit**

**Raised:** 2026-08-02 · **From:** CRM module audit, finding M-2 · **Deferred by:** product
**Effort:** ~2 h, plus updating the specs that assert the current behaviour

[`resource-access.service.ts`](../server/src/core/resource-access.service.ts) answers a missing
transaction with 404 and an existing-but-forbidden one with 403. The status code therefore reveals
which transaction ids are real to anyone who can sign in — walk a range, and 403 means "this deal
exists and is not yours".

Its own doc comment already states the rule it breaks:

> A missing transaction is a 404 whether or not the caller could have seen it — the answer to
> "does deal 812 exist?" must not depend on who is asking, or the error code becomes a way to
> enumerate other people's deals.

That is applied to the *missing* branch and not to the *forbidden* one.

**The identical defect in `assertLead` was fixed on 2026-08-02** — both branches now throw one
shared `NotFoundException`, and `ownership.spec.ts` asserts the two responses are byte-identical
rather than merely both errors. The same three-line change applies here.

**Why it was safe to defer.** It discloses existence and id range, not content: `assertTransaction`
still refuses the request, so no deal data is returned. It is an information leak, not a data leak.
It also predates this work rather than being introduced by it.

**Why it was deferred rather than done.** Changing it alters Transaction Desk API responses and the
specs that pin them (`resource-access.spec.ts` asserts `ForbiddenException` in several places, and
the chat-thread tests depend on it), which is outside the CRM module the audit covered. Doing it
blind, without auditing what else reads those status codes, is how a security fix becomes an outage.

**What would make it urgent.** Any sign of id enumeration against `/api/transactions/:id` or the
endpoints hanging off it, or a compliance requirement that deal existence be confidential between
agents — the equivalent of the CRM's per-person lead visibility (see B-A1) applied to deals.

**When it is picked up:** mirror the `assertLead` fix exactly — one `NotFoundException` instance
thrown from both branches, so the message cannot drift apart — and add the "answers the same way
whether or not it exists" assertion to `resource-access.spec.ts`.

### B-3 — FINTRAC identity documents are sent to an AI provider, ungated and unrecorded — **deferred to the FINTRAC audit**

**Raised:** 2026-08-02 · **From:** [`AI-PRIVACY-REVIEW.md`](AI-PRIVACY-REVIEW.md), finding AI-3
**Effort:** ~2 h of code. The decision it depends on is not an engineering one.

[`id-extraction.service.ts`](../server/src/fintrac/id-extraction.service.ts) base64-encodes the
**complete image or PDF of a government identity document** — passport, driver's licence, provincial
ID — and posts it to `api.anthropic.com` to read the fields off it for Form 630. Not extracted text:
the document, including the photograph, the document number, the date of birth and the home address.

It runs whenever `idExtraction.apiKey` is configured. Nothing switches it on deliberately and
**nothing anywhere records that a given client's passport was transmitted to a third party** — not
the audit trail, not the FINTRAC records the upload exists to satisfy.

This is the most sensitive disclosure the application makes. The equivalent-but-far-smaller
disclosure in the CRM (a lead's first name, for email drafting) was gated and audited on 2026-08-02;
this one was found by the same review and is larger by a wide margin.

**Why it was deferred rather than done.** FINTRAC is outside the CRM module the audit covered, and —
more to the point — the code change is the easy half. Sending identity documents to a processor
outside the brokerage should be reflected in what clients are told when their ID is collected, and
covered by the agreement with the provider. That is a decision for whoever owns the privacy policy.

**Deferred by product on 2026-08-02** to the Transaction Desk work, on the grounds that FINTRAC and
Form 630 belong to that module. Agreed. It will be picked up alongside **B-2**, which is deferred to
the same audit.

### Interim mitigation — READ THIS, the obvious version does not work

The natural reading of "leave the AI key for that feature unset" is that ID extraction has its own
key. **It does not.** `config/configuration.ts` resolves it as:

```ts
idExtraction: {
  provider: process.env.ID_EXTRACTION_PROVIDER ?? 'anthropic',
  apiKey:   process.env.ANTHROPIC_API_KEY ?? '',      // ← the SHARED key
  model:    process.env.ID_EXTRACTION_MODEL ?? 'claude-sonnet-5',
}
```

`ANTHROPIC_API_KEY` is the same variable `resolveEmailAi()` reads for lead email drafting and
calendar suggestions. So **setting that key to enable AI email drafting silently re-enables passport
uploads** — and email drafting is now gated and audited, which makes turning it on a reasonable
thing to want to do. The mitigation and the feature you would most likely enable are in direct
conflict, and nothing on screen would say so.

Three configurations, checked by running `IdExtractionService` with `fetch` stubbed to record
whether the document was transmitted:

| Configuration | Document transmitted? |
|---|---|
| `ANTHROPIC_API_KEY` unset | **no** — `configured: false`, blank fields, manual entry |
| `ID_EXTRACTION_PROVIDER=disabled`, key present | **no** — same graceful degradation |
| Both set (the default the moment any Anthropic key exists) | **YES** |

**Recommended interim setting:** `ID_EXTRACTION_PROVIDER=disabled`. The guard is
`if (provider !== 'anthropic' || !key) return blank`, so any value other than `anthropic` stops it
before the network call — and it leaves `ANTHROPIC_API_KEY` free for the two features that are now
gated properly. Leaving `ANTHROPIC_API_KEY` unset also works, but costs you Anthropic for everything
else (OpenAI or Gemini keys would still serve the other two).

**When it is picked up, fix the config too.** A feature this sensitive sharing its credential with
unrelated features is the root of this trap: give it `ID_EXTRACTION_API_KEY` with no fallback, so
"unset the key for that feature" means what a reader expects it to mean.

**When it is picked up:** `assertAiFeatureEnabled('fintrac-id-extraction')` at the top of
`extractIdFields`, plus an audit entry naming the client whose document was sent. The catalogue
entry and the switch (`AI_ID_EXTRACTION`) already exist in
[`ai-consent.ts`](../server/src/common/ai-consent.ts); it is three lines and an audit call.

## Accepted, not to be "fixed"

### B-A3 — A calendar is private to its owner, with no exception for any role

Nobody sees another person's appointments — not a colleague, not a manager, not an admin, not a
Super Admin. Stated by the business on 2026-08-02 when a team/brokerage calendar reporting view was
proposed and **declined outright**: each user sees only their own events.

This is stricter than the equivalent rule for leads (B-A1), where a Super Admin can at least recover
an unowned book. There is no such escape hatch here and none is wanted.

**Why it is worth recording rather than leaving to the code.** The scope is `user_id` with no role
branch anywhere in `src/calendar/`, so it holds today — but "just an oversight view for managers" is
a one-line change that arrives later looking reasonable. `calendar-analytics.spec.ts` now pins it
for agent, manager and admin; injecting a role override fails the admin case.

**What was declined, specifically:** a per-person workload report — appointment counts, kept and
no-show rates, occupied hours — with no titles, client names or addresses. Even that much was
refused, so a drill-down to actual appointments is further out of scope again.

### B-A2 — One Meta Lead Form belongs to exactly one agent

Each agent connects their own Meta account, their own Page and their own forms. Forms are not shared
and are not transferable between CRM users; a duplicate Form ID is refused at connect time and by a
partial unique index. Stated by product on 2026-08-02 and documented — including what it deliberately
rules out (team forms, office-wide intake, handing a form over) — in
[`META-LEAD-FORM-POLICY.md`](META-LEAD-FORM-POLICY.md).

Recorded here because "two agents cannot both connect this form" reads like a limitation to fix. It
is the fix: routing one form to several people is what let the webhook pick an owner arbitrarily, so
one agent received every lead and the other received none while their screen showed the form as
connected.

### B-A1 — Lead visibility is per-person, not per-role

No role, at any rank, reads a colleague's book. Accepted by the business on 2026-08-01 and
documented in full — including the operational consequences for oversight, compliance and agent
departure — in [`LEAD-PRIVACY-POLICY.md`](LEAD-PRIVACY-POLICY.md).

Recorded here so that a future reader who finds it surprising is pointed at the reasoning rather
than "correcting" it.
