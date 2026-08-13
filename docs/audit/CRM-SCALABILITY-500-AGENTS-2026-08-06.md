# CRM Scalability, Load & Performance Audit — 500 Agents / 2.5 Million Leads

**Date:** 2026-08-06
**Scope:** CRM only. Transaction Desk, Invoice, Reports, MLS, Favorites, Inventory and Recycle Bin excluded.
**Application changed:** No. No index was created, no query rewritten, no configuration altered in the application.
**Target:** 500 concurrent agents · ~5,000 leads each · ~2,500,000 total leads.

---

# THE ANSWER FIRST

> **If 500 agents log into the CRM at approximately the same time, with 2.5 million leads stored, can
> they all work normally without noticeable lag?**

**On the current single-process deployment: No — measured, not estimated.**

500 simultaneous sign-ins took **116.7 seconds** on one Node process, and under a realistic mixed
workload p95 latency crossed the 1.5-second failure threshold at **50 concurrent users**.

**After four specific, measured changes: Yes.** None is a rewrite. Every one of them is named below
with the measurement that justifies it and the measurement that proves the gain.

**The database is not the problem.** 2.5 million leads is comfortably handled — most CRM queries run
in single-digit to low-hundreds of milliseconds because the lead-privacy scope makes every query
touch one agent's book rather than the table. The problems are **how many queries each request
makes** and **password hashing on the event loop**.

---

# EVIDENCE CLASSES

Every claim carries one. Nothing below is inferred from "the code looks fine".

| Class | Meaning |
|---|---|
| **MEASURED** | Timed directly against the 2.5M-row dataset |
| **LOAD-TESTED** | Observed under concurrent multi-user load |
| **QUERY PLAN** | `EXPLAIN (ANALYZE, BUFFERS)` against real data |
| **CALCULATED** | Arithmetic from measured unit costs |
| **ESTIMATED** | Reasoned projection, stated as such |
| **NOT VERIFIED** | Not tested — said so rather than guessed |

## What was actually built and run

A dedicated `myapp_perf` database was created and populated server-side:

| Table | Rows | Size | Bytes/row |
|---|---:|---:|---:|
| `leads` | **2,500,014** | 1,421 MB | 613 |
| `lead_notes` | 915,096 | 137 MB | 158 |
| `lead_tasks` | 450,894 | 74 MB | 173 |
| `lead_calls` | 361,764 | 48 MB | 140 |
| `lead_showings` | 203,800 | 31 MB | 157 |
| `users` | 505 (500 agents + 5 staff) | 400 kB | — |
| **Database total** | | **1,725 MB** | |

Distribution is deliberately uneven, because uniform data hides index problems: statuses, sources,
client types and languages cycle independently; 1 in 11 leads has no phone; 1 in 40 carries a ~2.5 kB
note; 1 in 50 is soft-deleted; 1 in 5 has no client type; created dates spread across four years;
surnames collide heavily on purpose so duplicate-name search is exercised; Meta leads carry a
`facebook_lead_id` and others do not.

Three book sizes exist, because a real brokerage is not uniform:

| Scope | Leads |
|---|---:|
| Median agent | 4,668 |
| Heavy agent | 60,256 |
| Unattributed intake (Super Admin only) | 59,756 |

## Environment, and its limits — read this before the numbers

| Resource | Value |
|---|---|
| CPU | 12 cores, i5-11500 @ 2.70 GHz |
| RAM | 34.2 GB (13–15 GB free) |
| PostgreSQL | 17.10, `max_connections=100`, `shared_buffers=128 MB`, `work_mem=4 MB` |
| Prisma pool | default (25 = cores×2+1) |

**The load generator, the API and PostgreSQL all ran on this one machine.** Host CPU averaged 66%
and peaked at 100% during the 100-user test, so the client competes with the server. This makes the
latency figures **pessimistic**, not optimistic — a real deployment separates these. The *shape* of
the results (where throughput plateaus, what scales linearly) is unaffected, and that shape is what
the conclusions rest on.

**Not verified in this audit:** a 2-hour soak, browser memory over a long session, real Meta/Gmail/
Twilio provider limits, and multi-container networking. Each is called out where it belongs.

---

# 1. THE HEADLINE BOTTLENECK — PASSWORD HASHING ON THE EVENT LOOP

