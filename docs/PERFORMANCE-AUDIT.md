# Performance & Reliability Audit

Measured 2026-07-30 against the production build and a copy of production data. Nothing in this
document is inferred from reading code alone unless it says so.

**Method.** Query costs were measured in throwaway PostgreSQL databases seeded to brokerage scale
(3,000–8,000 transactions, 5,000–40,000 leads) and dropped afterwards; production was never written
to. Browser numbers come from a real headless Chrome driven over CDP against `client/dist` served
from a single origin with `/api` proxied — the shape production actually runs in. Two earlier
attempts produced numbers that are deliberately **not** reported here, and why is recorded under
*Measurements that were wrong*, because the reasons are instructive.

**Today's data is 7 transactions and 496 leads.** At that size every query in this codebase is fast,
including the ones that can never be fast. That is what this audit is for.

---

## What is already right

Worth stating, because it narrows where to look and none of it was assumed.

- **Every foreign key is indexed.** 61 of 61 constraints have a leading index. This is the single
  most common cause of mystery slowness in a Prisma application and it is absent here.
- **Code splitting works.** 27 lazily-loaded routes; the entry chunk statically imports nothing else.
  First contentful paint **476 ms**, 337 kB of JavaScript, 433 kB transferred. `jspdf` (386 kB),
  `html2canvas` (201 kB) and the Twilio voice SDK (181 kB) are all behind dynamic imports.
- **No memory leak found.** Four identical 10-screen circuits with a forced GC between each:
  heap 3.6 → 3.8 → 4.0 → 4.1 MB, DOM nodes oscillating 309/298. A +0.5 MB drift over 40 navigations
  is cache, not retention.
- **No main-thread blocking.** Zero tasks over 50 ms across the whole walk. Nothing here freezes.
- **Timers and listeners are clean.** Every `setInterval` is cleared; the only two unpaired
  `addEventListener` calls use `{ once: true }`.
- **The auto-save is properly built** — a mutex, a queued re-run for edits arriving mid-flight,
  debounce cleanup. See F6/F7 for its two real gaps.
- `unhandledRejection` and `uncaughtException` are both handled with a graceful shutdown.

**No evidence was found for browser crashes or UI freezes**, and the heap and long-task measurements
above are the reason. The findings below are about the server, the database, and the network.

---

# F1 · The dashboard loads every transaction ever, forever

**Severity: critical.** This is the landing screen.

> **RESOLVED, and my projection below was wrong.** I estimated "sub-50 ms at any brokerage size,
> 20–25× faster, and it stops growing" on the assumption the totals could be aggregated in SQL.
> They cannot. Every figure runs through the commission engine — variants, per-member splits, HST,
> adjustments — so moving it to SQL would mean reimplementing commission arithmetic in SQL, which is
> exactly the risk this finding warned against.
>
> What was safely achievable, measured at 12,000 transactions: **3,328 ms → 2,217 ms** and peak heap
> **311 MB → 161 MB**. Roughly 1.5× faster and half the memory, still linear — because the engine
> must run once per transaction and that is the floor for this design.
>
> The dominant cost was not the query. `breakdown()` resolved each member's split with
> `users.findFirst` — one query PER MEMBER PER TRANSACTION. It already accepted a profile cache;
> nothing passed one.
>
> **A latent bug surfaced by doing this.** That lookup has no `orderBy`, and two active accounts
> here are both named "Akhil" with `agent_comm_pct` of 0 and 90. `findFirst` returns whichever the
> planner offers — measured, the *higher* id. Caching "first by id wins" therefore picked the 0% row
> and silently zeroed that agent's commission: a **$21,865.50** error the parity gate caught to the
> cent. The cache now reuses the identical query per distinct name rather than guessing.
>
> **The duplicate name is now fixed.** A name is a join key here — commission splits, agent loan
> positions, document and notice email routing, and name-scoped visibility all resolve people from
> those strings — so two active accounts sharing one resolved to whichever the planner offered.
> Three changes: the admin account (id 1, the row the lookup was NOT returning, so no figure could
> move) was renamed to its own username; `name` now carries the same uniqueness rule as `username`
> and `email`, rejected at the API with a message that says why; and `/api/health/workers` reports
> any collision that predates the rule. Parity re-verified across the rename with the harness keyed
> by user id rather than by name: all 234 values identical.
>
> Gated by `scripts/dashboard-parity.ts` (capture/verify, exact equality, no tolerance) and pinned
> by `dashboard-parity.spec.ts`. Verified over 187,828 numeric values across 4,000 transactions
> covering every commission variant, and over the live data before deploy.

