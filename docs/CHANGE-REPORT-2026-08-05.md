# Change report — `version_3`, 2026-08-05

**Branch:** `version_3`
**Baseline:** `9617712` (2026-08-03) — *feat(crm): Meta lead ads, agent departure, notification preferences — plus the Users and Settings audits and their remediation*

Everything below landed in the seven commits that follow that baseline. It was written while the work
was still uncommitted, which is why it reads as a review document rather than a history — that is
deliberate: it is the summary somebody needs in order to review or deploy this batch, not a log of
what happened.

| | Count |
|---|---|
| Tracked files modified | **61** (+3,684 / −579 lines) |
| Untracked paths added | **63** |
| New database migrations | **6** |
| New test files | **30** (19 server, 11 browser) |
| Server tests | **1,025 passing / 78 suites** |
| Browser tests | **309 passing** |

Server build, client build and `tsc --noEmit` on both sides are clean.

---

## 1. How to review this

```bash
# Everything modified, file by file
git diff --stat

# Everything new
git status --short | grep '^??'

# Verify before accepting
cd server && npx tsc --noEmit -p tsconfig.json && npm run build && npx jest
cd ../client && npx tsc --noEmit && npm run build
cd ../e2e && TEST_DATABASE_URL="postgresql://…/myapp_test?schema=public" npx playwright test
```

**Note on the two databases** — they are easy to confuse and a wrong answer here looks like a real
finding. `jest` reads `server/.env` and runs against the **dev** database `myapp`; Playwright refuses
to start without `TEST_DATABASE_URL` and must point at `myapp_test`.

---

## 2. Database migrations — the deployment-critical part

Six migrations are new and untracked. **All six are applied to dev and test; none is applied to
production.** Until they are, stored role permissions will not match the compiled defaults and the
new columns will not exist.

| Migration | What it does | Risk |
|---|---|---|
| `20260804120000_crm_settings_integrity` | Foreign keys on `crm_settings` (`user_id` → `users` CASCADE, `company_id` → `company_settings`) | Fails loudly if orphan rows exist — guarded |
| `20260804160000_crm_per_user_triggers` | `crm_trigger_settings`: one row of email-trigger switches per user | Additive |
| `20260805090000_accounting_no_audit` | Removes Audit Trail access from the `accounting` role | **Behavioural** — accounting loses a screen |
| `20260805140000_crm_role_campaigns_edit` | Grants the `crm` role `campaigns: edit` | **Behavioural** — CRM staff gain a screen |
| `20260805200000_inbox_list_index` | `(user_id, received_at DESC)` and `(account_id, received_at DESC)` on `inbound_emails` | Additive; brief lock, table is small |
| `20260805220000_google_sync_retry` | `google_sync_error`, `google_sync_attempts`, `google_sync_next_retry_at` on `calendar_events` + partial index | Additive |

**Order matters** — apply with `npx prisma migrate deploy`, which runs them in timestamp order.

**Check production state first:**
```bash
DATABASE_URL="<production>" npx prisma migrate status
```

Eighteen earlier migrations (`20260801…`–`20260803…`) are already committed but may also be
unapplied in production. `migrate status` is the authority; I cannot see production from here.

---

## 3. Defects fixed

Severity is as recorded in the audit register. Every fix was **sensitivity-checked** — reverted, the
tests confirmed red, then restored.

### High

| ID | Module | Problem | Fix |
|---|---|---|---|
| **CRM-CAMP-H03** | Campaigns | `getAttachment`, `addAttachment` and `removeAttachment` took **no user argument at all** and the controller passed none. An agent's private template attachments were downloadable by anyone with `campaigns: view` and writable by anyone with `campaigns: edit`, given two integer ids — bypassing the brokerage's explicit decision that a Super Admin must not see or edit an agent's custom templates. The write side is worse: an attachment rides along with **every send** of its template | Same two locks the template itself uses (`visibleWhere` + `assertEditable`), in the **service**, because the controller streams the bytes straight to the response |
| **CRM-CAMP-H02** | Campaigns | A scheduled campaign could mail somebody who unsubscribed *after* it was scheduled. Under CASL the violation is sending after consent is withdrawn | Consent re-checked at dispatch; excluded recipients marked `failed` with an opt-out reason rather than silently skipped |

### Medium