**This is the single most important finding, and it is the one the brief asks about directly.**

## Measured

```
bcryptjs compare, cost factor 12  →  226 ms of CPU, per login
5 sequential compares             →  1,123 ms
implied ceiling                   →  4.5 logins/second, per Node process
```

`server/package.json` depends on **`bcryptjs` — a pure-JavaScript implementation**. It has no native
addon and no threadpool, so every password verification runs on the Node event loop. Twelve cores do
not help: one process gets one thread for this work.

## Load-tested — 500 agents signing in at once

| Node processes | Logins/second | Time for 500 agents | Result |
|---:|---:|---:|---|
| **1** | **4.3** | **116.7 s** | 500/500 eventually; p50 **116.6 s** |
| 2 | 8.5 | 58.9 s | 499/500 |
| 4 | ~17 | 29.5 s | client-side socket limits truncated the run |

**Throughput scales linearly with process count** — 4.3 → 8.5 → ~17. That is the signature of a
per-process CPU constraint, and it is also the good news: the fix is horizontal, not architectural.

The predicted ceiling (4.5/s) and the measured one (4.3/s) agree to within 5%, which is why this is
stated as a mechanism rather than a symptom.

## What an agent experiences

A 9 a.m. login rush on one process: the last agent waits **~2 minutes**. Meanwhile every other
request on that process queues behind the hashing.

## Fix, in order of preference

1. **Run 4+ Node processes** (pm2 cluster / 4 containers). Measured to work. 500 agents in ~30 s.
2. **Replace `bcryptjs` with native `bcrypt` or `@node-rs/bcrypt`**, which use the libuv threadpool
   and scale across cores within one process. **Not measured here** — recommended on mechanism, and
   should be benchmarked before adoption.
3. **Do not lower the cost factor.** Cost 12 is a deliberate security decision; the audit trail shows
   it was raised on purpose. Solve this with threads and processes, not by weakening hashing.

---

# 2. THE SECOND BOTTLENECK — QUERY FAN-OUT PER REQUEST

## The decomposition that proves it

100 concurrent users, no think-time, each endpoint measured in isolation:

| Endpoint | Queries per request | Throughput | p50 |
|---|---:|---:|---:|
| `/api/notifications/count` | 1 | **532 req/s** | 183 ms |
| `/api/meta/status` | few | **743 req/s** | 125 ms |
| `/api/dashboard/crm` | ~19 | **17 req/s** | 5,769 ms |
| `/api/leads?limit=25` | ~15 | **10 req/s** | 8,927 ms |

**The HTTP stack, session lookup, authentication, guards and serialisation sustain 530–740 req/s.**
They are not the bottleneck. The Leads list collapses to **10 req/s — a 53× drop** — and the only
material difference is the number of database queries it issues.

## Where the queries come from

**`LeadsService.list()` issues 15 queries for one page:**

- 1 × `findMany` (the actual page of 25 rows)
- 1 × `count` (the total)
- 13 × `count` inside `stats()` — total, no-calls, website-enquiries, recent, five `lead_status`
  counts, four `lead_source` counts

One of them, `lead_calls: { none: {} }`, renders as an **anti-join** against a 362k-row table.

**`AreaDashboardService.crm()` issues ~19 queries** in a single `Promise.all`, including two
`groupBy` over `leads`.

## Measured fix — the 13 counts become one

Same numbers, verified equal (`hot` count: 14,751 both ways):

| | Wall time, 1 user | Throughput, 12 concurrent |
|---|---:|---:|
| 13 counts in parallel (today) | 349 ms | **4.2 page-loads/s** |
| 1 query with `FILTER` aggregates | 290 ms | **17.1 page-loads/s** |
| | 1.2× faster | **4.1× more throughput** |

**This is the crux of the whole report.** A single user barely notices the fan-out — parallelism
hides it, 349 ms versus 290 ms. But at concurrency it consumes 13× the pool connections and 13× the
database work, and throughput collapses. *The problem is invisible in single-user testing and
decisive under load.*

```sql
-- One pass instead of thirteen; identical results.
SELECT count(*) AS total,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lead_calls lc WHERE lc.lead_id = l.id)) AS no_calls,
  count(*) FILTER (WHERE l.lead_status = 'hot')  AS hot,
  count(*) FILTER (WHERE l.lead_source = 'meta') AS s_meta,
  …
FROM leads l WHERE <scope>;
```

