# Enterprise Audit — CRM › Inbox

**Module:** CRM → Inbox (user's synced inbound mail)
**Audited:** 2026-08-01
**Build audited:** `version_3` @ `aa38ed2`
**Verdict:** **NOT PRODUCTION READY**
**Production readiness score:** **48 / 100**

---

## 1. Scope and method — what was actually verified

Being explicit, because an audit that overstates its coverage is worse than a short one.

### Performed

| Method | Coverage |
|---|---|
| Code inspection | All 5 server files, `InboxPage.tsx`, schema, client API layer |
| **Live database inspection** | Row counts, sizes, `EXPLAIN ANALYZE` on the real list query, UID-gap analysis |
| **Runtime API testing** | Server built and started; all 6 inbox endpoints probed unauthenticated |
| **Index experiment** | Composite index created and rolled back in a transaction to prove the fix |
| Build/deploy testing | `npm run build` → `node dist/main.js` executed end-to-end |

### NOT performed — and why

| Gap | Reason | What it leaves unverified |
|---|---|---|
| **Browser UI testing** | Playwright/Puppeteer not installed. Adding it means a dev dependency plus ~150 MB browser download — not done unannounced. | Click-level behaviour, responsive layout, visual defects, screenshots |
| **Authenticated API testing** | No credentials supplied. | IDOR between users, authenticated validation/injection, role matrix, rate limiting under session |
| **Role testing (Agent/Manager/Finance/Admin/Super Admin/Read-only)** | Same. | The entire §5 role matrix |
| **Password guessing to obtain a session** | Deliberately refused — `AUTH_ACCOUNT_LIMIT_MAX=8` would lock out a real user's account. | — |

**To close these gaps I need:** (a) approval to install Playwright, and (b) throwaway credentials for one Agent, one Admin and one Super Admin on a **non-production** database.

> Findings below are marked **[VERIFIED]** (observed at runtime or in live data) or **[CODE]** (read from source, not executed).

---

## 2. Executive summary

The Inbox is **well-engineered in its security posture and unusually well-commented**, but it is **not safe to run at brokerage scale**. Three findings would cause real business harm on day one:

1. **Mail is silently and permanently lost** when a mailbox has more than 50 new messages in one poll — which is the normal case for a first sync. No error, no retry, no record. For a brokerage, that is a client email that never arrives and nobody knows.
2. **Every message timestamp is displayed in UTC**, not Toronto time. Evening mail shows tomorrow's date. This contradicts the app's own mandatory `TZ=America/Toronto` setting.
3. **The list query is a full table scan** on a table already at 118 MB for 1,414 messages, polled every 30 seconds per open tab. This does not survive hundreds of agents.

Access control, CSRF, credential storage and XSS handling are **genuinely good** and passed every test run against them.

The module is also **functionally incomplete for enterprise use**: no search, no attachments, no delete/archive, no bulk actions.

---

## 3. Findings by severity

### CRITICAL

---

#### C-1 — Silent permanent mail loss when >50 new messages [CODE, high confidence]

**Where:** [`imap-sync.service.ts:266`](../../server/src/inbox/imap-sync.service.ts#L266)

```ts
const recent = uids.slice(-MAX_PER_SYNC);   // MAX_PER_SYNC = 50 — takes the NEWEST 50
for (const uid of recent) {
  maxUid = Math.max(maxUid, uid);           // advances to the HIGHEST uid
  …
}
await this.recordOutcome(account.id, null, maxUid);   // last_uid := highest
```

`uids` is sorted ascending. `slice(-50)` takes the **newest** 50, then `last_uid` is advanced to the highest of them. The next poll searches `${last_uid + 1}:*`.

**Everything below that window is skipped forever.** No error, no `sync_error`, no log line. The account reports a successful sync.

**Trigger:** the first sync of any account reaches back `FIRST_SYNC_DAYS = 14`. A mailbox receiving 4+ messages a day exceeds 50 — i.e. essentially every real mailbox. Also triggers after downtime, after re-enabling an account, or during any high-volume burst.

**Business impact:** a client's email silently never reaches the Inbox. In a brokerage this is a missed offer, a missed condition waiver, or a compliance gap. It is undetectable from the UI.

**Fix:** take the **oldest** batch so successive polls catch up:
```ts
const recent = uids.slice(0, MAX_PER_SYNC);
```
With ascending UIDs, `maxUid` then advances only to the end of the processed batch, and the next poll continues from there. Add a log line when `uids.length > MAX_PER_SYNC` so a backlog is visible.

---

#### C-2 — `maxUid` advances past messages that were never stored [CODE, confirmed]

**Where:** [`imap-sync.service.ts:269-278`](../../server/src/inbox/imap-sync.service.ts#L269-L278)

```ts
maxUid = Math.max(maxUid, uid);      // advanced FIRST
…
const record = await this.fetchOne(client, uid);
if (!record) continue;               // …but the message was never stored
```

`fetchOne` returns `null` when the fetch returns nothing or the source is missing. `maxUid` has already moved past that UID, so `last_uid` is advanced and the message is **never retried**. A single transient fetch failure loses that message permanently.

This is a second, independent silent-loss path from C-1.

**Fix:** only advance `maxUid` after a successful store (or an accepted P2002 duplicate).

**Corroborating evidence [VERIFIED]** — UID gaps in live data:

| account_id | stored | uid_span | **missing UIDs** |
|---|---|---|---|
| 24 | 102 | 125 | **23** |
| 25 | 559 | 567 | **8** |
| 26 | 112 | 112 | 0 |
| 27 | 112 | 112 | 0 |
| 28 | 529 | 529 | 0 |

31 UIDs within the fetched range are absent. **Caveat, stated honestly:** gaps can also arise legitimately — messages deleted or moved on the server before the poll. This is *consistent with* C-1/C-2, not proof of them. Confirming requires comparing against the live mailbox.

---

#### C-3 — `npm run build` exits 0 and produces nothing on redeploy [VERIFIED — reproduced]

**Where:** [`nest-cli.json`](../../server/nest-cli.json) (`deleteOutDir: true`) + [`tsconfig.json:24`](../../server/tsconfig.json#L24) (`incremental: true`)

Reproduced on this machine during the audit:

```
$ npm run build      # nest build → exit 0, no errors
$ ls dist/           # EMPTY
$ node dist/main.js
Error: Cannot find module '…\server\dist\main.js'
```

`deleteOutDir: true` wipes `dist/`, then TypeScript reads a `.tsbuildinfo` that still claims everything is current and emits nothing. **The build reports success**, so CI goes green and the failure only appears when the process starts.

Confirmed by deleting `tsconfig.build.tsbuildinfo` and rebuilding → `dist/main.js` produced.

**Severity qualifier:** `*.tsbuildinfo` **is** gitignored ([`server/.gitignore:5`](../../server/.gitignore#L5), which documents this exact hazard), so a **fresh clone builds correctly**. The blocker is on **redeploy** — `git pull` on the VPS, a cached CI workspace, or a reused Docker layer, where the tsbuildinfo persists but `dist/` was cleaned.

This is the exact sequence in [`docs/VPS-DEPLOYMENT.md` §7](../VPS-DEPLOYMENT.md).

**Fix:** add a guard so success means an artefact exists:
```json
"prebuild": "rimraf dist *.tsbuildinfo",
"postbuild": "node -e \"require('fs').existsSync('dist/main.js')||(console.error('BUILD PRODUCED NO OUTPUT'),process.exit(1))\""
```

---

### HIGH

---

#### H-1 — All timestamps displayed in UTC, not local time [CODE, confirmed by inspection]

**Where:** [`InboxPage.tsx:12`](../../client/src/desk/InboxPage.tsx#L12)

```ts
const stamp = (iso: string): string => iso.replace('T', ' ').slice(0, 16);
```

The server sends `received_at.toISOString()` — always UTC with a `Z`. The client strips the `T` and truncates, **discarding the timezone marker and never converting**.

A message received **6:00 PM Tuesday** in Toronto displays as **22:00 Tuesday**. Mail after 8 PM displays as **the next day**.

This directly contradicts the app's own hard requirement — the server refuses to boot in production without `TZ=America/Toronto` precisely because "a UTC host records anything entered after 8pm as the following day" ([`validate-config.ts:89-95`](../../server/src/config/validate-config.ts#L89-L95)). The backend was fixed for this; the Inbox front-end was not.

**Business impact:** agents cannot tell when a client actually wrote. Disputes about "when did we hear from them" become unanswerable.

**Fix:** `new Date(iso).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' })`.

---

#### H-2 — Inbox list is a full table scan, polled every 30 s [VERIFIED — EXPLAIN ANALYZE]

**Where:** [`inbox.service.ts:74-86`](../../server/src/inbox/inbox.service.ts#L74-L86); schema has no `received_at` index.

Live plan:
```
Limit (actual time=0.791..0.794 rows=30)
  -> Sort  Sort Key: received_at DESC   Sort Method: top-N heapsort
     -> Seq Scan on inbound_emails  (actual rows=559)
        Filter: ((user_id = 1) AND (account_id = 25))
        Rows Removed by Filter: 855
        Buffers: shared hit=205
Execution Time: 0.819 ms
```

**Full sequential scan, then sort**, on every inbox load. Indexes are `(account_id, uid)`, `user_id`, `lead_id`, `company_id` — none serves `ORDER BY received_at DESC`.

Load multiplier: the page **auto-refreshes every 30 seconds** ([`InboxPage.tsx:55`](../../client/src/desk/InboxPage.tsx#L55)) and each load issues **three** queries over the same predicate (`findMany` + `count` + unread `count`).

At 200 agents with the tab open: **~20 scans/second of a table that is already 118 MB and growing**.

**Proven fix** (created and rolled back in a transaction during this audit):
```sql
CREATE INDEX ON inbound_emails (account_id, received_at DESC);
```
```
-> Index Scan using idx_probe   Execution Time: 0.071 ms
```
**0.819 ms → 0.071 ms (11×)** at 1,414 rows. The gap widens linearly — at 100k rows the seq scan is ~70× worse while the index scan stays flat.

Also add `(user_id, received_at DESC)` for the no-primary fallback path.

---

#### H-3 — Unbounded message bodies; 8.8 MB single email observed [VERIFIED]

**Where:** [`imap-sync.service.ts:295`](../../server/src/inbox/imap-sync.service.ts#L295) — `body_text`/`body_html` stored whole, no cap.

Live data:

| Metric | Value |
|---|---|
| Messages | 1,414 |
| Table size | **118 MB** (~85 KB/row) |
| Total `body_html` | **130 MB** |
| **Largest single email** | **8.8 MB** |
| Emails > 500 KB | **45** |

Three consequences:

1. **Growth** — extrapolating, 50,000 messages ≈ 4 GB for one table. Backup, dump and restore time all track it. `DISASTER-RECOVERY.md` already flags this table as the dominant cost.
2. **Response size** — [`inbox.service.ts:129`](../../server/src/inbox/inbox.service.ts#L129) returns `body_html` **and** `body_text` in full. Opening that 8.8 MB email sends a ~9 MB JSON response to the browser — punishing on an agent's phone.
3. **Client main-thread block** — [`InboxPage.tsx:189`](../../client/src/desk/InboxPage.tsx#L189) runs three chained regexes over that HTML **synchronously during render**. On 8.8 MB this freezes the tab.

**Fix:** cap stored bodies (e.g. 256 KB, flag truncation); do the HTML→text conversion server-side once at ingest rather than per-open in the browser.

**Related:** retention is **off by default** (`MAIL_RETENTION_DAYS=0`) — deliberate and documented, since deletion is a compliance decision. But it means nothing prunes until someone acts. Recommend `MAIL_STRIP_BODIES_AFTER_DAYS` as the first lever: it discards most bytes while keeping sender, subject, date and lead link.

---

#### H-4 — Brokerage-account mail syncs into an unreadable black hole [CODE]

**Where:** [`imap-sync.service.ts:120`](../../server/src/inbox/imap-sync.service.ts#L120) and [`:292`](../../server/src/inbox/imap-sync.service.ts#L292)

The poller selects accounts by `{ inbound_enabled, is_active, imap_host != null }` with **no `user_id` filter**. `mail_accounts.user_id` is nullable — NULL means a shared brokerage account. Such a message is then stored as:

```ts
user_id: account.user_id ?? -1
```

Every inbox read is scoped to the signed-in user's id, so **no user can ever see a `user_id = -1` message**. It is fetched, parsed, stored, counted against the table, and invisible forever.

**Currently 0 such rows [VERIFIED]** — so this is latent, not active. It activates the moment anyone enables IMAP on a shared/brokerage mailbox, which is a natural thing for an admin to do (e.g. `info@`).

**Fix:** exclude `user_id: null` accounts from the poller, or surface shared-mailbox mail explicitly with a defined audience.

---

### MEDIUM

---

#### M-1 — Area switch may show the wrong mailbox [CODE, needs runtime confirmation]

[`InboxPage.tsx:30-40`](../../client/src/desk/InboxPage.tsx#L30-L40) — `load` is a `useCallback` that **uses `area`** but omits it from its dependency array (`[unreadOnly, page, toast]`).

If the component instance survives a CRM ↔ Transaction Desk switch, `load` keeps a stale `area` closure and the user sees the **other area's mail** — precisely the separation the service layer works hard to enforce. If React remounts on the route change, state resets and the bug is masked.

**Cannot be resolved from source alone** — it depends on whether React Router reuses the element. Needs a browser test. Fix is one word either way: add `area` to the deps.

#### M-2 — No search anywhere in the Inbox

Only an unread toggle. No search by sender, subject, body or date; no date-range filter; no sort control. For a mailbox with thousands of messages, "find that email from the buyer's lawyer" means paging 30 at a time. For an enterprise CRM this is a functional gap, not a nice-to-have.

#### M-3 — Attachments are never captured

[`fetchOne`](../../server/src/inbox/imap-sync.service.ts#L321) extracts text and HTML only; `parsed.attachments` is ignored and there is no attachment table. A client emails a signed document — the agent sees the message body and **no indication an attachment ever existed**. In a brokerage handling signed agreements this is severe; rated Medium only because the mail still arrives.

#### M-4 — No delete, archive or bulk actions

Mail can only be marked read/unread. No delete, no archive, no multi-select. The only removal path is the retention sweep, which is off by default.

#### M-5 — `received_at` trusts the sender's `Date:` header

[`imap-sync.service.ts:341`](../../server/src/inbox/imap-sync.service.ts#L341) — `received_at: p.date ?? new Date()`, unclamped. The list is ordered by `received_at DESC`, so a message with a far-future `Date:` header **pins itself to the top of the inbox permanently**. Trivially spoofable by any sender. **0 future-dated rows currently [VERIFIED]** — latent. Fix: clamp to `min(header, now)`, or store the IMAP `INTERNALDATE`.

#### M-6 — N+1 queries in the sync loop

Per message: one `findUnique` dedupe ([`:272`](../../server/src/inbox/imap-sync.service.ts#L272)) and one `matchLead` ([`:352`](../../server/src/inbox/imap-sync.service.ts#L352)). At `MAX_PER_SYNC = 50` that is up to 100 round trips per account per poll, every 60 s, per mailbox. Batch both.

#### M-7 — Unmemoised context value

[`AreaContext.tsx:28`](../../client/src/desk/AreaContext.tsx#L28) constructs `{ area, link }` inline, so every provider render gives every consumer a new object and forces a re-render. Wrap in `useMemo`.

---

### LOW

| ID | Finding |
|---|---|
| L-1 | **Accessibility:** rows are `<li onClick>` with no `role`, `tabIndex` or key handler — unusable by keyboard or screen reader. The "My Settings" link is `<a onClick>` with no `href`, so it is not focusable. Likely fails WCAG 2.1 AA. |
| L-2 | Page size fixed at 30, not user-adjustable. |
| L-3 | Deep pagination uses `OFFSET`, which degrades on large mailboxes. Keyset pagination on `received_at` would pair naturally with the H-2 index. |
| L-4 | No loading indicator on refresh (`loadedOnce` suppresses it) — deliberate, but a slow refresh gives no feedback. |
| L-5 | `markSeen` accepts `@Body() Record<string, unknown>` with no DTO, so the global `ValidationPipe` whitelist does not apply. Behaviour is safe (`body?.seen !== false`) but it is unvalidated input by construction. |
| L-6 | `page`/`lead` parsed with bare `Number()`. `?page=1e999` → `Infinity` → passed to Prisma `skip`. Not exploitable (auth required) but a likely 500. Unverified — needs a session. |
| L-7 | 30-second polling has no backoff and no `visibilitychange`-independent jitter; every client polls on its own clock, so load is uncoordinated. |
| L-8 | Opening a message always marks it seen with no "keep as unread" affordance at open time. |

---

## 4. What is genuinely good

Stated because an audit that only lists faults misrepresents the system.

| Area | Assessment |
|---|---|
| **XSS defence** | **Excellent.** `body_html` is *never* rendered as HTML — [`InboxPage.tsx:177`](../../client/src/desk/InboxPage.tsx#L177) renders plain text in `<pre>`, with a comment explaining exactly why. `dangerouslySetInnerHTML` appears nowhere in this module. This is the single highest-risk sink in any inbox and it is handled correctly. |
| **Access control** | **[VERIFIED]** All 6 endpoints return `401` unauthenticated with an identical `{"message":"Unauthenticated."}` body. No difference between a real and a fake message id, so **no enumeration oracle**. |
| **CSRF** | **[VERIFIED]** `PUT`/`POST` return `419` without a token — enforced ahead of auth. |
| **Tenant/user scoping** | Every read is scoped by `user_id` **and** area, including `get` and `markSeen` — not just the list. The service comments show the id-guessing attack was explicitly considered. |
| **Credential handling** | IMAP passwords encrypted at rest; API responses expose only `has_password: boolean` ([`mail-account.service.ts:311`](../../server/src/email/mail-account.service.ts#L311)). No leak found. |
| **Sync robustness** | The `client.on('error')` handler ([`:246`](../../server/src/inbox/imap-sync.service.ts#L246)) prevents a bad-credential mailbox from killing the whole API — a real crash averted, with the reasoning recorded. P2002 duplicate handling is correct. Per-mailbox concurrency guard is sound. |
| **Error messages** | `explain()` turns raw IMAP errors into advice an agent can act on. Genuinely good UX. |
| **Code quality** | Comments explain *why*, including past incidents. Well above average. |

---

## 5. Priority order and effort

| # | ID | Issue | Effort |
|---|---|---|---|
| 1 | C-1 | Mail loss >50 messages — `slice(0, MAX)` | **15 min** |
| 2 | C-2 | `maxUid` advances past unstored messages | **30 min** |
| 3 | C-3 | Build guard (`prebuild`/`postbuild`) | **30 min** |
| 4 | H-1 | UTC timestamps → local | **30 min** |
| 5 | H-2 | Composite indexes + migration | **1 h** |
| 6 | H-4 | Exclude `user_id: null` from poller | **1 h** |
| 7 | M-1 | `area` in dep array | **5 min** |
| 8 | H-3 | Cap bodies, strip HTML server-side | **4 h** |
| 9 | M-5 | Clamp `received_at` | **30 min** |
| 10 | M-6 | Batch dedupe + lead match | **2 h** |
| 11 | L-1 | Accessibility | **3 h** |
| 12 | M-2 | Search + filters | **1–2 days** |
| 13 | M-3 | Attachments (schema + storage + UI) | **3–5 days** |
| 14 | M-4 | Delete / archive / bulk | **2 days** |

**Ship-blockers (1–7): ~4 hours.**
**Enterprise-complete (all): ~2 weeks.**

---

## 6. Module status

### NOT PRODUCTION READY

**Justification:**

1. **C-1 loses client mail silently.** For a brokerage this is unacceptable at any volume — no error, no audit trail, no way for a user to know. This alone blocks release.
2. **C-3 means a redeploy can leave a server that will not start**, from a build that reported success.
3. **H-1 makes every timestamp wrong** for the intended users, in an application that treats timezone correctness as a boot-blocking invariant everywhere else.
4. **H-2 does not scale** to the stated user base; the growth curve is already visible at 1,414 messages.

**However** — the ship-blockers are **~4 hours of work**, and the module's security foundations (XSS, access control, CSRF, credential storage) are sound and were **tested, not assumed**. This is a module that needs finishing, not rebuilding.

**Recommendation:** fix items 1–7, then **re-audit with browser and authenticated-role testing** before sign-off. The role matrix (§5 of the brief) and all UI-level testing remain **entirely unverified** and could surface further issues.

---

## 7. Required to complete this audit

1. **Approval to install Playwright** (`npm i -D playwright` + `npx playwright install chromium`).
2. **Throwaway credentials on a non-production database** for: Agent, Manager, Finance, Admin, Super Admin, Read-only.
3. **A non-production environment**, so destructive tests (delete, concurrent edit, session expiry, malformed payloads) can run without touching live brokerage data.

Without these, the following brief sections remain unverified: §1 UI, §2 field validation, §4 workflow, §5 roles, and the authenticated half of §7 API and §8 security.
