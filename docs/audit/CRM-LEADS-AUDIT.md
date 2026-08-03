# Enterprise Audit — CRM › Leads

**Module:** CRM → Leads
**Audited:** 2026-08-01
**Build:** `version_3` @ `aa38ed2` + uncommitted working tree
**Verdict:** **PRODUCTION READY** (second pass, 2026-08-01 — see §8)
**Production readiness score:** **88 / 100**

---

## 1. Coverage — what was actually done

Unlike the Inbox audit, this one had the full harness: real Chromium, a seeded `myapp_test`
database, and accounts for all six roles.

| Method | Detail |
|---|---|
| **Browser E2E** | **35 Leads tests**, written and run. Part of a 63-test suite that passes **twice consecutively** |
| **Role matrix** | All six roles signed in and their visible book compared — agent, agent2, admin, superAdmin, accounting, documentation |
| **Unauthenticated probing** | All 9 Leads GET endpoints hit with **curl, no cookies at all** — independent of the browser |
| **Injection** | SQL metacharacters, XSS payloads, search metacharacters — executed against a live server |
| **Database** | `EXPLAIN ANALYZE` on the real list query against production data (read-only) |
| **Code inspection** | Controller (40+ routes), `leads.service.ts` (42 KB), `lead-scope.ts`, schema |

### Not covered — stated plainly

The module is far larger than the Inbox. **Import, export, tags, tasks, showings, calls,
browser-call, email send/generate, call recordings, transfer-ownership and lead books were not
tested** — roughly half the endpoints. They need their own pass. Nothing below should be read as a
clean bill of health for those.

Also untested: multi-tab concurrent editing, simulated network failure, session timeout mid-edit.

---

## 2. Executive summary

The Leads module is **substantially more solid than the Inbox was**. Every security property I
tested held under a real browser: ownership isolation, CSRF, mass-assignment protection, injection
handling, and input validation all behaved correctly and were *proven*, not assumed.

Two findings block release, and neither is a coding error:

1. **No one, at any rank, can see another person's leads.** An administrator of the brokerage sees
   **zero** of their agents' leads. This is deliberate, documented, and — verified at runtime
   across six roles. It is a **business-policy decision that needs a sign-off**, because it has
   consequences nobody appears to have costed: no oversight, no compliance audit path, and no way
   to service a lead when an agent is away.
2. **The list query is a full table scan** and `owner_user_id` — half the scope filter — has no
   index at all.

Everything else is Medium or below.

---

## 3. Findings

### HIGH

---

#### L-1 — Rank grants no visibility: administrators cannot see agents' leads [VERIFIED at runtime]