---

# 3. THE THIRD BOTTLENECK — CONNECTION POOL

## Measured under 100-user load

```
DB connections to myapp_perf   total max=31  avg=24.5
                                active max=21
                                waiting on lock: 0
PostgreSQL max_connections = 100
```

The application never opened more than 31 connections while PostgreSQL allowed 100. Prisma's default
pool is `cores × 2 + 1` = **25**. With 15 queries per Leads request, **fewer than two Leads page-loads
can be in flight at once.**

## Load-tested — raising it only partly helps

| `connection_limit` | Throughput | p50 | p95 | Event-loop lag |
|---:|---:|---:|---:|---:|
| 25 (default) | 27.5 req/s | 2,893 ms | 5,289 ms | max 6 ms |
| 60 | 31.4 req/s | 2,423 ms | 4,878 ms | max **112 ms** |

+14% throughput for 2.4× the pool. **The pool is a contributor, not the cause** — raising it simply
moves the queue from the pool into PostgreSQL and the event loop. Fix the fan-out first; then size
the pool.

**Zero lock waits at every level tested.** No deadlocks, no contention, no lost updates observed.

---

# 4. WHAT IS ALREADY RIGHT — THE 2.5M-LEAD VERDICT

## The lead-privacy policy is also the performance architecture

`leadScopeWhere` restricts every list, count, search, filter, dashboard tile and export to
`assigned_to = me OR owner_user_id = me`. Both columns are indexed
(`leads_assigned_to_idx`, `leads_owner_user_id_idx`), so PostgreSQL resolves the scope with a
**BitmapOr of two index scans** and touches one agent's book — never the 2.5M-row table.

This is worth stating plainly: **the privacy decision documented in `docs/LEAD-PRIVACY-POLICY.md` is
what makes 2.5 million leads a non-event.** A CRM where managers browse all leads would have entirely
different numbers here.

## Query plans against 2.5M rows (QUERY PLAN)

Median agent (4,668 leads) — the realistic target case:

| Operation | Time |
|---|---:|
| Lead list page 1 | **311 ms** |
| Lead list page 10 | 289 ms |
| Lead list page 100 | 297 ms |
| Search | **128 ms** |
| Filter (status + source) | 54 ms |
| Dashboard | 157 ms |
| Lead tasks | 105 ms |

Heavy agent (60,256 leads) — the pessimistic case:

| Operation | Time |
|---|---:|
| Lead list page 1 | 674 ms |
| Search | 627 ms |
| Dashboard | 424 ms |

## Deep pagination is a non-issue — measured, contrary to expectation

`OFFSET/LIMIT` is used. The standard concern is that deep pages degrade. **They do not here**, because
`OFFSET` is bounded by the agent's book, not the table:

| Page | OFFSET | Median agent | Heavy agent |
|---|---:|---:|---:|
| 1 | 0 | 311 ms | 674 ms |
| 10 | 225 | 289 ms | 788 ms |
| 100 | 2,475 | 297 ms | 642 ms |

**Recommendation: keep OFFSET pagination.** Cursor/keyset would add complexity and solve nothing
measurable. This is exactly the over-optimisation the brief warns against.

## Search does not full-scan, and the reason is subtle

`buildWhere` uses Prisma `contains` + `mode: 'insensitive'`, which compiles to `ILIKE '%term%'` across
five columns. A leading wildcard **cannot** use a btree index, and on 2.5M rows that would be fatal.

It is not, because **the scope predicate is applied first**: the ILIKE runs over the ~5,000 rows the
bitmap scan already produced, not over 2.5M. Measured at 128 ms (median agent) / 627 ms (heavy).

**This is a conditional safety, and it is worth writing down.** If any future feature grants a role a
broad lead scope — a compliance search, a manager view, a "all brokerage leads" report — this search
becomes a full scan of 2.5M rows with five ILIKEs. The privacy policy is load-bearing for performance,
not only for privacy.

## Lead detail is fast even for heavy histories

The heaviest generated lead (120 notes) loaded its notes, tasks and calls in **<1 ms each**, via
`lead_notes_lead_id_idx` and equivalents. No pagination needed at this scale.

