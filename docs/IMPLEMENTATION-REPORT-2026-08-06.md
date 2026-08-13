# Implementation Report

**Date:** 2026-08-06
**Scope:** authentication hardening, multi-factor authentication, background queue and Redis layer,
and the complete notification platform.

**Two areas were deliberately excluded from this version** at the client's decision — Opportunity
Management (sales pipeline / Kanban) and Google Calendar *calendar selection*. Both are recorded in
§13 as deferred rather than incomplete.

---

## 1. Requirement status

| Requirement | Status | Notes |
|---|---|---|
| Password hashing standardisation | **Complete** | One service, one cost, opportunistic upgrade on sign-in |
| Authentication & session security | **Complete** | Two exploitable vulnerabilities found and fixed |
| Multi-factor authentication | **Complete** | TOTP, email OTP, SMS OTP, recovery codes, trusted devices, policy, admin reset |
| Background job queue | **Complete** | Driver-based; in-process today, BullMQ when Redis exists |
| Redis integration | **Complete (optional by design)** | Absent Redis is a supported configuration — see §7 |
| Notification Center | **Complete** | Merged feed, history, counts, mark read / mark all read |
| Notification preferences | **Complete** | Per category **and per channel** |
| Notification delivery | **Complete** | One dispatcher; all 20 deliverable routes live |
| Team chat mentions | **Complete** | New feature: parsing, resolution, access rule, autocomplete |
| Google Calendar connection | **Complete** | Pre-existing and verified; not rebuilt |
| Google Calendar *selection* | **Deferred** | Excluded from this version by decision |
| Opportunity Management / Kanban | **Deferred** | Excluded from this version by decision |

---

## 2. Existing functionality reused, not rebuilt

The audit register was stale in places, and verifying before building saved substantial rework.

| Believed missing | Actually present | What was done |
|---|---|---|
| Google Calendar frontend | `GoogleCalendarCard.tsx` — connect, OAuth return, status, last sync, errors, manual sync, retry, disconnect | **Nothing rebuilt.** 6 of 7 required features already existed |
| Notification preferences page | `NotificationPreferencesPage.tsx` with service, controller, table and tests | **Extended** to a channel matrix rather than replaced |
| Notification bells | Two bells in `DeskLayout`, four backend feeds | **Left untouched**; the Centre reads the same sources |
| Worker monitoring | `worker-health.ts` registry + `/health/workers` | **Reused** for queue handlers instead of a second system |
| Scheduler process gating | `RUN_SCHEDULERS` | **Reused** to decide which process runs queue handlers |
| Transaction access rule | `ResourceAccessService.assertTransaction` | **Reused** for mentions via a new boolean wrapper — one rule, not two |
| Document review email | `DocumentMailService.sendReviewOutcome` | **Kept**, gated on preference rather than replaced |
| Idempotent insert convention | `createMany({ skipDuplicates })` in `reminder-sweep` | **Matched**, after independently hitting the same trap |

---

## 3. New features built

### Authentication
- `PasswordHashService` — the single place a password is hashed or verified. Admin-created accounts
  had been hashed at a hardcoded cost 10 while configuration said 12; since public registration is
  closed, that was the cost of nearly every password in the system.
- Opportunistic rehash on sign-in: the one moment both the plaintext and the stale hash are in hand.

### Session security — two vulnerabilities fixed
- **Session fixation.** `login()` set `userId` on the session the visitor arrived with; the comment
  claimed a regeneration that did not exist. Proved by exploit: a pre-login cookie answered **200**
  on `/api/user` after the victim signed in. Fixed with `session.regenerate()` plus CSRF rotation.
- **LIKE wildcards in the login string.** `mode: 'insensitive'` compiles to ILIKE, whose right side
  is a *pattern*. Proved by exploit: `login('ZZ%@probe.test', <that account's password>)` succeeded.
  Fixed with parameterised `lower(x) = lower($1)`, which also restores index use.

### Multi-factor authentication
TOTP (hand-written, RFC-verified), email and SMS one-time codes behind a provider abstraction,
recovery codes, trusted devices, per-role enforcement policy with grace period, administrator reset,
full frontend, audit logging. Detailed in `PHASE-3-MFA-2026-08-06.md`.