### Evidence

`server/src/dashboard/dashboard.service.ts:47` issues one `findMany` with no `take`, pulling
`transaction_statuses`, `team_members → team_member_terms` and `precon_terms`, then aggregates in
JavaScript. Measured in a scratch database at increasing row counts:

| transactions | query | payload | ms/txn | growth |
|---|---|---|---|---|
| 500 | 74 ms | 1.53 MB | 0.148 | |
| 1,000 | 144 ms | 3.06 MB | 0.144 | ×1.94 for ×2 rows |
| 2,000 | 289 ms | 6.13 MB | 0.145 | ×2.01 |
| 4,000 | 582 ms | 12.27 MB | 0.146 | ×2.01 |
| 8,000 | **1,184 ms** | **24.57 MB** | 0.148 | ×2.03 |

Perfectly linear, with cost per transaction constant to three decimal places. A separate measurement
put the JavaScript aggregation at **459 ms** on top of the query at 3,000 rows.

The response the browser receives is **0.3 kB** — this is entirely server-side cost.

### Root cause

Every closed deal in the brokerage's history is fetched and summed on every dashboard load, because
the totals are computed in application code rather than by the database. Nothing bounds the query by
date, status, or page.

### Business impact

Today: invisible. At 3,000 transactions — a 40-agent brokerage in about five years — the dashboard
costs ~450 ms of database time and materialises ~9 MB per load. At 8,000 it is 1.2 s and 24.6 MB.

The compounding risk is concurrency, not latency. Load testing already showed 200 concurrent agents
at 264 req/s with the dashboard in the mix. At 8,000 transactions, even a fraction of those
overlapping means multiple 24.6 MB object graphs alive in the Node heap at once. **This is the most
likely cause of a production out-of-memory crash in this application**, and it will arrive gradually
and then all at once — the failure mode is a restart loop at 9 a.m., not a slow page.

### Expected improvement

Aggregating in SQL (`GROUP BY` with `SUM`) makes the response time roughly **constant** and the
memory cost negligible: sub-50 ms at any brokerage size, versus 1,184 ms and 24.6 MB at 8,000.
Roughly **20–25× faster at 8,000 transactions, and it stops growing.**

### Regression risk — **HIGH**

This is commission arithmetic. The existing query carries the comment *"match Laravel's PK-order
iteration for identical fp sums"* — the iteration order is deliberate because floating-point
addition is not associative and the totals were matched against the legacy system. Re-expressing it
in SQL can produce different rounding.

Do not attempt this as a refactor. Treat it as a re-implementation with a parity gate.

### Verification

1. Before changing anything, capture the full dashboard response for every role against production
   data and store it.
2. After the change, assert byte-identical totals — not "close", identical — for every role.
3. Re-run the curve above and confirm the time is flat rather than linear.
4. Confirm `paidTotal`, `pendingTotal`, `upcomingTotal` and all counts against a hand-checked month.

---

# F2 · CSV lead import cannot use an index that already exists

**Severity: critical.** This one is a guaranteed production failure, not a risk.

### Evidence

`server/src/campaigns/campaigns.service.ts:368` runs, per row of the uploaded file, sequentially:

```ts
const existing = await this.prisma.leads.findFirst({
  where: { email: { equals: email, mode: 'insensitive' } } });
```

Prisma renders `mode: 'insensitive'` as `ILIKE`. `EXPLAIN` on production data:

```
Seq Scan on leads  (cost=0.00..83.11)  Filter: ((email)::text ~~* 'lead123@x.test')
Rows Removed by Filter: 496
```