**Not verified:** leads with 1,000+ activities. The generator's heaviest is 120. Behaviour is
index-scan-per-lead, so it should degrade linearly — **ESTIMATED**, not measured.

## Verdict on 2.5M leads

### **READY** — with the database evidence above.

No CRM query performs a sequential scan of the leads table under normal role scopes. The two
sequential scans observed (`stats` anti-join, dashboard task count) are over the already-narrowed
scope, not the full table.

---

# 5. LOAD TEST RESULTS

Realistic session mix per the brief — 25% browse/search, 15% detail, 10% update, 10% notes/tasks,
10% dashboard, 10% inbox, 5% calendar, 5% campaigns, 5% notifications, 5% Meta — with 200–600 ms
human think-time between actions.

| Users | Dataset | p50 | p95 | p99 | Errors | Throughput | Event-loop lag | RSS | Result |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 25 | 2.5M | 404 ms | 1,465 ms | 2,106 ms | 0% | 23.9 req/s | max 7 ms | 318 MB | **Marginal** |
| 50 | 2.5M | 1,120 ms | 2,458 ms | 2,932 ms | 0% | 28.8 req/s | 0 ms | 388 MB | **FAIL** (p95 > 1.5 s) |
| 100 | 2.5M | 2,471 ms | 4,679 ms | 5,780 ms | 0% | 31.4 req/s | max 108 ms | 504 MB | **FAIL** |
| 250 | 2.5M | 7,512 ms | 13,951 ms | 18,180 ms | 0% | 28.4 req/s | max 396 ms | 485 MB | **FAIL** |
| 500 | 2.5M | — | — | — | sign-in failures | — | — | 507 MB | **FAIL** |

An earlier 4.5% "error rate" at 25 and 50 users was **the test harness**, not the application — it
posted `{note:…}` where the API expects `{content:…}`. Corrected, the real error rate is **0%** at
every level up to 250 users. The application returned no 5xx at any concurrency.

## The most telling number in the table

**Throughput is flat at 24–31 req/s from 25 users to 250 users.** Ten times the concurrency, the same
throughput, ten times the latency. That is a queue, not a capacity curve — and §2 identifies what is
queuing.

## Failure threshold

**p95 crosses 1.5 s between 25 and 50 concurrent users** on this hardware, single-process.

---

# 6. PERFORMANCE BUG REGISTER

| ID | Area | Problem | Severity | Capacity trigger | User impact | Root cause | Recommendation |
|---|---|---|---|---|---|---|---|
| **P-01** | Auth | 4.3 logins/s per process | **Critical** | Any login rush | 500 agents = 117 s to sign in | `bcryptjs` is pure JS on the event loop | 4+ processes; consider native bcrypt |
| **P-02** | Leads | 15 queries per page load | **Critical** | ~30 concurrent | List becomes seconds-slow | `stats()` = 13 separate counts | One `FILTER` aggregate — **4.1× measured** |
| **P-03** | Dashboard | ~19 queries per load | **High** | ~30 concurrent | Dashboard 2.4 s at 100 users | Fan-out in one `Promise.all` | Consolidate; consider short-TTL cache |
| **P-04** | Infra | Prisma pool 25 | **High** | ~25 concurrent | Requests queue before reaching the DB | Default `cores×2+1` | Raise **after** P-02/P-03; size to `max_connections` ÷ processes |
| **P-05** | Inbox | IMAP cannot keep a 60 s cycle | **High** | ~120 mailboxes | Mail arrives late and unpredictably | `IMAP_POLL_CONCURRENCY=4` | Raise to ≥17, or lengthen the interval |
| **P-06** | Leads | `lead_calls: { none: {} }` anti-join | **Medium** | Large books | Adds to every list load | Prisma `none` relation filter | Folds into the P-02 single query |
| **P-07** | Storage | `inbound_emails` ≈ 56 kB/row | **Medium** | ~1 year | Disk growth dominates the database | Full message bodies retained | Set `MAIL_RETENTION_DAYS` / `MAIL_STRIP_BODIES_AFTER_DAYS` |
| **P-08** | Search | `ILIKE '%term%'` on five columns | **Medium** (latent) | Any broad-scope feature | Would full-scan 2.5M rows | Leading wildcard defeats btree | If broad search is ever added, use `pg_trgm` GIN |
| **P-09** | Config | `shared_buffers = 128 MB` | **Medium** | Now | More disk reads than necessary | PostgreSQL default | 25% of DB RAM |
| **P-10** | Export | Lead export builds CSV in the browser | **Low** | ~50k rows | Tab memory spike | Server returns JSON, client serialises | Already capped; move server-side if raised |