### Background queue
Driver interface with two implementations. The in-process driver is the production path today and
implements retries, exponential backoff, dead-letter parking, cancellation, progress, a concurrency
cap and job-id de-duplication. The BullMQ driver activates on `REDIS_URL`.

### Notification platform
- **Notification Center** — one feed over five sources, with history the bells never had.
- **Per-channel preferences** — in-app / email / push, per category.
- **NotificationDispatcher** — one decision system for every event.
- **Team chat mentions** — a genuinely new capability, described in §11.

---

## 4. Files changed

**51 modified, 34 added.** Grouped by why.

### Added — server
| File | Purpose |
|---|---|
| `auth/password-hash.service.ts` | The only place a password is hashed or verified |
| `auth/mfa/totp.ts` | RFC 4648/4226/6238 — no dependency added |
| `auth/mfa/mfa-crypto.ts` | AES-256-GCM secret sealing; refuses plaintext |
| `auth/mfa/mfa.service.ts` | Enrolment, verification, replay defence, admin reset |
| `auth/mfa/recovery-code.service.ts` | Single-use codes, hashed |
| `auth/mfa/trusted-device.service.ts` | "Do not ask again on this device" |
| `auth/mfa/otp-delivery.service.ts` | Email/SMS provider abstraction |
| `auth/mfa/mfa-policy.service.ts` | Per-role requirement with grace period |
| `auth/mfa/mfa.controller.ts`, `mfa.dto.ts` | Self-service and admin endpoints |
| `redis/redis.service.ts` | Optional connection, command deadlines, health |
| `redis/cache.service.ts` | Namespaced, TTL'd, degrades to "miss" |
| `redis/cluster-tick.ts` | Single-execution for scheduled sweeps |
| `queue/queue.types.ts` | The contract both drivers implement |
| `queue/in-process.driver.ts` | The production queue today |
| `queue/bullmq.driver.ts` | The Redis-backed driver |
| `queue/queue.service.ts`, `queue.controller.ts`, `queue.module.ts` | Wiring and monitoring |
| `notifications/notification-center.service.ts` | The merged feed |
| `notifications/notification-dispatcher.service.ts` | One decision system |
| `notifications/notification-dispatcher.module.ts` | Light module so anything may import it |
| `transactions/mention.service.ts` | Mention resolution and the access rule |

### Added — client
`NotificationCenterPage.tsx`, `TwoFactorCard.tsx`, `MfaChallenge.tsx`, `lib/mfaApi.ts`,
`lib/notificationCenterApi.ts`.

### Modified — the notable ones
| File | Why |
|---|---|
| `auth/auth.controller.ts` | Session regeneration, CSRF rotation, MFA challenge flow |
| `auth/auth.service.ts` | ILIKE → equality; hashing through the shared service |
| `users/users.service.ts` | Hashing through the shared service |
| `observability/health.controller.ts` | Redis and queue reported, without failing readiness |
| `transactions/reminder-sweep.service.ts` | Cluster lock; push dispatch |
| `inbox/imap-sync.service.ts` | Cluster lock; new-mail dispatch |
| `calendar/event-reminder.service.ts` | In-app dispatch |
| `documents/documents.service.ts`, `document-mail.service.ts` | Push dispatch; email gated on preference |
| `transactions/transaction-review.service.ts` | Push dispatch |
| `transactions/messages.service.ts` | Mentions: resolution, storage, dispatch |
| `core/resource-access.service.ts` | `canReachTransaction` — the same rule, answered not thrown |
| `core/tenancy.spec.ts`, `core/tenant-context.spec.ts` | New tables classified; new `runAsSystem` uses justified |
| `config/rate-limits.spec.ts` | New rate-limited endpoints accounted for |
| `core/module-access.spec.ts` | Assertion corrected — see §12 |

---

## 5. Database changes

### New tables (10)
`user_mfa_methods`, `mfa_recovery_codes`, `mfa_trusted_devices`, `mfa_challenges`, `mfa_policies`,
`notifications`.

### Altered
- `notification_preferences` — added `channel`; uniqueness moved to `(user_id, category, channel)`
- `transaction_messages` — added `mentions`