The schema **already contains** `leads_email_lower_key ON lower(email)`. `ILIKE` cannot use it.
Measured against non-existent addresses — the normal case when importing new leads, and the case
with no early exit:

| leads | `ILIKE` (current) | `lower(email) =` (indexed) | projected 5,000-row import |
|---|---|---|---|
| 5,000 | 3.84 ms | 0.340 ms | 19 s (11× slower) |
| 20,000 | 13.64 ms | 0.355 ms | 68 s (38× slower) |
| 40,000 | **26.34 ms** | **0.344 ms** | **132 s (77× slower)** |

The indexed form is **flat** — 0.34 ms regardless of table size. The current form is linear in the
lead table, and the import is linear in file size, so total cost is the product of the two.

The loop is also **not wrapped in a transaction**, though `$transaction` is used in 15 other places.

### Root cause

Three compounding faults: a query shape that cannot reach an existing index; one round trip per row
instead of one batched lookup; and no transaction around a multi-thousand-row write.

### Business impact

A 5,000-row import against a 40,000-lead database spends **132 seconds in lookups alone**, in a
single HTTP request. Any reverse proxy in front of this (nginx defaults to 60 s) returns 504 while
the server keeps working. Because there is no transaction and no resume, the operator sees a failure
over a partially-completed import, and re-running it re-processes everything already written.

Bulk lead import is how a brokerage onboards. This fails the first time it is used at scale.

### Expected improvement

Replacing the per-row lookup with one batched `lower(email) IN (...)` query and wrapping the writes
in a transaction takes the lookup cost from ~132 s to **well under a second**, and makes a failed
import leave no partial data.

### Regression risk — **LOW to MEDIUM**

`lower(a) = lower(b)` is exactly the case-insensitive equality `mode: 'insensitive'` is meant to
express, so matching behaviour is preserved. The risk is in the batching rewrite (duplicate
addresses within one file must still collapse correctly), not in the comparison.

### Verification

1. `EXPLAIN` the new query and confirm `Index Scan using leads_email_lower_key`.
2. Import a 5,000-row file into a 40,000-lead scratch database and time it end to end.
3. Import a file containing mixed-case duplicates of existing leads and confirm the same rows are
   matched as before.
4. Kill the process mid-import and confirm no partial rows survive.

---

# F3 · The browser has no request timeout

**Severity: high.**

### Evidence

`client/src/lib/axios.ts` creates the instance with `baseURL`, `withCredentials`, `withXSRFToken`
and headers — **no `timeout`**. Axios defaults to `0`, meaning wait forever. Confirmed absent across
`src/lib/`. There is no retry for network failures either; the only interceptor handles 419.

### Root cause

Default-by-omission.

### Business impact

Any request that never returns leaves the UI waiting indefinitely — no error, no recovery, a
spinner that never resolves. Combined with F2, an import that takes 132 seconds has no client-side
deadline at all. On mobile data, where agents work, a dropped connection produces a permanently
stuck screen rather than a retry.

### Expected improvement

No throughput change. It converts an indefinite hang into a message a user can act on, which is the
difference between "the app is broken" and "that didn't work, try again".

### Regression risk — **MEDIUM**

A blanket timeout will break long-running legitimate operations — bulk exports, PDF generation,
imports. These need a longer per-request override rather than the global default, so the change must
enumerate them rather than pick one number.

### Verification

Point the client at an endpoint that sleeps past the timeout and confirm a clean error. Then run
every export and bulk operation and confirm none of them now fail early.

---

# F4 · Notification polling refires on every navigation

**Severity: medium.**

### Evidence

Measured directly — a 10-screen SPA walk on the production build. `/api/agent-change-notifications`
appears on **every screen**:

```
CRM            6   /api/agent-change-notifications×2  /api/dashboard/crm  ...
Transactions   4   /api/dashboard/desk  /api/dashboard/commissions  /api/agent-change-notifications
Analytics      2   /api/transactions  /api/agent-change-notifications
Calendar       4   /api/calendar/events  ...  /api/agent-change-notifications
Inbox          2   /api/account/inbox  /api/agent-change-notifications
...
Inventory      4   /api/marketing-inventory×2   ← a second, separate duplicate
```

