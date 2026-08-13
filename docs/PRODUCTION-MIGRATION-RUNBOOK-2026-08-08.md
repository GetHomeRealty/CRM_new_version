# Production Migration Runbook — Single-Company Architecture

**Change:** remove multi-brokerage tenancy from the production database and deploy the
single-company build.
**Status:** NOT YET APPROVED FOR EXECUTION. This document is the plan; running it requires explicit
sign-off.
**Rehearsed:** 2026-08-08 against `myapp_staging_rehearsal`, a restore of the pre-migration backup
seeded to **2,500,655 leads / 500 users** — see §9 for the measurements this runbook rests on.

---

## 0. What this changes, in one paragraph

Two migrations. The first is **additive** and creates seven replacement constraints alongside the
tenant-shaped ones. The second is **destructive** and drops 86 `company_id` columns, 21 foreign keys
and 88 indexes. The two `leads` indexes are built **out of band with `CREATE INDEX CONCURRENTLY`
before either migration runs**, so the migrations themselves find them already present and skip
them. `company_settings`, `subscriptions` and `brokerages` are retained — they are business tables,
not tenancy.

---

## 1. Pre-deployment checks

Run every one. Record the output.

```bash
# 1.1  Which migrations production is on, and which are pending.
DATABASE_URL="$PROD_URL" npx prisma migrate status

#      EXPECTED: exactly three pending —
#        20260808140000_tenant_removal_replacement_constraints
#        20260808150000_tenant_removal_drop_company_id
#        20260808180000_calendar_google_disconnected_at
#      If MORE are pending, stop: production has drift this runbook has not rehearsed.
#
#      THE THIRD ONE IS NOT OPTIONAL AND IS NOT PART OF THE TENANCY WORK. It adds
#      calendar_events.google_disconnected_at, which the Google Calendar disconnect fix WRITES on
#      every disconnect. Deploy that code against a database without the column and the write fails
#      with "column does not exist" — so disconnecting Google would 500 instead of merely leaving
#      stale events behind, which is worse than the defect it fixes. Apply the migration before, or
#      in the same window as, the code.
```

```sql
-- 1.2  Schema shape: the starting state this runbook assumes.
SELECT count(*) AS company_id_columns
  FROM information_schema.columns WHERE table_schema='public' AND column_name='company_id';
-- EXPECTED: 86

SELECT count(*) AS tenancy_fks
  FROM pg_constraint WHERE contype='f' AND confrelid='company_settings'::regclass;
-- EXPECTED: 21

-- 1.3  THE PRECONDITION THAT MATTERS. Every company_id must be 1. The destructive migration
--      re-checks this and refuses, but knowing before the window starts is the point.
SELECT string_agg(t, ', ') AS tables_with_foreign_rows FROM (
  SELECT table_name AS t FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.column_name='company_id'
     AND (SELECT count(*) FROM company_settings) > 1
) x;
-- Simpler and sufficient:
SELECT count(*) AS company_settings_rows FROM company_settings;   -- EXPECTED: 1
```

```sql
-- 1.4  Disk. The two new leads indexes are built BEFORE the old ones are dropped, so peak usage is
--      higher than the steady state. Rehearsed sizes on 2.5M leads:
--        new  leads_owner_email_key   145 MB
--        new  leads_email_lower_idx   125 MB
--      Both exist alongside the old 237 MB + 242 MB until the destructive migration.
--      Require at least 1 GB free, which is ~3× the transient need.
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
```

```sql
-- 1.5  Database health and capacity.
SELECT count(*) AS connections, (SELECT setting FROM pg_settings WHERE name='max_connections') AS max
  FROM pg_stat_activity WHERE datname = current_database();

-- 1.6  Nothing long-running that would sit behind, or in front of, the DDL.
SELECT pid, state, now()-xact_start AS age, left(query,80) AS query
  FROM pg_stat_activity
 WHERE datname = current_database() AND state <> 'idle' AND now()-xact_start > interval '1 minute';
-- EXPECTED: no rows. CREATE INDEX CONCURRENTLY WAITS for existing transactions to finish before it
-- starts, so an idle-in-transaction session will stall the build indefinitely.
```