| ID | Module | Problem | Fix |
|---|---|---|---|
| **CRM-INBOX-M01** | Inbox | `POST /account/inbox/sync/:id` read the account with **no user filter** to check its area, and the wrong-area refusal interpolated `from_email`. Any authenticated user could walk account ids and be told which addresses colleagues have connected | Lookup scoped to the caller, so the only address it can name is your own |
| **CRM-DASH-M01** | Dashboard | Three of fourteen aggregates in `desk()` carried no scope. Measured: agent "Akhil" saw `transactions: 3` (correctly own) beside `invoices: { billed: 123396, outstanding: 123396 }` — the whole brokerage's money, for a module the agent holds `invoice: 'none'` on. **Rendered on screen**, not merely in the payload | Withheld (`invoices: null`) without the screen; scoped through `transactions: { is: live }` for an agent who has it; client omits the four tiles |
| **CRM-CAL-M01** | Calendar | Optimistic locking compared `version` in a **separate read** from the write, so two simultaneous saves both passed. Measured: a row at version 1 finished at **version 3** — both writes applied, the loser never told | Predicate moved into the write: `updateMany({ where: { id, version } })`, `count: 0` → 409 |
| **CRM-CAL-M02** | Calendar | The "+N more" popover set `maxWidth: 520`, which *replaces* the stylesheet's `max-width: 100%`. Measured at 390 px: **518 px inside a 390 px overlay**, putting Edit and Delete off screen — this feature's own bug in a new place | `min(520px, 100%)` |
| **CRM-CAMP-M02** | Campaigns | A crash between sending and recording delivered a second copy on resume | Claim-then-send: `status: 'sending'` written before `sendDirect` |
| **CRM-CAMP-M03** | Campaigns | A campaign name over 255 characters returned 500 | 400 with a field error |
| **CRM-LEADS-M01 / S-M9** | Leads / Email | Merge values interpolated into email HTML unescaped | `renderTemplate` escapes by default; 4-variable markup allow-list |
| **CRM-PERM-M03** | Audit Trail | `accounting` could read the entire audit trail while holding `users: none` and `settings: none` | Migration `20260805090000_accounting_no_audit` |
| **S-M3** | Settings | Profile email/username compared as raw strings against a `lower()` UNIQUE index → `ADMIN@test.local` passed the app check, hit the index, returned **500** | `mode: 'insensitive'` on both lookups |
| **Audit Trail** | Audit Trail | `?from=garbage`, `?to=2026-99-99`, `?page=Infinity`, `?page=1e20` → **500**. `?user_id=abc` → **200 with the wrong row**: `Number('abc')` is NaN, which Prisma renders as `user_id: null`. `?q=%` returned all 127 rows | 400s where the filter cannot be honoured; page clamped; `LIKE` wildcards escaped |
| **Inbox pagination** | Inbox | `?page=Infinity/1e20/1e999` → **500**; `?page=2.7` accepted with a fractional offset; `?page=999999` → `skip: 29,999,940`; **`?lead=abc` silently dropped the filter and returned the whole mailbox** | Clamped and floored; non-numeric `lead` refused |
| **Inbox indexes** | Inbox | List query planned as `Limit → Sort → Seq Scan` over 2,265 rows; nothing supported `ORDER BY received_at DESC` on an append-only table | Two composite indexes |
| **CRM-GCAL-M01** | Calendar/Google | A failed push was caught, logged and **dropped** — no retry, nothing on the row, nothing on screen. An appointment moved while Google was unreachable kept its old time on the agent's phone for ever | Bounded retry sweep + visible count + manual Retry (see §4) |
| **CRM-GCAL-M02** | Calendar/Google | A revoked grant was indistinguishable from a network blip; both left the connection active with the same message | Permanent OAuth codes deactivate; everything else stays active and retryable |

### Low