Cause is visible at `client/src/desk/DeskLayout.tsx:137-143`:

```ts
useEffect(() => {
  ...
  const t = setInterval(load, 60000);
  return () => clearInterval(t);
}, [isAdminOrAbove, location.pathname]);   // ← pathname tears down and re-runs on every navigation
```

`location.pathname` in the dependency array destroys and recreates the interval on each navigation,
and the effect calls `load()` immediately on setup. The same pattern repeats at line 150 for
document notifications.

### Root cause

A dependency added to refresh on navigation, which also resets the polling timer — the immediate
fetch is a side effect of the teardown, not an intended behaviour.

### Business impact

One extra request per navigation per user, plus the 60-second poll. An agent moving through ten
screens generates ten extra calls. Against the **600 requests/minute per-IP** limit already
documented as a capacity risk, and with an office sharing one NAT address, this contributes directly
to agents hitting HTTP 429 — which, per F6, is when their unsaved work stops saving.

Also note all these failures are swallowed: `.catch(() => {})` appears **32 times** in the client, so
a notification endpoint failing is completely invisible.

### Expected improvement

Removing `location.pathname` from both dependency arrays eliminates one request per navigation per
user — roughly a 20–30% reduction in idle-navigation traffic for an active agent.

### Regression risk — **LOW**

Notifications refresh on their 60-second timer regardless. The visible change is that the badge may
lag by up to a minute after navigating, which is what a polling badge already does.

### Verification

Re-run the SPA walk and confirm `agent-change-notifications` appears once per minute rather than
once per screen. Confirm the badge still updates.

---

# F5 · 40 of 50 data-fetching effects have no cancellation guard

**Severity: medium.**

### Evidence

Static analysis of every `useEffect` that fetches and then calls `setState`: **50 total, 10 guarded
by a cancellation flag, 40 unguarded.** The correct pattern exists in the codebase already —
`CampaignsPage.tsx:601` uses `if (!cancelled) setCount(...)` — so this is inconsistency, not
ignorance. Only 2 uses of `AbortController` across 63 call sites.

The sharpest case is `AuditLogPage.tsx:66`, which refetches on seven dependencies including the
search box:

```ts
}, [category, q, from, to, page, area, scope]);
```

**In fairness, it is debounced 350 ms with `clearTimeout` cleanup**, which prevents a burst of
requests per keystroke and narrows this considerably. What the debounce does *not* do is order the
responses: once two requests are genuinely in flight, whichever returns last wins, regardless of
which was asked last.

### Root cause

No response-ordering discipline. Debouncing limits how many requests are issued; it does not
guarantee the newest response is the one rendered.

### Business impact

On a fast connection this is nearly unobservable, which is why it has not been reported. On a slow
or variable connection — an agent on mobile data, precisely when it matters — a filter change can
display results for the *previous* filter, with the UI showing the new one. The user sees an audit
trail or lead list that does not match the filters on screen, and has no reason to distrust it.

### Expected improvement

Correctness, not speed. It removes a class of wrong-data-on-screen that is nearly impossible to
reproduce on demand and therefore nearly impossible to support.

### Regression risk — **LOW**. Adding a guard before `setState` cannot break a correct path.

### Verification

Throttle the network to 3G in DevTools, change a filter twice in quick succession, and confirm the
rendered rows match the final filter. Repeat on the audit log, leads and transactions lists.

---

# F6 · A rate-limit burst silently strands unsaved work

**Severity: high.** This is two known issues meeting.

### Evidence

- `server/src/config/rate-limits.ts` — `GLOBAL_LIMIT = 600/60s`, per IP, and an office shares one IP.
- `client/src/desk/TransactionDetailPage.tsx:177` — `AUTOSAVE_MS = 1200`, so one agent editing
  generates roughly 50 requests/minute. About **twelve agents in one office exhaust the bucket.**
- The auto-save failure path (line ~293) sets `autoState('error')` and a message — and stops.
  `savedSnapRef` is correctly *not* advanced, so the data is still in the browser, but **there is no
  retry**. The edit stays unsaved until the user changes another field and triggers a new debounce.

### Root cause