```bash
# 1.7  Application and worker configuration.
#      ecosystem.config.cjs defines the topology: N × crm-web (RUN_SCHEDULERS=false) and
#      exactly ONE crm-worker (RUN_SCHEDULERS=true, port 8001). Confirm before deploying that
#      no second process has RUN_SCHEDULERS=true — two schedulers means two of every reminder.
pm2 list
pm2 env <crm-worker-id> | grep RUN_SCHEDULERS     # expect true, on this process only
```

```bash
# 1.8  Backup destination reachable and has room.
node scripts/backup.mjs --help          # confirm BACKUP_ROOT resolves where you expect
df -h "$BACKUP_ROOT"
```

---

## 2. Backup — and this one, not the August 8 development sets

The `20260808-131911` and `20260808-140904` sets are **development** backups. They are not a
rollback path for production. Take a fresh one immediately before the window.

```bash
DATABASE_URL="$PROD_URL" node scripts/backup.mjs
# Records the dump, the storage tree and a sha256 manifest.

DATABASE_URL="$PROD_URL" node scripts/restore.mjs --set <new-set-id> --verify
# Restores into a scratch database, counts rows in every critical table, drops the scratch.
# EXPECTED: "RESTORE VERIFIED — every checked table came back with rows."
```

**Do not proceed if the verify step does not print that line.** A backup that has not been restored
is a hypothesis.

Record: set id, dump bytes, sha256, and the row counts printed.

---

## 3. Deployment sequence

Order matters, and the reason is the scheduler. The new build no longer writes `company_id`; the old
build does. The column keeps its `DEFAULT 1` until the destructive migration, so **the new build is
safe against the old schema** — which is what makes this order possible without downtime.

| # | Action | Why here |
|---|---|---|
| 1 | **Stop `crm-worker`** (`pm2 stop crm-worker`) | Schedulers must not run during the DDL. This is the only process with `RUN_SCHEDULERS=true` |
| 2 | Deploy the new build to all `crm-web` instances, reload one at a time (`pm2 reload crm-web`) | Rolling: the new build works against the *old* schema, so web stays up throughout |
| 3 | Verify web health | `/api/health` and `/api/health/ready` on each instance |
| 4 | **§4 — build the two indexes CONCURRENTLY** | Non-blocking; web keeps serving |
| 5 | **§5 — run the two migrations** | Short; see the honesty note in §5 |
| 6 | Deploy the new build to `crm-worker` and start it (`pm2 start crm-worker`) | Schedulers resume last, against the final schema |
| 7 | **§6 — post-migration verification and smoke tests** | |

---

## 4. The index build — the rehearsed, non-blocking path

**Run these BEFORE `prisma migrate deploy`.** Both migration files use `IF NOT EXISTS`, so once these
succeed the in-migration statements become no-ops and never take a blocking lock.

`CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**, which is why it is done here
rather than inside the migration.

```sql
-- 4.1  The per-book uniqueness rule. Rehearsed: 9.3 s on 2.5M rows.
CREATE UNIQUE INDEX CONCURRENTLY "leads_owner_email_key"
  ON "leads" (COALESCE("owner_user_id", 0), LOWER("email"));

-- 4.2  The brokerage-wide lookup. Rehearsed: 9.4 s on 2.5M rows.
CREATE INDEX CONCURRENTLY "leads_email_lower_idx"
  ON "leads" (LOWER("email"));
```

### Monitor while they run

```sql
-- Progress (PostgreSQL 12+).
SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total
  FROM pg_stat_progress_create_index;

-- Locks on leads. Rehearsed and observed: AccessShareLock, RowExclusiveLock,
-- ShareUpdateExclusiveLock. ACCESS EXCLUSIVE must NEVER appear — if it does, the statement is not
-- the concurrent form and should be cancelled.
SELECT l.mode, l.granted, count(*)
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
 WHERE c.relname = 'leads' GROUP BY 1,2;

-- Anyone waiting.
SELECT count(*) FROM pg_stat_activity
 WHERE datname = current_database() AND wait_event_type = 'Lock';
```

### If a build fails

A failed `CREATE INDEX CONCURRENTLY` leaves an **invalid** index behind. Rehearsed end to end.

```sql
-- Detect.
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
 WHERE t.relname='leads' AND NOT i.indisvalid;

-- The planner IGNORES an invalid index, so live queries are unaffected — verified in rehearsal.
-- Clean it up. This is itself non-blocking (rehearsed: 89 ms).
DROP INDEX CONCURRENTLY "<name>";