---

# 7. BACKGROUND JOBS AT 500 AGENTS

| Job | Frequency | Volume at 500 agents | Current design | Risk | Recommendation |
|---|---|---|---|---|---|
| **IMAP sync** | 60 s | 500 mailboxes | concurrency 4 | **Overruns 2–6×** | Concurrency ≥17, or 120–300 s interval |
| **Meta sync** | 900 s | 500 connections | per-user budget | 0.55 syncs/s — fine | Stagger to avoid a spike at the tick |
| **Lead task due** | 1800 s | Bounded `take: 500` | dedupe by unique index | Low | Raise the bound as books grow |
| **Campaign resume** | 60 s | Per campaign | state machine | Medium | Keep off the web processes |
| **Event reminders** | 600 s | Per event | dedupe row | Low | — |
| **Google retry** | 300 s | Failed events only | backoff | Low | — |
| **Notifications** | event-driven | bursts | `notifications_user_id_dedupe_key_key` unique index | **Low — DB-enforced** | — |

## IMAP arithmetic (CALCULATED)

500 mailboxes ÷ concurrency 4 = 125 batches per cycle:

| Per-mailbox time | Full cycle | vs 60 s interval |
|---:|---:|---|
| 1 s | 125 s | **2.1× overrun** |
| 2 s | 250 s | **4.2× overrun** |
| 3 s | 375 s | **6.3× overrun** |

Concurrency needed to fit 60 s at 2 s/mailbox: **17**.

**Not verified:** real IMAP round-trip time against Gmail/Outlook at scale, and their per-account
connection limits. The 1–3 s range is an assumption; the conclusion (the default does not fit) holds
across all three values.

## Scheduler duplication — the standing risk

`RUN_SCHEDULERS` defaults to **true** and Redis is not configured, so `clusterTick` falls through to
running. **The moment this deployment goes to 4 processes for P-01, all four run every scheduler** —
four IMAP pollers racing one mailbox, four campaign senders. Notification dedupe is protected by a
unique index; mail delivery is not.

**This is the direct collision between the fix for P-01 and the existing scheduler design, and it must
be handled in the same change.**

---

# 8. DATABASE GROWTH (CALCULATED from measured row sizes)

Measured: leads **613 B/row** (incl. indexes), notes 158, tasks 173, showings 157, calls 140.

Assuming 500 agents adding ~100 leads/month (600k leads/year) with proportional activity:

| Horizon | Leads | Leads + activities | `inbound_emails` | Total |
|---|---:|---:|---:|---:|
| Today | 2.5 M | **1.7 GB** | — | 1.7 GB |
| Year 1 | 3.1 M | ~2.1 GB | **~500 GB** | ~502 GB |
| Year 3 | 4.3 M | ~2.9 GB | ~1.5 TB | ~1.5 TB |
| Year 5 | 5.5 M | ~3.7 GB | ~2.5 TB | ~2.5 TB |

**The CRM's own data is trivial. Stored email is not.** `inbound_emails` measures **56 kB/row** in the
development database — full message bodies. At 500 agents × 50 messages/day that is ~9.1M rows and
**~500 GB per year**.

The application already has the controls (`MAIL_RETENTION_DAYS`, `MAIL_STRIP_BODIES_AFTER_DAYS`); the
development server logs that neither is set. **Setting a retention policy is the single highest-value
storage decision before 500-agent rollout.**

**ESTIMATED** — the email rate is an assumption. The 56 kB/row figure is **MEASURED**.

---

# 9. FRONTEND

**Reviewed by code inspection; not profiled in a browser under load — NOT VERIFIED where noted.**

## Already correct

- **Flicker is guarded.** `LeadsPage.tsx:154` — `if (!loadedOnce.current) setLoading(true)`. The
  full-screen loader appears on first load only; refetches leave existing rows on screen. This is
  exactly the behaviour the brief asks for, already implemented.
