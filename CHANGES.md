# Change Report

A running record of what changed, why, and what it means for deployment.

Git already holds the detail — `git log` has the full reasoning on every commit. This file is
the readable version: one entry per piece of work, in plain language, so the state of the
project can be understood without reading diffs.

**How to read an entry**

| Field | Meaning |
|---|---|
| **Problem** | What was wrong, and how it showed up |
| **Change** | What was actually done |
| **Verified** | How it was proven, not assumed |
| **Action needed** | Anything a person must still do — a setting, a reconnect, a decision |

⚠️ marks something that needs a human before or after deploying.

---

## 2026-07-29

### CRM broadcast, invoice cascade, template senders, sync speed, Triggers module
`e2c3e19`

**Problem.** Five separate reports. Deleting a transaction left its invoices behind (one orphan
already existed). The Templates "Sender account" dropdown was empty, so no template could be
pointed at an address. "Send to All Users" recorded a row and reported success without ever
sending an email. Connected mailboxes showed a sync error. A sync took ~15 seconds.

**Change.** Invoices are now deleted and restored with their transaction, paired by timestamp so
a separately-deleted invoice does not come back. The templates dropdown lists Transaction Desk
accounts (CRM excluded), and the no-sender fallback is scope-aware — it could previously send a
Transaction Desk email from the CRM mailbox. Broadcasts email each active user individually and
report honestly when delivery fails. Mailboxes sync concurrently (cap 4). Trigger Templates moved
from CRM Settings to a new **Triggers → CRM Triggers** screen, which previously had no route at
all and showed a placeholder.

**Verified.** Nine assertions on delete/restore and sender resolution in a rolled-back
transaction; sync timed at 15.5 s → 6.0 s; Triggers screen and emptied CRM Settings checked in a
browser; sender list confirmed through the live API.

⚠️ **Action needed.** The sync error was Google having revoked the tokens for `info@` and
`deals@` — since reconnected. **Publish the Google OAuth app** in Cloud Console; while it is in
"Testing", refresh tokens expire every 7 days and this will recur weekly.

⚠️ Send one broadcast to yourself first — set `MAIL_REDIRECT_TO=your@address` — before sending to
all six users.

---

## 2026-07-28 — deployment readiness

Twenty commits covering the pre-deployment audit and its fixes. Condensed by theme.

### Made safe to deploy
- **Config guard** — the server now refuses to start in production with a setting that would fail
  silently: empty/short `APP_KEY`, dev `SESSION_SECRET`, non-secure cookies, localhost CORS,
  unset `FRONTEND_URL` (which builds email links), missing `TZ`. All problems are listed at once.
- **`TZ`** — Inventory, Calendar and Meta build dates from the server clock. On a UTC host,
  anything entered after 8pm was recorded a day late. Now required.
- **Storage** — the upload location no longer depends on the directory the process starts from;
  `STORAGE_ROOT` makes it explicit, and production refuses to start if it is missing rather than
  creating an empty one and appearing to work.
- **Migrations** — `prisma migrate dev` (which resets a database on drift) is now blocked against
  any non-local database. Production uses `npm run prisma:deploy`.
- **Shutdown** — SIGTERM now finishes in-flight requests and closes connections instead of
  killing the process mid-response on every deploy.
- **Schedulers** — only one process may run the IMAP poller, export sweeper and reminders;
  a second instance would have sent duplicate reminder emails to real clients.
- **`VITE_API_URL`** — committed as empty so the built app calls relative paths. A production
  build can no longer quietly point at `localhost:8000`.

### Made faster
- **Transactions list** — was ~3 queries per row, run one after another. Now a fixed 4 queries:
  890 ms → 67 ms at 1,005 rows, and it no longer scales with list length.
- **Pagination** — the list pages 25 at a time with all 13 filters moved into the database.
- **Bundle** — split by route and the three heaviest libraries deferred: 648 kB → 113 kB before
  anything renders.

### Made safer
- **helmet** security headers, and rate limiting (600/min general, 10 per 5 min on sign-in).
- **Error boundary** — one broken render no longer blanks the whole application.
- **Client build** now typechecks; it previously shipped type errors silently.

⚠️ **Action needed before deploying**
1. Carry the **existing `APP_KEY`** forward — it decrypts the stored mail and calendar tokens.
2. Set `FRONTEND_URL`, `TZ=America/Toronto`, `CORS_ORIGINS`, `STORAGE_ROOT` (absolute, on a
   persistent volume).
3. Repoint `META_PUBLIC_URL`, `TWILIO_PUBLIC_URL`, `CAMPAIGN_PUBLIC_URL` and
   `GOOGLE_REDIRECT_URI` away from the expired Cloudflare tunnel, and re-register each with
   Meta, Twilio and Google.
4. Decide what to do about **Client Reviews**, which is in the sidebar but not built.
5. `pg_dump` before every deploy that includes a migration.