### Migrations (all applied to `myapp` and `myapp_test`)
| Migration | Contents |
|---|---|
| `20260806120000_mfa` | Five MFA tables, indexes, cascade FKs |
| `20260806160000_notification_channels` | Channel dimension, defaulting to `push` |
| `20260806190000_in_app_notifications` | In-app notification store |
| `20260806220000_message_mentions` | `mentions` column |

**The channel default is `'push'` and that is load-bearing.** Every pre-existing row was written by
somebody muting a *push* notification — the old screen said so in as many words. Any other default
would have silently reinterpreted a choice the person never made.

**All migrations are additive.** No column is dropped, no data rewritten; each is safe to apply to a
live database while it is serving.

---

## 6. Queue architecture

```
module  →  queue.add(name, payload, { attempts, backoffMs, jobId })
             ↓
        REDIS_URL set?  ──no──►  in-process driver   (this deployment today)
             │yes
             ▼
        BullMQ driver
```

**Queues:** `email`, `sms`, `reminder`, `calendar-sync`, `notification`, `export`.

**Guarantees (both drivers):** retries with exponential backoff, dead-letter parking after the
attempt budget, `jobId` de-duplication, progress reporting, cooperative cancellation, per-queue
concurrency cap, and every run recorded in the existing worker-health registry.

**Workers vs web.** Handlers register only where `schedulersEnabled()` is true, reusing
`RUN_SCHEDULERS`. A web process with the flag off still *enqueues*; a dedicated worker process runs
the jobs.

**Monitoring:** `GET /api/queues` (Super Admin) reports the live driver, Redis health and every queue
depth; `/api/queues/dead` lists exhausted jobs, with retry and cancel endpoints. Dead-lettered jobs
also surface in `/api/health/ready`, because silently-not-happening work should be visible.

**Honest limits of the in-process driver**, stated in its own header: jobs do not survive a restart,
and it does not coordinate across processes. Both are exactly what Redis buys.

---

## 7. Redis usage

**Redis is optional, and that is the central design decision** — this deployment has none in
production. Its absence is a supported configuration, not a degraded one.

| Configuration | Behaviour |
|---|---|
| `REDIS_URL` unset | Nothing connects. Queues run in-process, caching is off, everything behaves as before. |
| Set and healthy | BullMQ queues, namespaced cache, distributed locks for scheduled sweeps. |
| Set but unreachable | Application keeps serving from Postgres; readiness reports `degraded`, not down. |