- **Search is debounced** (`useEffect` on `[search]`).
- **Pagination is server-side**, 25 rows per page — the DOM never holds 2.5M or even 5,000 rows, so
  virtualised rendering is **not needed**.
- **Export truncation is surfaced** to the user with instructions rather than silently capped.

## Risks

- **Lead export builds the CSV in browser memory** from a JSON array (`downloadCsv`). Capped today; if
  the cap is raised toward 100k rows this becomes a tab-memory problem. **P-10.**
- **Duplicate requests:** `useEffect(() => { void load(); }, [load])` where `load` is a `useCallback`
  over `[filters, page, toast]` — correct in principle, but a `toast` identity change would refetch.
  **NOT VERIFIED** — needs a network-trace check.
- **Browser memory over a long session:** **NOT VERIFIED.** No 2-hour soak was run.

**Frontend experience score: 78/100** — sound patterns, unverified under sustained real use. The
score is limited by what was not measured, not by defects found.

---

# 10. INFRASTRUCTURE RECOMMENDATION

Tied to measurements, not guessed.

| Component | Recommendation | Justification |
|---|---|---|
| **Node processes** | **4 minimum**, 6 preferred | 4.3 logins/s each → 4 gives ~17/s → 500 agents in ~30 s (**LOAD-TESTED**) |
| **App CPU** | 8 vCPU | 4 processes × ~1 core under load, plus headroom |
| **App RAM** | 8 GB | Measured RSS 507 MB/process at peak × 4, plus headroom |
| **PostgreSQL CPU** | 8 vCPU | DB is the work sink once fan-out is fixed |
| **PostgreSQL RAM** | 16 GB | Working set 1.7 GB today, ~4 GB at year 3; `shared_buffers` 4 GB |
| **`max_connections`** | 200 | 4 processes × 40 pool + schedulers + headroom |
| **Prisma `connection_limit`** | **40 per process** | After P-02/P-03; before that it only moves the queue |
| **`shared_buffers`** | **4 GB** (from 128 MB) | Default is unrelated to the machine |
| **Storage** | 100 GB + email retention policy | CRM data ~4 GB at 5 years; email dominates (§8) |
| **Redis** | **REQUIRED** | See below |
| **Workers** | **Separate process**, `RUN_SCHEDULERS=false` on web | Prevents the 4-process duplication in §7 |

## Redis: **REQUIRED for this capacity target** — not optional

Stated with evidence, per the brief:

1. **Scheduler coordination.** Moving to 4 processes for P-01 makes duplicate scheduler execution
   certain. `clusterTick` already implements the Redis lock and deliberately no-ops without Redis.
2. **Dashboard caching.** The 19-query dashboard is a prime short-TTL cache candidate.
3. **Session store** (optional) — PostgreSQL-backed sessions are indexed on `sid` and measured fine
   at 3,682 rows; not a reason on its own.

Redis is optional at today's scale. **At 500 agents across multiple processes it is load-bearing.**

---

# 11. BOTTLENECK RANKING

1. **`bcryptjs` on the event loop** — 4.3 logins/s/process (**LOAD-TESTED**)
2. **Leads `stats()` 13-count fan-out** — 4.1× throughput available (**MEASURED**)
3. **Dashboard 19-query fan-out** — 17 req/s at 100 users (**LOAD-TESTED**)
4. **Prisma pool of 25** — capped at 31 connections of 100 available (**MEASURED**)
5. **IMAP polling concurrency** — 2–6× cycle overrun at 500 mailboxes (**CALCULATED**)
6. **`shared_buffers` 128 MB** (**MEASURED** config)
7. **`inbound_emails` growth** — ~500 GB/year (**CALCULATED** from measured row size)
8. **Browser-side lead export** (**code analysis**)

Notably **absent**: table scans, missing indexes on the lead scope, deep-pagination decay, lock
contention, N+1 in lead detail, and slow search. All were specifically tested for and none was found.

---

# 12. REQUIRED OPTIMIZATIONS

## P0 — Required before 500-agent deployment