The auto-save treats a save failure as terminal. A 429 is transient by definition — the bucket
refills in under a minute — but nothing retries.

### Business impact

During a busy period the office trips the rate limit, and agents editing transactions see a small
"Could not save" indicator while continuing to work. Their edits live only in the browser tab. A
navigation or a closed tab loses them. This is the highest-consequence finding in the audit that is
not a crash: **silent loss of entered data, at the busiest moment of the day.**

### Expected improvement

Retrying with backoff on 429/503 turns a lost edit into a save that lands a few seconds later.
Raising the limits (or exempting office ranges) prevents the trip in the first place.

### Regression risk — **LOW to MEDIUM**. Retry logic must not duplicate writes; the existing
`savingRef` mutex and `rerunRef` already provide the structure to do this safely.

### Verification

Set the global limit to something small locally, drive edits until 429, and confirm the edit lands
once the window clears, exactly once. Then confirm no duplicate audit-log entries were written.

---

# F7 · The last edit before closing a tab may never be sent

**Severity: medium.**

### Evidence

`TransactionDetailPage.tsx:310-314`:

```ts
const onLeave = () => { void flushAutoSave(); };
window.addEventListener('beforeunload', onLeave);
```

`flushAutoSave` is `async` and issues a normal XHR. `beforeunload` cannot await, and browsers cancel
in-flight requests during unload. `sendBeacon` and `keepalive` appear **zero times** in the client.

### Root cause

An async write used in a synchronous lifecycle hook.

### Business impact

An agent who types a value and immediately closes the tab loses that edit, intermittently and
unreproducibly — the request survives only if it happens to complete before teardown. The
route-change path in the same effect's cleanup is fine; only the tab-close path is affected.

### Expected improvement

`navigator.sendBeacon` (or `fetch(..., { keepalive: true })`) is guaranteed delivery on unload.

### Regression risk — **LOW**, but `sendBeacon` cannot send custom headers, so the CSRF token has to
travel in the body or a dedicated endpoint is needed. That is a real design constraint, not a
find-and-replace.

### Verification

Type a value, close the tab immediately, reopen the transaction, confirm the value persisted.
Repeat 20 times — intermittent bugs need repetition to confirm a fix.

---

# F8 · 40 unbounded reads on tables that grow forever

**Severity: medium**, and the origin of the next F1 once the data grows.

### Evidence

133 `findMany` calls; **115 have no `take`**. Filtering to models with no natural ceiling:

| model | unbounded reads | examples |
|---|---|---|
| transactions | 15 | `dashboard.service.ts:47`, `agents.service.ts:84`, `notifications.service.ts:21` |
| leads | 11 | `campaign-audience.service.ts:70`, `campaigns.service.ts:344` |
| documents | 8 | `documents.service.ts:58` |
| invoices | 4 | `invoices.service.ts:37` |
| calendar_events | 1 | `calendar.service.ts:87` |
| transaction_messages | 1 | `messages.service.ts:40` |

`leads.service.ts:584` reads **every lead** to build the tag list (89 ms at 40,000). The main leads
and transactions list endpoints *are* correctly paginated — this is about everything else.

`CommissionAnalytics.tsx:28` does the same on the client: `listTransactions().then(setRows)` with no
bound.

### Root cause

Pagination applied at the endpoints that obviously needed it, not as a default.

### Business impact

Each is small today. Collectively they are the mechanism by which this application slows down as the
brokerage succeeds — every one degrades linearly and none has a ceiling.

### Expected improvement / regression risk

Case by case. Most want an explicit bound or an aggregate; some are genuinely fine because the table
is small. **The valuable step is triage**, not a blanket `take`, which would silently truncate
results — a correctness bug dressed as a performance fix. Regression risk is **HIGH** if applied
mechanically, **LOW** per-site with judgement.

### Verification

For each site, assert the row count returned is unchanged on production data, then re-measure at
10× scale in a scratch database.

---

# F9 · Audit logging writes one row at a time on the hottest path

**Severity: low to medium.**

### Evidence

`server/src/audit/audit.service.ts:187-191`:

```ts
for (const change of this.diff(before, after)) {
  await this.record(txnId, user, { ...change, source });
}
```

Sequential awaits, one INSERT per changed field, on the path the auto-save triggers every 1.2
seconds while an agent edits.

### Root cause

Sequential iteration where a batch would do.

### Business impact

Editing a transaction with 20 changed fields costs 20 sequential round trips inside the save. It
multiplies with auto-save frequency and adds latency to exactly the interaction agents perform most.

### Expected improvement

`createMany` reduces N round trips to one — for a 20-field change, roughly **20× fewer round trips**
on that write.

### Regression risk — **LOW to MEDIUM**. Audit rows are a legal record; ordering and completeness
must be preserved exactly, and `createMany` must not skip duplicates silently.

### Verification

Change 20 fields at once and assert exactly 20 audit rows with the same content and order as before.

---

# F10 · Backup and restore time now tracks mail volume

Already recorded as gap 6 in `DISASTER-RECOVERY.md` and repeated here because it is a performance
finding: `inbound_emails` is **77 MB of an 80 MB database — 96%** — with no retention policy, having
doubled in a week. The database dump grew 25.9 MB → 53.8 MB in that time. Backup duration, restore
duration and therefore **RTO** are governed by mail volume rather than by brokerage activity.

The unique index on `(account_id, uid)` rules out re-ingestion — this is real mail, not duplicates.

---

## Measurements that were wrong, and why

Recorded because each would have produced a confident, false finding.

**The dev server reported three calls to several endpoints.** React `StrictMode` deliberately
double-invokes effects in development and does not in a production build. Reporting those counts
would have been reporting a debugging aid as a defect. Every duplicate-request number here comes
from `client/dist`.

**`vite preview` measured the sign-in page.** The production bundle is built with `VITE_API_URL`
empty on purpose, so requests are relative and same-origin. A preview server that does not proxy
`/api` answers them with its own 404, the app renders the login screen, and the resulting "28 DOM
nodes, 2 API calls, stable heap" looked like a clean bill of health. The tell was the DOM node count
being identical on every route. Measurements were redone against dist + a proxy on one origin.

**The first `ILIKE` benchmark showed no problem at all** — 0.42 ms at 40,000 rows, apparently
disproving the finding. It probed addresses that existed near the *start* of the table, and `LIMIT 1`
lets a sequential scan stop at the first match. Probing absent addresses — which is what importing
new leads actually does — gave 26.34 ms and a 77× gap. A benchmark that makes a problem disappear
deserves more suspicion than one that finds it.

---

## Suggested order

Ordered by consequence per unit of risk, not by severity alone.

| | Finding | Why here |
|---|---|---|
| 1 | **F2** import ILIKE + transaction | Certain failure, large win, low risk, index already exists |
| 2 | **F4** navigation refetch | One-line change, measurable, near-zero risk |
| 3 | **F6** auto-save retry + rate limits | Prevents silent data loss |
| 4 | **F5** cancellation guards | Mechanical, low risk, removes wrong-data-on-screen |
| 5 | **F3** request timeouts | Needs the long-operation exemption list first |
| 6 | **F7** `sendBeacon` on unload | Needs a CSRF design decision |
| 7 | **F1** dashboard aggregation | Biggest win, highest risk — needs a parity gate, do it deliberately |
| 8 | **F8/F9/F10** | Triage as the data grows |

**F1 is last on purpose.** It is the largest performance win in this document and the one most
capable of producing wrong commission figures. It should be scheduled as its own piece of work with
a before/after parity harness, not folded into a performance sprint.

---

## What this audit did not cover

- **No production profiler.** All server measurements are local, on one machine, against seeded
  data. Real contention, network latency and disk behaviour will differ.
- **Concurrency was not re-tested at scale.** The 200-concurrent load test predates this audit and
  ran against 7 transactions. The F1 memory projection is arithmetic from a measured payload size,
  not an observed OOM.
- **Mobile was not measured.** Several findings (F3, F5) bite hardest on slow connections, and no
  measurement here was taken on a throttled or real mobile network.
- **No write-path load testing.** Import, export and PDF generation were measured for query cost,
  not under concurrent use.