| ID | Problem | Fix |
|---|---|---|
| **CRM-LEADS-L02** | View-only Leads access could Export | Export gated |
| **CRM-INBOX-L01** | Cross-user sync returned **500** (bare `Error`), as did pressing "Sync now" on an SMTP-only account | `NotFoundException` / `BadRequestException` |
| **S-L1** | No trimming in Company Settings — `"  Padded Brokerage  "` printed on invoices with its padding; a name of three spaces passed `@IsNotEmpty` | `@Transform(trimmed)` before validation |
| **S-L4** | Company `email` had no format check; `"not-an-email"` printed on client-facing documents | Shape check that still permits empty |
| **L11** | 40 consecutive config writes accepted, each appending to the audit trail | `SETTINGS_WRITE_LIMIT` — 30/min |
| **CRM-PERF-L01** | Repeated avatar 404s on every navigation | Module-level negative cache |
| **NUL byte** | `crm-advanced-email.service.ts` carried a literal `\0` inside a string literal — it compiled, and made `grep`/`ripgrep` treat the file as binary | Removed |

### Withdrawn after re-measurement

- **CRM-NAV-M02** — "agents are offered Settings and refused it." The agent's sidebar Settings is
  `{ key: 'account', agentOnly: true }` → `/crm/account`, which works. **Not a defect.**
- **L7** — "a role without `settings` gets a blank screen." `RequireScreen` already renders
  *"🔒 No access — ask an administrator to grant you access under Users"* before the component
  mounts. My change to `SettingsPage` was reverted as unreachable code.
- **Fourteen of the nineteen recorded Settings items** were already closed by the 2026-08-04
  remediation under different labels and had simply never been struck off.

---

## 4. New behaviour (not a defect fix)

### Google Calendar sync retry — `google-calendar-sync.service.ts`, `google.controller.ts`, `GoogleCalendarCard.tsx`

The integration's **first background worker**. Before it, a push that failed was gone: `pushEvent` is
`void`-ed from the request that saved the event, so nothing survived that request to try again.

- **Bounded three ways** — 5 attempts per event, 1/5/15/60/180-minute backoff, 50 events per pass.
- **No outbox table**: the operation is derived from the row (`deleted_at` → delete, no
  `google_calendar_id` → insert, else patch), so a queue could not disagree with the event. An event
  created then deleted before the retry runs correctly produces a **delete**.
- **Skips disconnected users** — found by the first runtime check, not by a test: their events were
  re-picked every pass, logging *"0 of 1 recovered"* every five minutes.
- **Visible**: `GET /api/google/calendar/status` returns `pending_sync`; the card shows
  *"N appointments have not reached Google yet"* with **Retry now**, which resets the attempt count.
- Gated like every other scheduler (`schedulersEnabled`, `forEachTenant`, `registerWorker`) — off in
  tests, off unless the process owns the schedulers.

**Verified at runtime**: registered at boot, appears in `/api/health/workers`, and a seeded event was
picked up inside tenant context (`Google Calendar retry: 0 of 1 recovered.`).

### CRM role — brokerage-wide campaign audience

Capability-based rather than rank-based, per instruction: `campaigns.brokerage-audience` is a **named
role list** (`admin`, `manager`, `crm`), so Accounting and Documentation are excluded and Agent stays
own-only. `can()` now handles both rank thresholds and role lists. Suppression entries are scoped the
same way — agents see only entries belonging to their own leads.

### Per-user CRM email triggers — `crm-triggers.service.ts` (new, 221 lines)

Triggers were one brokerage-wide row, so an agent switching off promotional email switched it off for
everyone. Now one row per user, inheriting the brokerage default until they change it.

### Template ownership

An agent's custom campaign templates are private from **every** role including Super Admin — a stated
business requirement. Built-ins remain administrable by non-agents.

---

## 5. Test coverage added

**30 new test files.** Server 1,025 / 78 suites; browser 309.

### Server (19 files)

| File | Covers |
|---|---|
| `settings-low-band.spec.ts` | S-M3, S-L1, S-L4, L11 |
| `audit-log-query.spec.ts` | The Audit Trail's first tests — 4 measured 500s, NaN filter, LIKE wildcards |
| `inbox-isolation.spec.ts` | Cross-user isolation, incl. the no-primary-mailbox path where `user_id` is the *only* barrier |
| `inbox-pagination.spec.ts` | Page boundaries, hostile values, large mailboxes, index existence |
| `inbox-sync-authorization.spec.ts` | CRM-INBOX-M01/L01 |
| `imap-failure.spec.ts` | Real `ImapFlow` against an unreachable host — no network leaves the machine |
| `desk-dashboard-scope.spec.ts` | CRM-DASH-M01 |
| `concurrent-edit.spec.ts` | CRM-CAL-M01 |
| `google-failure.spec.ts`, `google-sync-retry.spec.ts` | Token refresh, permanent vs temporary, retry sweep |
| `template-attachment-access.spec.ts` | CRM-CAMP-H03 |
| `tracking-attribution.spec.ts` | Open and click attribution at runtime |
| `schedule-and-recovery.spec.ts` | Schedule execution and restart recovery |
| `claim-observed.spec.ts` | CRM-CAMP-M02 — the claim itself, which `claim-then-send` could not reach |
| `consent-at-dispatch.spec.ts`, `claim-then-send.spec.ts` | Rules pinned; limits stated in-file |
| `brokerage-audience.spec.ts`, `template-escaping.spec.ts`, `crm-triggers-findings.spec.ts` | Audience capability, merge escaping, trigger findings |