-- Fix the cause, then simply run the CREATE again. Rehearsed: a retry after removing a duplicate
-- succeeded in 7.7 s. The procedure is resumable; nothing needs unwinding.
```

The realistic cause of failure on `leads_owner_email_key` is a genuine duplicate — the same address
twice in one agent's book. Find them before the window:

```sql
SELECT COALESCE(owner_user_id,0) AS book, lower(email) AS address, count(*)
  FROM leads GROUP BY 1,2 HAVING count(*) > 1;
-- Any rows here must be merged or reassigned by a person. Do not resolve them automatically:
-- which of two records is the real one is a business decision.
```

---

## 5. The migrations

```bash
DATABASE_URL="$PROD_URL" npx prisma migrate deploy
```

Rehearsed: **3.8 s total** for both migrations on a 2.5M-row database, with lead traffic running.

**Honesty note on locking.** §4 is genuinely non-blocking. The *destructive* migration is not: 86
`ALTER TABLE ... DROP COLUMN` statements each take a brief `ACCESS EXCLUSIVE` lock. `DROP COLUMN` in
PostgreSQL is a catalogue operation — it does not rewrite the table — which is why 86 of them
complete in seconds rather than minutes. Expect a **short stall of a few seconds**, not a
maintenance window. If you want zero stall, schedule §5 in a quiet minute; §4, the part that would
otherwise have taken minutes, is already out of the way.

Set a lock timeout so a stall cannot become an outage:

```sql
SET lock_timeout = '10s';   -- in the session running the migration
```

If the migration fails partway, it is transactional: nothing is applied. Mark it rolled back and
investigate before retrying:

```bash
DATABASE_URL="$PROD_URL" npx prisma migrate resolve --rolled-back 20260808150000_tenant_removal_drop_company_id
```

---

## 6. Post-migration verification

```sql
-- 6.1  The removal actually happened.
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='public' AND column_name='company_id')            AS company_id_columns,   -- 0
       (SELECT count(*) FROM pg_constraint
         WHERE contype='f' AND confrelid='company_settings'::regclass)        AS tenancy_fks,          -- 0
       (SELECT count(*) FROM pg_indexes
         WHERE schemaname='public' AND indexdef LIKE '%company_id%')          AS tenancy_indexes;      -- 0

-- 6.2  The replacements are all present.
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (
  'crm_email_settings_singleton_key','subscriptions_singleton_key','crm_settings_global_key',
  'leads_owner_email_key','leads_email_lower_idx','meta_lead_forms_page_form_v2_key',
  'roles_key_key','mfa_policies_role_key') ORDER BY 1;
-- EXPECTED: all 8.

-- 6.3  No invalid indexes anywhere.
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE NOT i.indisvalid;
-- EXPECTED: no rows.

-- 6.4  Nothing was lost. Compare every number against the backup manifest from §2.
SELECT 'users' t, count(*) n FROM users
UNION ALL SELECT 'leads', count(*) FROM leads
UNION ALL SELECT 'leads with an owner', count(*) FROM leads WHERE owner_user_id IS NOT NULL
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'documents', count(*) FROM documents
UNION ALL SELECT 'invoices', count(*) FROM invoices
UNION ALL SELECT 'roles', count(*) FROM roles
UNION ALL SELECT 'permission grants', count(*) FROM role_permissions
UNION ALL SELECT 'mail accounts', count(*) FROM mail_accounts
UNION ALL SELECT 'google connections', count(*) FROM google_connections
UNION ALL SELECT 'meta connections', count(*) FROM meta_connections
UNION ALL SELECT 'co-op brokerages', count(*) FROM brokerages
ORDER BY 1;

-- 6.5  The business tables that must survive.
SELECT id, name, invoice_prefix, next_invoice_no, currency FROM company_settings;   -- exactly 1 row
SELECT crm_enabled, transaction_enabled, status, plan FROM subscriptions;           -- exactly 1 row

-- 6.6  The new index is the one being chosen.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM leads WHERE lower(email) = lower('probe-that-does-not-exist@example.invalid') LIMIT 1;
-- EXPECTED: Index Scan using leads_email_lower_idx. Rehearsed at 0.064 ms / 3 buffers on 2.5M rows.

-- 6.7  Table statistics, so the planner is not working from pre-migration estimates.
ANALYZE leads;
```

```bash
# 6.8  Application health, every instance.
curl -s https://<host>/api/health
curl -s https://<host>/api/health/ready
# EXPECTED: database ok, storage ok, authorization "N roles, M grants", queues ok.