| Area | Problem | Change | Expected benefit | Risk | Tests required |
|---|---|---|---|---|---|
| Auth | 4.3 logins/s | Run **4+ Node processes** | 500 agents sign in ~30 s (measured) | Sessions already in PostgreSQL — compatible | Login storm; session survives across processes |
| Schedulers | 4 processes = 4× every job | `RUN_SCHEDULERS=false` on web; **one** worker, or Redis | Prevents duplicate client email | Must ship **with** the change above | One process logs sweeps; no duplicate mail |
| Leads | 13 counts per page load | One `FILTER` aggregate | **4.1× throughput** (measured) | Numbers must match exactly — verified equal | Counter parity old vs new; scope isolation intact |
| Config | `shared_buffers` 128 MB | Set to 25% of DB RAM | Fewer disk reads | None | Re-measure query plans |

## P1 — Required performance improvements

| Area | Problem | Change | Expected benefit | Risk | Tests |
|---|---|---|---|---|---|
| Dashboard | 19 queries | Consolidate + short-TTL cache | Largest remaining fan-out | Cache must be **per-user** — dashboards are scoped | Two agents never see each other's figures |
| Pool | 25 default | `connection_limit=40`/process | Removes the residual queue | Must fit `max_connections` | Connection count under load |
| Inbox | IMAP overruns | `IMAP_POLL_CONCURRENCY≥17` or longer interval | Mail arrives predictably | Provider connection limits | Full cycle within interval |
| Storage | 500 GB/year email | Set retention | Bounded growth | **Deleting client email is irreversible** — needs a policy decision | Retention job correctness |

## P2 — Scale and resilience

Redis for locks and cache · per-user dashboard cache · move lead-export serialisation server-side ·
monitoring (below).

## P3 — Future

`pg_trgm` GIN indexes **only if** a broad-scope search feature is introduced (P-08) · lead-detail
activity pagination **only if** leads exceed ~1,000 activities · read replica for reporting.

## Explicitly NOT recommended

- **Cursor/keyset pagination** — measured; OFFSET does not degrade within an agent's book.
- **Virtualised lead table** — server-side pagination already caps the DOM at 25 rows.
- **Denormalised counter tables** — the `FILTER` rewrite recovers 4.1× without the invalidation risk.
- **Lowering the bcrypt cost factor** — solve with threads, never by weakening hashing.

---

# 13. REGRESSION SAFETY

Every optimisation above must preserve, and be tested against: authentication · authorization ·
**lead privacy (`leadScopeWhere`)** · tenant isolation · ownership and assignment rules · audit
writes · notification dedupe · Meta dedupe · campaign dedupe.

**Two specific traps:**

1. The `stats()` rewrite must keep the scope predicate **inside** the single query. A `FILTER`
   aggregate that loses the `WHERE` scope would leak counts across agents' books — the numbers would
   look plausible and be wrong.
2. Dashboard caching must be **keyed per user**. A shared cache would show one agent another's
   pipeline, which is precisely what the privacy policy forbids.

---

# 14. MONITORING

API p50/p95/p99 · error rate · **event-loop lag** (the P-01 canary) · **logins/second** · CPU/RAM per
process · **DB connections in use vs pool** · slow-query log (>500 ms) · scheduler health (already on
`/api/health/workers`) · queue depth · IMAP cycle duration vs interval · Meta/campaign/notification
failures · **`inbound_emails` table size**.

The application already exposes schedulers, jobs, mail-sync staleness, audit failures, event-loop lag
and RSS on `GET /api/health/workers`. That is a good foundation — it needs collection and alerting,
not new instrumentation.

---

# 15. MODULE PERFORMANCE SCORES

| Module | Current performance | 500-user readiness | 2.5M-lead readiness | Main risk | Score |
|---|---|---|---|---|---:|
| Leads | 311 ms median / 674 ms heavy | After P-02 | **Ready** | 15-query fan-out | **62** |
| Dashboard | 157 ms median | After P-03 | **Ready** | 19-query fan-out | **60** |
| Notifications | 9–14 ms | **Ready now** | **Ready** | none found | **95** |
| Meta | ~125 ms | **Ready now** | **Ready** | 15-min tick spike | **85** |
| Calendar | ~150 ms | **Ready** | **Ready** | recurrence expansion untested at scale | **80** |
| Campaigns | ~190 ms | After P-01 | **Ready** | unbounded audience build | **72** |
| Inbox | ~240 ms | **After P-05** | n/a | IMAP cycle overrun | **58** |
| Settings | fast | **Ready** | n/a | none | **90** |
| Triggers | fast | **Ready** | n/a | none | **88** |
| Audit Trail | export 7,389 rows OK | **Ready** | **Ready** | growth over years | **82** |