### Browser (11 files)

`write-authorization.spec.ts` (direct API writes, one context per role), `recurrence-end-to-end.spec.ts`,
`settings-high/medium/low-fixes.spec.ts`, `settings-l7-dashboard-invoices.spec.ts`,
`template-ownership.spec.ts`, `triggers.spec.ts`, `crm-audit-fixes.spec.ts`,
`google-sync-status.spec.ts`, `login-case.spec.ts`. Plus `calendar-more.spec.ts` extended by 167 lines.

---

## 6. Documentation added

- `docs/audit/CRM-FULL-PRODUCTION-AUDIT-2026.md` — the master finding register (~75 KB)
- `docs/audit/CRM-SETTINGS-AUDIT-2026-08-04.md`, `CRM-TRIGGERS-AUDIT-2026-08-04.md`
- `e2e/audit-shots/` — screenshots referenced by the audits

**These are untracked and have no git safety net.** Two were destroyed and recovered from session
transcripts during this work; treat them as data, not scratch.

---

## 7. Risks and things to decide before merging

1. **Two migrations change what roles can do.** `accounting` loses the Audit Trail;
   `crm` gains `campaigns: edit`. Both were explicit instructions, but they will be noticed on the
   first morning after deployment.
2. **The retry sweep is a ninth scheduler.** Ensure exactly one process runs schedulers
   (`RUN_SCHEDULERS=false` on any second instance), or two will retry the same event.
3. **Deployment drift is still open.** Production was running a frontend bundle older than its
   backend, which is what caused the Dashboard `l.filter is not a function` crash. That was diagnosed
   as drift, not a code defect — deploy client and server together.
4. **`docs/audit/` and `e2e/audit-shots/` are large.** Decide whether the screenshots belong in the
   repository before adding them.
5. **CRLF → LF.** Git reports line-ending normalisation on ~18 files; expect a whitespace-only diff
   on first commit.

## 8. Known gaps — not fixed, recorded deliberately

- **The Inbox has no search.** No `q` parameter, no search box. Paging without search means finding
  an old message is clicking Next. A product gap, deliberately not filled in under an audit heading.
- **Real Google revocation is unverified.** The classifier is tested at the seam; revoking a live
  grant needs a real Google account. To close it: revoke at `myaccount.google.com/permissions`, then
  edit any synced appointment.
- **Mid-transfer IMAP drop and a stalling server** need a controllable IMAP server to test.
- **`S-L6`** (inert CRM SMTP fields) and **`L12`** (single-brokerage tenancy) are recorded decisions,
  not defects.
- **Meta `M-M7`, `M-M9`, `M-M10`** remain open and are cosmetic or already mitigated.

---

## Appendix — largest modified files

| File | Change |
|---|---|
| `client/src/desk/CrmSettingsPanel.tsx` | +373 / −196 |
| `server/src/crm-settings/crm-settings.service.ts` | +329 / −37 |
| `server/src/settings/company-settings.service.ts` | +324 / −36 |
| `server/src/google/google-calendar-sync.service.ts` | +268 / −7 |
| `client/src/desk/CrmTriggersPanel.tsx` | +224 / −62 |
| `server/src/crm-settings/crm-advanced-email.service.ts` | +209 / −40 |
| `e2e/tests/calendar-more.spec.ts` | +167 |
| `server/src/auth/auth.service.ts` | +132 / −21 |
| `server/src/campaigns/campaigns.service.ts` | +130 / −7 |
| `server/src/settings/dto/update-company-settings.dto.ts` | +91 / −16 |