**What Redis stores when present:** queue jobs, cached values (namespaced, always TTL'd), and
single-execution locks for scheduled sweeps.

**What it deliberately does NOT store:** sessions. Those remain in Postgres. Moving them would
re-open the session-fixation and CSRF work verified in Phase 2 for no benefit the queue needs.

**What was deliberately not cached:** the permission/authorization path. It is already cached
in-process (`ModuleAccessService` 10s licence cache, `RolePermissionStore` at start-up,
`user_modules` riding along on the record `AuthGuard` already loaded). Redis there would trade ~1ms
of local work for a network hop *plus* staleness on an authorization decision.

**Every Redis command has a hard deadline.** BullMQ requires `maxRetriesPerRequest: null` — "never
give up on a command" — so against an unreachable Redis those promises never settle. The first
version hung `/api/health/ready` indefinitely, which would have pulled a healthy deployment out of
the load balancer during a Redis outage. Measured, then fixed, then sensitivity-checked.

---

## 8. Notification platform

### Delivery flow
```
event  →  dispatch({ category, userId, title, link, dedupeKey })
            ↓
      recipient exists and is active?
            ↓
      channelsFor(user, category)        ← one query
            ↓
   in-app          email            push
   notifications   MailerService    WebPushService
            ↓
   DispatchResult { delivered[], skipped[{channel,reason}], failed[{channel,error}] }
```

Nothing throws at the caller. Skips carry a reason — `muted`, `unsupported`, `no_address`,
`not_configured`, `duplicate` — because "the user turned it off" and "no sender exists" mean very
different things to whoever reads the log.

`channels: []` restricts delivery for sites that already send their own email or push. **Naming a
channel asks for it; it does not force it** — a muted channel stays muted, and no call site outranks
the person's preference.

### The final matrix — 20 live / 0 pending / 1 unsupported

| Category | In-app | Email | Push |
|---|---|---|---|
| Calendar reminders | ✔ | ✔ | ✔ |
| Listing expiry | ✔ | ✔ | ✔ |
| Lawyer details | ✔ | ✔ | ✔ |
| Document review | ✔ | ✔ | ✔ |
| Transaction approvals | ✔ | ✔ | ✔ |
| New inbox emails | ✔ | — | ✔ |
| Team chat mentions | ✔ | ✔ | ✔ |

The single dash is deliberate: emailing somebody to say they have an email is a loop nobody wants.
It is `unsupported`, the API refuses to store a preference for it, and the test pins it **by name**
so it cannot be "fixed" by accident.

### Notification Center
One feed over five sources — four derived (`audit_logs` ×2, `transaction_reviews`,
`transaction_reminders`) and one stored (`notifications`). Filters unread / read / all, search,
pagination, per-source narrowing, mark one read, mark all read, and every row links to its record.

**No table replaced the derived sources.** They already record whether they have been seen; a table
would have meant a second copy of every event kept in step forever. The `notifications` table was
added later, and only because two categories — chat mentions and inbox mail — have no derived source
to read.

---

## 9. Team chat mentions

A new capability. Previously the application had no mention parsing, no user resolution, no
recipient rules and no mention event.

**Decisions, all as agreed:**

| Decision | Implementation |
|---|---|
| Who may be mentioned | Only people who can already open the transaction — enforced in the API *and* in the autocomplete |
| Free-text vs selected | User-ID-backed. `@` opens a scoped autocomplete; the id is sent, the name is only displayed |
| Self-mention | Allowed in text, never notifies |
| Multiple mentions | Allowed; deduplicated per person per message |
| Edited messages | New mention notifies; already-notified does not; nothing is retracted; in-app remains as history |

**The security rule.** Ids from the client are a *request*, never a decision:
drop the author → must exist → must be active → **must be able to open this deal** → allowed.
The check delegates to the same `assertTransaction` the chat itself enforces, because restating the
rule is how two copies drift — and the drift here would be telling an outsider that a deal exists.

Only honoured mentions are stored, so the thread's highlighting and the people actually notified are
the same set.

---

## 10. Testing

| Suite | Result |
|---|---|
| Server (jest) | **1330 passed / 1330**, 90 suites |
| End-to-end (Playwright) | **374 tests**, 25 files |
| New server tests added | **304**, across 12 new spec files |
| TypeScript (server + client) | clean |
| Builds (`nest build`, `vite build`) | clean |
| Application boot | verified in all three Redis states |

### Sensitivity checking
Every fix was reverted and the suite re-run, because a test that cannot fail is not coverage.

| Reverted | Result |
|---|---|
| `lower(x) = lower($1)` → `ILIKE` | 5 wildcard tests fail |
| `session.regenerate()` removed | 2 fixation tests fail |
| `cookie.maxAge` before regeneration | remember-me test fails |
| `ScreenGuard` off `MfaAdminController` | 2 authorization tests fail |
| Redis command deadline removed | health test hangs to timeout |
| `createMany({skipDuplicates})` → `create` + catch | transaction-abort test fails |
| Mention access check removed | 4 mention tests fail |

### Tests that were fixed rather than trusted
- **`changing a password ends the OTHER sessions`** asserted only that the call returned 200 — it
  never opened a second session. Rewritten to prove it.
- **14 Notification Center e2e tests passed against an empty database** (0 DocReview logs, 0 reviews,
  0 reminders — measured). A 15-test integration suite with seeded data was added.
- **`users-validation.spec.ts`** exercised account creation thoroughly and never asserted on the
  hash, so reverting the cost fix left all 47 green. Cost assertions added.

---

## 11. Performance

- **Sign-in no longer sequentially scans `users`.** ILIKE could not use `users_email_lower_key`;
  `lower(x) = lower($1)` matches it exactly. A security fix and an index fix in one change.
- **New tables indexed for their actual reads** — `(user_id, read_at)` and `(user_id, created_at)`
  on notifications; `(user_id, category)` on preferences; expiry indexes on challenges and devices.
- **`SCAN`, never `KEYS`**, for namespace invalidation — `KEYS` blocks the whole Redis server.
- **One preference query per dispatch**, not one per channel.
- **One notification per mailbox poll**, not one per message.
- **Bounded work:** queue concurrency capped; feed sources capped; page size capped server-side.
- **No new N+1s introduced.** The Center merges four bounded queries; mention resolution is one
  `users` query plus a bounded access check per candidate.

---

## 12. Corrections made during the work

Recorded because each changed what was believed true.

- **`bcrypt.getRounds()` returns `NaN` for a malformed hash**, it does not throw. `NaN < 12` is
  false, so a corrupt hash would have been reported as current forever.
- **`ScreenGuard` is not global.** A controller carrying `@Screen` without listing the guard enforces
  nothing — which is how the MFA admin endpoints were first written.
- **Shutdown hooks do run.** I claimed they did not; `shutdown.ts` installs SIGTERM handlers calling
  `app.close()`, and deliberately avoids `enableShutdownHooks()` for a documented reason.
- **`module-access.spec` asserted a mutable business fact** — that every user holds both modules.
  Administrators may legitimately remove a module, so one authorised click made it fail with a
  message implying test data corruption. Rewritten to assert genuine invariants: no duplicate
  assignments, no orphans, no impossible totals.
- **A unique violation aborts the enclosing Postgres transaction.** Catching P2002 handles the error
  but not the abort, so a module notifying inside its own transaction would have had its real work
  rolled back by a harmless duplicate.

---

## 13. Deferred by decision

Neither is incomplete work; both were excluded from this version deliberately.

**Opportunity Management (pipeline, Kanban, analytics).** Nothing exists — verified: no
opportunity/deal/stage model, no Kanban, and `leads.lead_status` is free text. This is a greenfield
module and the largest single item in the original brief.

**Google Calendar calendar selection.** The Google Calendar *connection* is complete and working —
connect, OAuth, status, last sync, errors, manual sync, retry, disconnect. What is absent is choosing
*which* calendar to sync: `google.service.ts` has no `calendarList` call and `google_connections`
holds a single `calendar_id` defaulting to `'primary'`. Multi-calendar sync would also need the sync
engine reworked, since sync tokens are per calendar.

---

## 14. Production readiness

### Verified
- Builds cleanly; no TypeScript errors; no failing tests
- Boots with Redis absent, present-and-healthy, and present-but-unreachable
- All new endpoints authenticated and correctly authorized
- Migrations additive and applied to development and test databases
- Graceful shutdown closes queues and connections via the existing handler

### Required before deployment
1. **Apply the four new migrations** to production, plus those still outstanding from earlier work.
2. **Set `APP_KEY`** — without it authenticator enrolment is refused by design. Email and SMS
   two-factor still work.
3. **Rotate the credentials** flagged in earlier phases. Unchanged by this work and still required.
4. **Decide on Redis.** Not required — the application is designed to run without it. If provisioned,
   see the caveat below.

### Caveats stated plainly
- **The BullMQ driver has never been executed.** No Redis, Docker or WSL was available on the build
  machine, and BullMQ needs real Lua scripting and blocking reads, so a mock proves nothing. It is
  written against BullMQ 5 and typechecks. **Treat its first run on real infrastructure as the
  verification step.** The in-process driver is fully tested and is the default.
- **MFA policy enforcement is advisory server-side.** The obligation is returned at sign-in and the
  interface acts on it, but no guard blocks an overdue account from the rest of the application. That
  guard is the one piece that could lock out a brokerage if wrong, and deserves its own change.
- **Migration history has drifted from the schema.** `prisma migrate diff` wants to drop
  `campaigns_scheduled_for_idx` and `transactions_agent_user_id_idx` and rename a dozen indexes —
  pre-existing, unrelated to this work, and worth addressing on its own. All migrations here were
  hand-written to avoid carrying that drift along.
- **The build machine is critically low on disk** (~105 MB free). This produced four spurious
  end-to-end failures with `ENOSPC`; all four pass on re-run. Not a code defect, but it will keep
  causing false failures until resolved.

### Not claimed
Load testing, penetration testing and production smoke testing have not been performed. Everything
above was verified against development and test databases on a single machine.