---

# 16. VERDICTS

## 500-agent readiness

### **C. READY AFTER SPECIFIC OPTIMIZATIONS**

Not D — 500 agents cannot sign in acceptably today, measured. Not B — nothing here requires major
architectural work. The four P0 items are a configuration change, a deployment change, and one query
rewrite whose 4.1× gain has been measured.

## 2.5-million-lead readiness

### **READY**

No CRM query scans the leads table under normal role scopes. Median-agent operations run 54–311 ms
against 2.5M rows. Deep pagination does not decay. Zero lock contention. The privacy scope keeps every
query bounded to one agent's book.

## Can all 500 agents use it simultaneously?

### **YES, WITH CONDITIONS** — the four P0 items.

---

# 17. MANAGEMENT SUMMARY

## Target
**500 simultaneous agents / ~2,500,000 leads**

## Current CRM performance score

# **64 / 100**

Scored down for concurrency (login ceiling, query fan-out), not for data volume. The 2.5M-lead
handling alone would score in the 90s.

## Expected user experience

| Area | Today (single process) | After P0 (ESTIMATED from measured unit costs) |
|---|---|---|
| **Login** | 500 agents = **117 s** | ~30 s with 4 processes (measured) |
| **Dashboard** | 157 ms alone → 2.4 s at 100 users | Sub-second |
| **Leads list** | 311 ms alone → 3.6 s at 100 users | Sub-second (4.1× measured headroom) |
| **Search** | 128 ms alone, degrades with load | Sub-second |
| **Lead detail** | 215 ms → 2.7 s at 100 users | Sub-second |
| **Calendar** | 152 ms → 2.0 s at 100 users | Sub-second |
| **Inbox** | 241 ms; **mail arrives late** at 500 mailboxes | Fixed by P-05 |
| **Campaigns** | 191 ms | Unchanged |
| **Notifications** | 9–14 ms | Unchanged — best-performing module |

Post-fix figures are **ESTIMATED** by applying measured per-change gains. They are not themselves
load-tested, because the changes have not been made.

## Issues

- **Critical: 2** — P-01 login ceiling · P-02 Leads query fan-out
- **High: 3** — P-03 dashboard fan-out · P-04 connection pool · P-05 IMAP concurrency
- **Medium: 4** — P-06 anti-join · P-07 email storage · P-08 latent search risk · P-09 `shared_buffers`
- **Low: 1** — P-10 browser-side export

## Bottlenecks by layer

- **Database:** none structural. Query *count per request* is the issue, not query cost.
- **Frontend:** none proven. Export serialisation is the only identified risk.
- **Background jobs:** IMAP concurrency; scheduler duplication once multi-process.
- **Infrastructure:** one process; pool 25; `shared_buffers` 128 MB; no Redis.

## Required before production

1. Run **4+ Node processes** — and set `RUN_SCHEDULERS=false` on all but one **in the same change**.
2. Rewrite Leads `stats()` as a **single `FILTER` query** (4.1× measured).
3. Consolidate the **dashboard's 19 queries**.
4. Raise **`shared_buffers`** to 4 GB and **`connection_limit`** to 40/process.
5. Raise **`IMAP_POLL_CONCURRENCY`** to ≥17, or lengthen the interval.
6. Set an **email retention policy** before the inbox reaches ~500 GB/year.
7. **Provision Redis** for scheduler locking.

## Recommended after production

Per-user dashboard cache · server-side lead export · monitoring and alerting on the metrics in §14 ·
a **2-hour soak test** (not run here) · browser memory profiling (not run here).

## Features safe to leave alone

OFFSET pagination · the search implementation · lead-detail loading · table rendering ·
notification dispatch · the ownership-scope architecture, which is doing more for performance than
any index in the schema.

---

**Audit performed:** 2026-08-06 · **Application modified:** No · **Committed:** No
**Test artefacts:** `myapp_perf` database (1,725 MB) — drop when no longer needed. The development
database `myapp` was never written to.
**Note:** `docs/audit/` is untracked in git.