# 6.9  Scheduler health — the worker only.
curl -s http://<worker-host>:8001/api/health/workers
```

### Smoke tests — by hand, as a real user

| # | Check | Passing looks like |
|---|---|---|
| 1 | Sign in as an admin | Session established; dashboard renders |
| 2 | Sign in as an agent | Sees own book only |
| 3 | Lead list, page 1 and a deep page | Rows render; counts present |
| 4 | Lead search | Results scoped to the caller |
| 5 | **Create a lead** | Saves — exercises the new unique index |
| 6 | **Create a lead with an address already in that agent's book** | Refused with the duplicate message, not a 500 — proves the unique index is the *right* one |
| 7 | Create the same address as a **different** agent | Allowed — proves it is per book, not global |
| 8 | Campaign: build an audience, save a draft | Audience resolves; no cross-agent leakage |
| 9 | Inbox: mail accounts list, open a message | Own mail only |
| 10 | Calendar: list, create an event | Own events only |
| 11 | CRM Settings and Transaction Desk Settings | Both load; remain separate |
| 12 | Google / Meta connection status | Still connected — tokens untouched |
| 13 | Audit trail | Recent entries present |
| 14 | Invoice number | `next_invoice_no` unchanged from §1 |

---

## 7. Rollback

**Before the destructive migration (§5):** nothing to roll back at the data level. Drop the two new
indexes if you want the database byte-identical:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "leads_owner_email_key";
DROP INDEX CONCURRENTLY IF EXISTS "leads_email_lower_idx";
```
Redeploy the previous build. The old build works against the additive-only schema, because nothing
has been removed.

**After the destructive migration:** the columns are gone and there is **no forward path back** —
restore from the §2 backup.

```bash
DATABASE_URL="$PROD_URL" node scripts/restore.mjs --set <set-id> --into <prod-db> --force
# Then copy the backup's storage tree over STORAGE_ROOT, and redeploy the previous build.
```

Everything written between the backup and the restore is lost. That is the cost of crossing §5, and
it is the reason §2 is not optional and the reason §5 should be a short, attended step.

---

## 8. Decision points that need a person

1. **Duplicate addresses within one agent's book** (§4). Merging or reassigning is a business call.
2. **Timing of §5.** A few seconds of stall; pick the minute.
3. **Whether to drop the now-redundant `leads_email_idx`.** It is a 214 MB plain index on `email`
   that overlaps `leads_email_lower_idx`. Not part of this change and not rehearsed — raise it
   separately.

---

## 9. What the rehearsal measured

`myapp_staging_rehearsal`: a restore of the pre-migration backup, seeded to 2,500,655 leads / 500
users, confirmed to start with 86 `company_id` columns and the three original `leads` indexes.

| Measurement | Result |
|---|---|
| `leads_owner_email_key` CONCURRENTLY | **9.3 s** (2.5M rows, under write load) |
| `leads_email_lower_idx` CONCURRENTLY | **9.4 s** |
| Both migrations (`migrate deploy`) | **3.8 s** |
| Lock modes seen on `leads` during the build | AccessShareLock, RowExclusiveLock, ShareUpdateExclusiveLock |
| **ACCESS EXCLUSIVE during the build** | **never observed** |
| Max sessions waiting on a lock | 1 (momentary) |
| Lead traffic during the build | **193,916 operations, 0 failed** — create / duplicate-check / update / list, p95 1 ms each |
| Failed-build recovery | invalid index detected, ignored by the planner, `DROP INDEX CONCURRENTLY` in 89 ms, retry succeeded in 7.7 s |
| Index size change | `leads_email_lower_idx` 242 → **125 MB**; `leads_owner_email_key` 237 → **145 MB** |
| Duplicate check after migration | **0.064 ms**, Index Scan, 3 buffers |

---

*Rehearsal performed 2026-08-08. This runbook has not been executed against production.*

---

## 10. Amendment — Redis is now live in production (2026-08-08)

This runbook was written when production had **no Redis**: queues ran in-process and died on
restart, the dashboard cache was a no-op, and scheduler single-execution rested entirely on
`RUN_SCHEDULERS=false` being correct on every web process. The operator has since installed and
configured Redis on the production server. Three things in the plan change, and one new check is
required.

### 10.1 Queues are now DURABLE — this is the substantive change