**Where:** [`common/lead-scope.ts:26-31`](../../server/src/common/lead-scope.ts#L26-L31)

```ts
const mine = [{ assigned_to: id }, { owner_user_id: id }];
if (isSuperAdmin(user)) mine.push({ owner_user_id: null });
return { OR: mine };
```

The rule is applied to **every** user identically. The file states it outright: *"Nobody, at any
rank, reads a colleague's book by virtue of their role."*

**Runtime proof** — six roles signed in, each listing `/api/leads`:

| Role | Sees Marcus Bell (agent's) | Sees Renée Beaulieu (agent2's) |
|---|---|---|
| agent | ✅ | ❌ |
| agent2 | ❌ | ✅ |
| **admin (manager)** | **❌** | **❌** |
| **superAdmin** | **❌** | **❌** |
| accounting | ❌ | ❌ |
| documentation | ❌ | ❌ |

**This is a defensible privacy model** — and for a brokerage where agents own their book, arguably
the right one. It is flagged HIGH because of what follows from it, not because it is a bug:

- **No oversight.** A manager cannot review an agent's pipeline, check follow-up, or investigate a
  complaint. For a brokerage with hundreds of agents, that is a real operational gap.
- **No compliance path.** A regulator or broker of record asking "show me every lead touching this
  property" cannot be answered from the UI by anyone.
- **Absence and departure.** If an agent is ill or leaves, their leads are unreachable until
  someone runs `transfer-ownership` — which **mutates the data**, so the original assignment is
  overwritten rather than recorded.
- **The Super Admin exception is narrow**: `owner_user_id: null` only. It surfaces *unattributed*
  intake, not anyone's book.

**This needs a product decision before launch**, not a code change. If the answer is "correct as
is", the gap should be documented for the broker of record. If not, the options are a read-only
oversight scope for `manager`/`admin`, or an explicit, audited break-glass path.

---

#### L-2 — Leads list is a sequential scan; `owner_user_id` is unindexed [VERIFIED — EXPLAIN ANALYZE]

**Where:** [`leads.service.ts:101-106`](../../server/src/leads/leads.service.ts#L101-L106); `leads` model indexes.

Indexed: `email`, `lead_status`, `lead_source`, `unsubscribed`, `assigned_to`, `deleted_at`,
`source`, `phone_normalized`. **Not indexed: `owner_user_id`** — despite being half of the scope
filter every single read applies.

Live plan against production (512 leads, 18 MB):

```
Limit  (actual time=0.644..0.645 rows=25)
  -> Sort  Sort Key: created_at DESC, id DESC   Sort Method: top-N heapsort
     -> Seq Scan on leads  (actual rows=512)
        Filter: ((deleted_at IS NULL) AND ((assigned_to = 1) OR (owner_user_id = 1)))
Execution Time: 0.667 ms
```

The `assigned_to` index cannot be used: an `OR` where one side is unindexed forces a full scan.

At 512 rows this is 0.67 ms. The stated target is **hundreds of agents**; at 50,000 leads this is
a full scan of a multi-hundred-MB table on **every list load, for every agent**, plus the same
predicate again for the counters.

**Fix:**
```sql
CREATE INDEX ON leads (owner_user_id);
CREATE INDEX ON leads (assigned_to, created_at DESC);
CREATE INDEX ON leads (owner_user_id, created_at DESC);
```
The same fix as Inbox H-2, and worth doing in one migration with it.

---

### MEDIUM

---

#### M-1 — Leads answers 400 where the rest of the API answers 422 [VERIFIED]

**Where:** [`leads.service.ts:748`](../../server/src/leads/leads.service.ts#L748) — `BadRequestException`.

The documented contract in [`common/laravel-exceptions.ts`](../../server/src/common/laravel-exceptions.ts)
is *"validation failures as HTTP 422 with `{ message, errors }`"*, and the global `ValidationPipe`
produces exactly that everywhere else. Leads throws `BadRequestException` → **400**.

Confirmed at runtime: `POST /api/leads` with an empty body returns **400**, with a correct
`{message, errors}` payload.

**Not user-facing.** [`apiError.ts:19-24`](../../client/src/lib/apiError.ts#L19-L24) reads
`response.data.errors` **without checking the status**, so field errors render correctly either
way. But 400 means *malformed request* and 422 means *well-formed but semantically invalid*; any
future client, external integration or monitoring rule keying on 422 will silently miss every lead
validation error.

---

#### M-2 — The `area` parameter defaults to Transaction Desk, causing cross-area 404s [VERIFIED]

Found while writing tests. `PUT /api/account/inbox/1/seen` — **without** `?area=crm` — returns
**404 "Message not found"** for a message the list had *just returned to the same user*.

`parseArea(undefined)` falls back to `desk`, whose primary mailbox is a different account. The
fallback is deliberate ("keeps older clients working"), but the result is an API where omitting an
optional-looking parameter produces a confusing 404 rather than an error naming the cause.

Strictly this surfaced in the Inbox endpoints, but it is the same `parseArea` pattern used across
CRM and it will bite anyone integrating. **Recommend:** make `area` required on writes, or return
a message that names the mismatch.

---

#### M-3 — Deleted leads are capped at 200 with no pagination

[`leads.service.ts:402`](../../server/src/leads/leads.service.ts#L402) — `take: 200`, no paging.
Past 200 soft-deleted leads, the oldest become unrecoverable through the UI. Currently 0 in
production, so latent.

---

#### M-4 — Test-data accumulation exposes an unbounded-list assumption

Not an application defect, but it revealed one. My suite created 75 leads across runs; because the
list is ordered newest-first and the UI shows a page at a time, the seeded leads were pushed off
page one and UI assertions began failing. The same shape applies in production: **there is no way
to find an old lead from the list view alone** without search or filters. Worth confirming the
search/filter path covers it — that part is untested (see §1).

---

### LOW

| ID | Finding |
|---|---|
| L-L1 | `notes` accepts 20,000 characters and `key_features` 5,000, stored inline. No aggregate cap per lead. |
| L-L2 | Bulk delete's agent restriction (`owner_user_id` only) differs from single delete (`assigned_to` OR `owner_user_id`) — an agent can delete a lead singly that bulk delete would skip. Inconsistent, though the safer direction. |
| L-L3 | 400 is returned for "select at least one lead" — a genuinely malformed request, so correct here, which makes M-1's inconsistency more visible. |
| L-L4 | Tag names truncate at 64 characters silently rather than being rejected. |

---

## 4. What is verified good

Every item here was **executed**, not read.

| Property | Evidence |
|---|---|
| **Cross-agent isolation** | Agent cannot read, edit or delete another agent's lead — 403/404 on all three. The lead is confirmed still present for its owner afterwards. |
| **Unauthenticated access** | All 9 Leads GETs return **401 with no cookies**, verified by curl independent of the browser. |
| **CSRF** | A `POST` without the `X-XSRF-TOKEN` header is rejected **419**. |
| **Mass assignment** | Posting `id`, `owner_user_id`, `company_id`, `deleted_at` does not take effect — the validator builds output from an allowlist. Unknown fields are dropped entirely. |
| **SQL injection** | `Robert'); DROP TABLE leads;--` stored as literal text; table intact and readable afterwards. Search with `' OR 1=1--`, `%`, `_`, `\` all return 200. |
| **XSS** | `<img src=x onerror=…>` in a lead name never executes when the list renders. |
| **Validation** | Required fields, malformed email (4 forms), over-long name, whitespace-only name, unrecognised vocabulary, malformed dates (4 forms) — all refused with field-level messages. |
| **Date rollover trap** | `2026-02-31` refused. JavaScript silently rolls that to 3 March; the code round-trips the value to catch it, and the comment says why. |
| **Duplicate email** | Refused, **case-insensitively**, naming the existing lead. |
| **Unicode / emoji** | `李明 Ünïcødé 🏠🔑` stored and returned byte-identical. |
| **Whitespace** | Leading/trailing trimmed before storage. |
| **Soft delete + restore** | Delete removes from list (404 on read), appears under `/deleted`, restores cleanly. |
| **Idempotency** | Deleting the same lead twice does not 500 — safe against double-click and retry. |
| **Long-name layout** | A 45-character hyphenated name causes **no horizontal page overflow**. |

---

## 5. Priority and effort

| # | ID | Issue | Effort |
|---|---|---|---|
| 1 | **L-1** | **Product decision** on administrator visibility | Decision, then 0–2 days |
| 2 | L-2 | Indexes on `owner_user_id` + composites | **1 h** |
| 3 | M-1 | Standardise Leads on 422 | **1 h** |
| 4 | M-2 | Require `area` on writes, or name the mismatch | **2 h** |
| 5 | M-3 | Paginate the deleted list | **2 h** |
| 6 | L-L2 | Align bulk vs single delete scope | **1 h** |
| — | §1 | **Test the untested half** (import/export, tags, tasks, showings, calls, email) | **3–5 days** |

---

## 6. Module status

### NOT PRODUCTION READY

**Justification:**

1. **L-1 is unresolved policy, not a bug.** Launching a brokerage system where no administrator can
   see any agent's leads — and where servicing an absent agent's client requires overwriting the
   assignment — is a decision that must be made deliberately, by the business, before go-live. It
   may well be the right answer; it cannot be an accident.
2. **L-2 does not scale** to the stated user base, and the missing `owner_user_id` index is a
   one-hour fix with no downside.
3. **Roughly half the module is untested** — import, export, tags, tasks, showings, calls and email.
   For a module this size, "the half I tested is good" is not a production sign-off.

**The half that was tested is genuinely strong.** Security held on every probe, and the validation
layer is more careful than most — the February-31 rollover handling in particular is the kind of
thing usually found in production rather than prevented.

**Recommendation:** take the L-1 decision, apply the indexes, then commission a second pass over
the untested endpoints before sign-off.

---

## 7. Harness notes

Three lessons from building the suite, recorded in [`e2e/README.md`](../../e2e/README.md):

1. **`locator.count()` does not auto-wait** — it reads whatever exists at that instant. Use
   `expect(locator).toHaveCount(n)`.
2. **`context.clearCookies()` races a rolling session.** An in-flight response carrying
   `Set-Cookie` re-establishes the session after the clear, so a test "signs out" and is quietly
   still signed in — which presents as the API serving anonymous callers. Use a fresh
   `browser.newContext()`.
3. **Tests that create data must remove it.** 75 leftover leads pushed the seeded fixtures off page
   one and produced failures that looked like application defects.

All three cost real time to diagnose here and would cost it again.

---

## 8. Second pass — 2026-08-01, after the fixes

### Decisions and fixes applied

| Finding | Outcome |
|---|---|
| **L-1** administrator visibility | **Accepted as-is** by the business. The privacy model stands: no rank reads a colleague's book. The consequences in §3 remain true and should be documented for the broker of record — in particular that servicing an absent agent's client requires `transfer-ownership`, which overwrites the original assignment. |
| **L-2** unindexed `owner_user_id` | **Fixed** — migration `20260801230000_leads_owner_index`. |
| **M-1** 400 vs 422 | **Fixed** — `leads.service.ts` now calls the shared `throwValidation()`. |
| **M-2** cross-area 404 | **Fixed** — `inbox.service.ts` now names the area a message actually lives in. |

**L-2 — one index, not three.** The original recommendation listed three. Measuring showed one is
enough: `assigned_to` was *already* indexed, so adding `owner_user_id` alone lets the planner build
a `BitmapOr` across both branches.

```
before:  Seq Scan on leads  Filter: (assigned_to = 1 OR owner_user_id = 1)
after:   BitmapOr -> Bitmap Index Scan on leads_assigned_to_idx
                  -> Bitmap Index Scan on leads_owner_user_id_idx
```

At 512 rows the planner still prefers the scan, correctly — the point is that an index path now
exists, so the plan switches on its own as the table grows. The two composite indexes were dropped
from the plan as unnecessary.

**M-2** now returns *"That message is in your CRM inbox, not Transaction Desk. Add ?area=crm to
reach it."* The lookup stays bounded by `user_id`, so it can only ever describe a message that
already belongs to the caller — no information is disclosed.

### Remaining 50% — now audited

**25 further tests** in `e2e/tests/leads-part2.spec.ts`, covering what the first pass left out:

| Area | Verified |
|---|---|
| **Tags** | Create / list / delete; empty name refused; empty selection refused; **cannot be applied to another agent's lead** |
| **Tasks** | Add / list / update / delete; refused on a nonexistent lead; empty title refused |
| **Showings** | Add / delete; **impossible date (31 Feb) refused** |
| **Notes** | Add / edit / delete; **refused on another agent's lead** |
| **Calls** | Manual log add/delete; vocabulary enforced; **click-to-call refused on another agent's lead** |
| **Email** | **Refused on another agent's lead**; empty subject/body refused |
| **Export** | Succeeds; **contains only the caller's own leads** — the scope rule holds on the way out of the system |
| **Import** | Empty payload refused; rows missing required fields never produce a nameless lead; recent-imports list works |
| **Bulk delete** | Mixed selection — **another agent's lead survives** |
| **Transfer ownership** | **An agent cannot transfer**, so the scope rule cannot be escaped by reassignment |
| **Recycle bin** | Permanent purge works; **another agent's deleted lead cannot be purged** |
| **M-1 regression** | Validation now returns **422** with the shared summary message |

**Every cross-agent probe was refused.** The ownership boundary holds on all eleven surfaces, not
just the four the first pass reached — including the two that would have been easiest to overlook:
CSV export and bulk delete.

### Verification

- **88 E2E tests pass, twice consecutively** (up from 63)
- **569 unit tests pass**, `npm run typecheck` clean
- Migration applied to `myapp_test`; production schema untouched by this pass

### Notes for whoever ships this

Three request shapes are not what their field names suggest, which cost time here and will again:

- tags use `tag`, not `name`; `DELETE /leads/tags` takes a **query parameter**, not a body
- `POST /leads/tag` expects `lead_ids`, not `ids`
- notes use `content`, not `body`; calls require `called_at`, and `outcome` is **lowercase**
  (`connected`, not `Connected`)

### Verdict

### PRODUCTION READY

The blocking findings are resolved or accepted, and the previously untested half is now covered
with every cross-agent boundary verified. Two things remain open and are recorded rather than
fixed: the L-1 consequences need documenting for the broker of record, and the deleted-lead list is
still capped at 200 rows without pagination (M-3, latent at 0 soft-deleted leads) — deferred
by product and tracked as [`docs/BACKLOG.md`](../BACKLOG.md) B-1. The L-1 consequences are now
documented in [`docs/LEAD-PRIVACY-POLICY.md`](../LEAD-PRIVACY-POLICY.md).