Previously a job that had not run by the time the process stopped was simply gone, so a deployment
could not carry work across a version boundary. With Redis, BullMQ persists the queue: **a job
enqueued by the old build will be consumed by the new build.**

Verified before writing this, because it decides whether the deploy is safe:

* `src/queue/` is **untouched** by the tenancy work — `git diff --stat` over the module is empty, so
  the driver, the queue names and the job-options contract are byte-identical across the two builds.
* No enqueue site's payload changed. The two producers (`lead-import-job`, `export-job`) put an
  **id** on the queue and nothing else; the job's real state lives in `lead_import_jobs` and
  `export_jobs` in PostgreSQL. A job in flight across the deploy therefore carries no field that the
  new build could misread.
* Neither of those tables is touched by the destructive migration beyond losing `company_id`, which
  the new build never reads.

**Conclusion: no queue drain is required before deploying.** In-flight jobs are safe across the
version boundary. This paragraph exists so that conclusion is on the record rather than assumed —
had a payload changed, the queue would have needed draining first, and nothing in the original
runbook would have said so.

### 10.2 The dashboard cache is now live

The CRM dashboard is cached per user for **20 seconds** (`CacheService.TTL.dashboard`), keyed
`crm:{userId}:{sa|own}`. That key is unchanged between the two builds, and both compute the same
figures — tenancy removal deleted a predicate that matched every row, so no aggregate changes value.

**No cache flush is required.** Any entry computed by the old build is correct for the new one, and
in the worst case is replaced within 20 seconds. If you want certainty anyway, after the deploy:

```bash
redis-cli -a '<password>' --scan --pattern 'ghr-prod:dashboard:*' | xargs -r redis-cli -a '<password>' del
```

### 10.3 Scheduler single-execution is now belt AND braces

`clusterTick` now takes a real distributed lock rather than trusting configuration. **Step 1 of §3 —
stopping `crm-worker` before the DDL — is still required and must not be skipped.** The lock stops
two processes running the *same* sweep; it does not stop a sweep running *during* a schema change,
which is what that step is for.

### 10.4 New pre-deployment check — run this first

Redis has not been independently verified on the production server. Add to §1:

```bash
# 1.9  Redis, on the production server. Exits non-zero on any failure.
cd /path/to/app/server && node scripts/verify-redis.cjs
```

It checks the four things that each fail **silently**: the server version against BullMQ's floor,
`maxmemory-policy noeviction` (any other policy means an evicted job is a job that never runs), the
key prefix (two environments sharing one prefix means staging reads production's cached permission
maps), and that `SET NX` is genuinely atomic across connections.

**If it fails, do not proceed.** A misconfigured Redis is worse than none: `RedisService.enabled()`
becomes true, `QueueService` switches to BullMQ, and the in-process fallback is no longer in the
path — so the failure surfaces as work that quietly never runs.

Also confirm the expected `REDIS_PREFIX` (`ghr-prod`) is not shared with staging.

### 10.5 Post-migration verification — additions to §6

```bash
# Redis reports connected rather than "not configured".
curl -s https://<host>/api/health/ready
# EXPECTED: "redis":{"ok":true, …} — previously: "not configured — caching and distributed queues are off"
```

Boot log should now read:

```
[RedisService] Redis is connected (prefix "ghr-prod:").
```

and the two lines it replaces — `REDIS_URL is not set …` and `Queues are running in-process …` —
should be **absent**. If either still appears, the application did not pick up `REDIS_URL` and is
running in the fallback path regardless of the server being up.

Add to the smoke tests: queue a **CSV lead import** and a **bulk export**, and confirm both complete.
Those are the two producers, and they are the only user-visible exercise of the BullMQ path.

### 10.6 Rollback is unchanged, and Redis does not complicate it

Nothing is stored **only** in Redis — it is a faster path to what PostgreSQL already holds. Comment
out `REDIS_URL`, restart, and the application returns to in-process queues and an uncached dashboard.
The one consequence worth stating: **queued-but-unrun jobs sitting in Redis are abandoned by that
rollback**, because the in-process driver cannot see them. They are not lost, though. Both
producers record their state in PostgreSQL with a `Queued` status, and both services re-enqueue
every `Queued` row at boot (`onModuleInit` in each). Note the gate: that reclaim runs only where
`schedulersEnabled()` is true — the `crm-worker` process — so the rollback is only complete once
the worker has been restarted, not merely the web instances.
