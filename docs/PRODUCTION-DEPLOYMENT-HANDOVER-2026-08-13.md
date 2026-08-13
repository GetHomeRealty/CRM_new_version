# Production Deployment Handover — Get Home Realty CRM + Transaction Desk

**Prepared:** 2026-08-13 · **Audited against:** the working tree at branch `version_3`
**For:** the developer performing the production deployment. No knowledge of how this application
was built is assumed.

Every fact below was read out of the current codebase, not from earlier documentation. Where an
older document disagrees, this one is newer — but the code is the authority, and the verification
command is given for each claim so you can confirm it yourself on the day.

**Read §0 before anything else.** There are findings that will stop a deployment.

Related existing documents, still accurate where cited:
[`VPS-DEPLOYMENT.md`](VPS-DEPLOYMENT.md) ·
[`OPERATIONS.md`](OPERATIONS.md) ·
[`REDIS-SETUP.md`](REDIS-SETUP.md) ·
[`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) ·
[`PRODUCTION-MIGRATION-RUNBOOK-2026-08-08.md`](PRODUCTION-MIGRATION-RUNBOOK-2026-08-08.md)

---

## 0. Findings — read first

Ordered by what will hurt you soonest. Each is repeated in context in its own section.

### BLOCKER 1 — `APP_KEY` is required to boot but is not in `.env.example`

`server/src/config/validate-config.ts` refuses to start a production process without a valid
`APP_KEY` (base64, exactly 32 bytes decoded). `server/.env.example` does **not** contain an
`APP_KEY=` line — it appears once, at line 349, inside a comment about carrying an existing key
forward. A developer who builds a production `.env` from the example will produce a server that
refuses to start.

Worse, `APP_KEY` is not free to choose. It encrypts stored IMAP passwords, Google refresh tokens and
Meta access tokens. **If this application has ever run in production, you must carry the existing
key forward byte for byte.** A new key does not error — every stored credential simply becomes
undecryptable, and integrations silently stop working.

- **Before deployment:** obtain the existing production `APP_KEY` from whoever holds it. Only if
  this is a genuinely first deployment may you generate one: `openssl rand -base64 32`.
- **Verify:** `node -e "const k=process.env.APP_KEY.replace(/^base64:/,'');console.log(Buffer.from(k,'base64').length)"` → must print `32`.

### BLOCKER 2 — `META_PUBLIC_URL` in the current `.env` is an ngrok tunnel

The working `.env` carries `META_PUBLIC_URL=https://apply-scouts-flaring.ngrok-free.dev`. That is a
development tunnel whose hostname changes on every restart. `validate-config.ts` detects this
(`EPHEMERAL_TUNNEL`) and **will refuse to start a production process**, which is the correct
behaviour — but it means the deployment stops unless a real value is set first.

- **Before deployment:** set `META_PUBLIC_URL` to the production API origin (e.g.
  `https://api.yourdomain.ca`) and register the same value in the Meta app. See §13.

### RISK 1 — `TWILIO_PUBLIC_URL` is a Cloudflare quick tunnel and is **not** boot-checked

The working `.env` carries `TWILIO_PUBLIC_URL=https://beans-betty-marker-contracting.trycloudflare.com`.
Unlike `META_PUBLIC_URL` and `CAMPAIGN_PUBLIC_URL`, this value has **no boot validation** — the
server will start happily with a dead tunnel in it. The consequences are silent: Twilio status
callbacks never arrive, and webhook signature verification rebuilds the wrong URL and rejects
legitimate requests.

- **Before deployment:** set it to the production API origin, or clear it if SMS/voice is not being
  used in production. Verify with `curl -sI "$TWILIO_PUBLIC_URL/api/sms/twilio/status"`.

### RISK 2 — `MAIL_REDIRECT_TO` overrides production and diverts **all** outgoing mail

`MailerService.redirectTarget()` checks `MAIL_REDIRECT_TO` **first**, before the `NODE_ENV` check.
If that variable survives into the production `.env`, every email the system sends — client
welcomes, campaigns, notifications, password flows — silently goes to that one address instead of
the recipient. Nothing errors. Nothing in the UI says so.

- **Before deployment:** confirm `MAIL_REDIRECT_TO` is absent or empty in the production `.env`.
- **Verify after start:** `pm2 logs crm-worker --lines 200 | grep -i "diverted"` must return nothing.

### RISK 3 — PM2 will set an empty `DATABASE_URL` if the shell has none

`server/ecosystem.config.cjs` builds `DATABASE_URL` with `withPool()`, which reads
`process.env.DATABASE_URL || ''` **at the moment PM2 evaluates the config file**. If you run
`pm2 start ecosystem.config.cjs` from a shell where `DATABASE_URL` is not exported, PM2 sets it to
the empty string in the child process — and `dotenv` will not replace an existing key, even an empty
one, so the `.env` value never applies.

The failure is loud, not silent: `assertProductionConfig` stops the boot with `DATABASE_URL is not
set.` But it is *confusing*, because `.env` plainly contains it. The safe startup method is in §7.

- **Fix on the day:** `set -a && . /var/www/crm/server/.env && set +a && pm2 start ecosystem.config.cjs`

### RISK 4 — `.env.example` is missing 13 variables the code reads

Confirmed absent from `server/.env.example` while being read by `server/src`:
`APP_KEY`, `REDIS_URL`, `LOG_LEVEL`, `LOG_FORMAT`, `MAIL_ALLOW_REAL_SEND`, `LEAD_RETENTION_DAYS`,
`MAIL_RETENTION_DAYS`, `IMAP_POLL_SECONDS`, `RATE_LIMIT_PER_MINUTE`, `MFA_TRUSTED_DEVICE_DAYS`,
`MLS_API_URL`, `WEB_INSTANCES`, `WEB_DB_POOL`.

All but `APP_KEY` have working defaults, so this is a documentation gap rather than a failure.
§3 below is the complete list; treat §3 as authoritative over `.env.example`.

### RISK 5 — obsolete variables still in `.env.example`

`MYSQL_URL`, `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`, `FACEBOOK_REDIRECT_URI` are leftovers from the
Laravel/Next.js application this replaced. Nothing in `server/src` reads the first three. Do not carry them
into the production `.env`; they invite someone to configure a system that is not there.

### RECOMMENDED BEFORE DEPLOYMENT

- **Redis is installed in production but has never been verified.** `docs/REDIS-SETUP.md` says so
  explicitly. Run `node scripts/verify-redis.cjs` (§5). All four things it checks fail *silently*.
- **The CRM greeting-preference migration has not had its production dry-run.** See §15.
  `node scripts/migrate-crm-greeting-prefs.cjs` is read-only by default. It does not block this
  deployment; it blocks a later phase.
- **Seeded test accounts.** `server/scripts/seed-test-env.cjs` creates accounts such as
  `superadmin@test.local` / `admin@test.local` with the password `TestPass123!`. This script must
  **never** be run against production. Confirm no `@test.local` account exists (§17).

### OPTIONAL IMPROVEMENT

- `PORT` for the worker (`8001`) is bound but nothing routes to it. Consider firewalling it to
  localhost only (§2) so `/api/health/workers` is not publicly reachable.
- No migration in the repository uses `CREATE INDEX CONCURRENTLY` (§4 Step 5) — each one explains
  why in its own header. Nothing here needs the concurrent-index procedure today.

---

## 1. Application overview

### Architecture

One Node.js application, served by nginx, backed by PostgreSQL. The React SPA is built to static
files and served by nginx directly; every `/api/*` request is proxied to the Node process. There is
no server-side rendering and no second application tier.

The product contains **two areas** that share one codebase, one database and one session:

| Area | URL prefix | What it is |
|---|---|---|
| CRM | `/crm/*` | Leads, campaigns, Meta lead ads, CRM inbox, CRM settings |
| Transaction Desk | `/desk/*` | Deals, documents, invoices, reports |

The separation is enforced by `mail_accounts.scope` and `google_connections.scope`, so a CRM email
account never appears on the Transaction Desk side and vice versa. **Do not merge them.**

### Stack — verified from the manifests

| Layer | Technology | Version constraint |
|---|---|---|
| Frontend | React SPA built by Vite | React `^19.0.0`, Vite `^7.0.0` |
| Backend | NestJS on Express | `@nestjs/core ^10.4.15` |
| ORM | Prisma | `@prisma/client ^6.2.1` |
| Database | PostgreSQL | 14+, **16 recommended** |
| Runtime | Node.js | `engines: >=20.19`; **22 LTS recommended** |
| Cache/queues | Redis | **6.2 minimum** (BullMQ floor) — optional, see §5 |

Verify: `node -e "const s=require('./server/package.json');console.log(s.engines, s.dependencies['@nestjs/core'])"`

### Services — required vs optional

| Service | Status | If absent |
|---|---|---|
| PostgreSQL | **Required** | Application does not start |
| Node.js ≥20.19 | **Required** | Build/runtime failures |
| nginx | **Required (production)** | No TLS, no SPA serving |
| PM2 | **Required (production)** | No multi-process, no restart-on-boot |
| Redis | **Optional by design** | Dashboard cache is a no-op; queues run in-process and lose jobs on restart; scheduler single-execution rests entirely on `RUN_SCHEDULERS=false` (§8) |
| SMTP mail account | **Required for any email** | All sending refused with a readable message |
| IMAP mail account | Optional | Inbox stays empty; "Sync now" still offered |
| Google OAuth | Optional | Calendar/Gmail connect buttons refuse |
| Meta / Facebook | Optional | Lead-ads integration absent; boot checks skipped entirely |
| Twilio | Optional | Falls back to `sms:` deep links; click-to-call refused |
| Anthropic API | Optional | AI email drafting and ID extraction unavailable |
| MLS feed | Optional | MLS screens empty |
| Web push (VAPID) | Optional | Push channel unavailable; email/in-app unaffected |
| Cloudflare/ngrok tunnels | **Development only** | Must not appear in production (§0) |
| `seed-test-env.cjs` | **Development only** | Must never run against production |

### Ports

| Port | Process | Exposure |
|---|---|---|
| 8000 | `crm-web` (PM2 cluster, all instances share it) | localhost only; nginx proxies to it |
| 8001 | `crm-worker` (PM2 fork, single instance) | localhost only; nothing routes to it |
| 5432 | PostgreSQL | localhost only |
| 6379 | Redis | localhost only |
| 80 / 443 | nginx | public |

Default port comes from `PORT`, falling back to `8000` (`server/src/config/configuration.ts:53`).

### Process model

Four web processes plus one worker — see §7 for the arithmetic and §8 for why the worker is separate.

### Authentication / sessions

Cookie sessions via `express-session` + `connect-pg-simple`, stored in PostgreSQL table
`user_sessions`. Sessions therefore survive restarts and are shared across all PM2 instances — **a
deploy never signs anybody out**. Passwords are `bcryptjs` at cost 12. Optional two-factor
(TOTP / email OTP / SMS OTP) with recovery codes and trusted devices. CSRF via a
`sanctum/csrf-cookie` route served outside the `/api` prefix.

### File storage

Local filesystem under `STORAGE_ROOT`. Default is `<repo>/storage/app`. **This is why the
application cannot be scaled across machines without shared storage** — see §16.

---

## 2. Pre-deployment checklist

| # | Requirement | How to verify | Expected | If missing |
|---|---|---|---|---|
| 1 | SSH access with sudo | `ssh user@host 'sudo -n true && echo ok'` | `ok` | Cannot proceed |
| 2 | DNS A record for the site | `dig +short yourdomain.ca` | server's public IP | TLS issuance fails |
| 3 | DNS for the API host (if split) | `dig +short api.yourdomain.ca` | server's public IP | OAuth callbacks fail |
| 4 | Node.js ≥ 20.19 | `node -v` | `v22.x` preferred | Build fails; `engines` refuses |
| 5 | npm | `npm -v` | 10+ | — |
| 6 | PostgreSQL ≥ 14 | `psql -V` | `psql (PostgreSQL) 16.x` | App will not start |
| 7 | Database exists | `psql -lqt \| cut -d\| -f1 \| grep -w crm_production` | name printed | Migrations fail |
| 8 | DB user + privileges | `psql "$DATABASE_URL" -c '\du'` | user owns the DB | Migrations fail |
| 9 | `max_connections` headroom | `psql -c 'SHOW max_connections;'` | **≥ 200** (see §4) | Random connect failures under load |
| 10 | Redis ≥ 6.2 (if used) | `redis-cli INFO server \| grep redis_version` | `6.2`+ | BullMQ refuses to start |
| 11 | PM2 installed globally | `pm2 -v` | 5+ | No process management |
| 12 | nginx installed | `nginx -v` | 1.18+ | No TLS/SPA |
| 13 | certbot installed | `certbot --version` | any | No automatic TLS |
| 14 | OS packages | `dpkg -s git curl ca-certificates openssl \| grep Status` | all `install ok installed` | Various |
| 15 | App directory | `ls -ld /var/www/crm` | owned by the deploy user | Permission errors |
| 16 | Storage directory | `ls -ld "$STORAGE_ROOT"` | exists, writable by the app user | **Boot refuses** (§16) |
| 17 | Firewall | `sudo ufw status` | 22, 80, 443 only | 5432/6379/8000 exposed |
| 18 | `APP_KEY` in hand | see §0 BLOCKER 1 | decodes to 32 bytes | **Boot refuses**; wrong key destroys stored credentials |
| 19 | `SESSION_SECRET` generated | `openssl rand -base64 48` | ≥32 chars, not the dev value | **Boot refuses** |
| 20 | Production URLs decided | — | HTTPS, no trailing slash | **Boot refuses** |
| 21 | Google OAuth client | Google Cloud console | client ID + secret, redirect registered | Connect buttons fail |
| 22 | Meta app configured | Meta app dashboard | app ID/secret, verify token, webhook URL | **Boot refuses if partly configured** |
| 23 | SMTP credentials | provider | host/port/user/pass | No email at all |
| 24 | IMAP credentials | provider | host/port 993 | Inbox stays empty |
| 25 | Backup destination writable | `touch $BACKUP_ROOT/.probe && rm $_` | succeeds | No rollback path |
| 26 | Existing production DB backup | §4 Step 2 | verified dump file | **Do not proceed** |

---

## 3. Production environment variables

Complete list of what `server/src` actually reads. **This supersedes `.env.example`**, which is
missing 13 of them (§0 RISK 4).

**Legend — Required:** `BOOT` = production refuses to start without it · `YES` = feature broken
without it · `OPT` = optional.

### Application

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `NODE_ENV` | **BOOT-ish** | Enables every production guard | `production` | you | Anything else disables all §0 boot validation **and diverts mail to a sink** |
| `PORT` | OPT | Web listen port (default 8000) | `8000` | you | Set by PM2 per app; do not set in `.env` |
| `TZ` | **BOOT** | Date arithmetic uses server local time | `America/Toronto` | you | Unset → UTC host records evening entries on the next day |
| `BCRYPT_ROUNDS` | OPT | Password cost (default 12) | `12` | you | Raising it lowers login throughput (§7) |

### Database

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `DATABASE_URL` | **BOOT** | PostgreSQL connection | `postgresql://user:pass@127.0.0.1:5432/crm_production?schema=public` | you | Must be exported in the shell when starting PM2 (§0 RISK 3). PM2 appends `connection_limit` per process |
| `MYSQL_URL` | **obsolete** | — | — | — | Legacy; do not set |

### Security

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `APP_KEY` | **BOOT** | AES-256-GCM key for stored IMAP passwords, Google refresh tokens, Meta tokens, TOTP secrets | `base64:...` (32 bytes) | **existing production key** | A *new* key makes every stored credential undecryptable — silently |
| `ANTHROPIC_API_KEY` | OPT | AI drafting / ID extraction | `sk-ant-...` | Anthropic console | Blank disables the features cleanly |

### Sessions

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `SESSION_SECRET` | **BOOT** | Signs session cookies | 48-byte base64 | `openssl rand -base64 48` | Dev default `insecure-dev-secret` is public in this repo. Must be **identical on web and worker** |
| `SESSION_COOKIE_NAME` | OPT | Cookie name (default `laravel_session`) | `laravel_session` | you | Changing it signs everyone out |
| `SESSION_LIFETIME_MINUTES` | OPT | Idle timeout (default 120) | `120` | you | Rolling — active users are not logged out |
| `COOKIE_SECURE` | **BOOT** | `Secure` flag | `true` | you | `false` → cookie sent in clear; boot refuses |
| `COOKIE_SAMESITE` | OPT | `lax`/`strict`/`none` (default `lax`) | `lax` | you | `none` requires `COOKIE_SECURE=true` or browsers drop the cookie |
| `COOKIE_DOMAIN` | OPT | Cross-subdomain cookie | `.yourdomain.ca` | you | **Must have the leading dot**; boot refuses without it |
| `MFA_TRUSTED_DEVICE_DAYS` | OPT | "Don't ask again" window | `30` | you | — |

### Email / SMTP / IMAP

SMTP and IMAP credentials are **stored in the database** (`mail_accounts`), configured through the
UI, not through environment variables. Only the following are environmental:

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `MAIL_REDIRECT_TO` | **must be EMPTY** | Diverts all outgoing mail to one address | *(empty)* | — | **Overrides production.** Set → every client email silently goes here (§0 RISK 2) |
| `MAIL_ALLOW_REAL_SEND` | dev only | Lets non-production send for real | *(unset)* | — | Irrelevant in production; ignored when `NODE_ENV=production` |
| `IMAP_POLL_SECONDS` | OPT | Inbox poll interval (default 60, floor 15) | `60` | you | Lower = more IMAP load |
| `IMAP_POLL_CONCURRENCY` | OPT | Parallel mailbox syncs | `3` | you | High values are rude to the mail server |
| `IMAP_POLL_DISABLED` | OPT | Kill switch | *(unset)* | — | `1` stops inbound mail entirely |
| `MAIL_RETENTION_DAYS` | OPT | Delete stored mail after N days | `365` | policy | Destructive sweep — see §8 |
| `MAIL_STRIP_BODIES_AFTER_DAYS` | OPT | Strip bodies, keep headers | `180` | policy | Destructive |
| `MAIL_RETENTION_INCLUDE_LINKED` | OPT | Include lead-linked mail in retention | `false` | policy | `true` deletes mail attached to leads |
| `CAMPAIGN_PUBLIC_URL` | YES (for open tracking) | Baked into every campaign pixel and unsubscribe link | `https://api.yourdomain.ca` | you | Wrong value = permanently dead unsubscribe links in already-sent mail (CASL exposure). Boot refuses localhost/non-HTTPS |

### Google

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | OPT | Calendar OAuth | `...apps.googleusercontent.com` | Google Cloud | — |
| `GOOGLE_CLIENT_SECRET` | OPT | Calendar OAuth | `GOCSPX-...` | Google Cloud | — |
| `GOOGLE_MAIL_CLIENT_ID` | OPT | Gmail OAuth (separate client) | as above | Google Cloud | Setting only one of the pair **refuses the flow after consent** |
| `GOOGLE_MAIL_CLIENT_SECRET` | OPT | Gmail OAuth | as above | Google Cloud | as above |
| `GOOGLE_REDIRECT_URI` | **YES in production** | Exact callback registered with Google | `https://api.yourdomain.ca/api/google/callback` | you | Currently `http://localhost:8000/...` in the dev `.env`. If unset it is derived from the request origin |
| `GOOGLE_PUBLIC_URL` | OPT | Base used when `GOOGLE_REDIRECT_URI` is unset | `https://api.yourdomain.ca` | you | — |

### Meta

Boot validation applies **only if `META_APP_ID` and `META_APP_SECRET` are both set.**

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `META_APP_ID` | OPT | Lead-ads app | numeric | Meta app dashboard | Setting this activates all the checks below |
| `META_APP_SECRET` | OPT | Lead-ads app | hex | Meta app dashboard | Also the HMAC fallback for webhooks |
| `META_PUBLIC_URL` | **BOOT** (if configured) | OAuth redirect **and** webhook host | `https://api.yourdomain.ca` | you | **Currently an ngrok tunnel — §0 BLOCKER 2.** Must be HTTPS, not localhost, not a tunnel, no trailing slash |
| `META_WEBHOOK_VERIFY_TOKEN` | **BOOT** (if configured) | Subscription handshake | random string | you, then Meta | Without it the subscription never completes and leads only arrive by polling |
| `META_WEBHOOK_SECRET` | OPT | Explicit HMAC secret | hex | Meta | Falls back to app secret |
| `META_GRAPH_API_VERSION` | OPT | Graph version pin | `v21.0` | you | — |
| `META_SYNC_SECONDS` | OPT | Poll interval (default 900, floor 60) | `900` | you | — |
| `META_SYNC_DISABLED` | OPT | Kill switch | *(unset)* | — | `1` = polling off; webhooks still deliver |
| `META_LOGIN_CONFIG_ID`, `META_OAUTH_STRATEGY`, `META_OAUTH_SYSTEM_USER` | OPT | OAuth variants | — | Meta | — |
| `META_MAX_LEADS_PER_FORM`, `META_RAW_MAX_CHARS`, `META_RAW_RETENTION_DAYS`, `META_BUDGET_PER_WINDOW`, `META_BUDGET_WINDOW_MINUTES`, `META_GRAPH_TIMEOUT_MS`, `META_WEBHOOK_QUIET_HOURS`, `META_RECONNECT_NOTICE_HOURS` | OPT | Tuning | — | — | Defaults are sensible |
| `FACEBOOK_*` aliases | OPT | Legacy names | — | — | `META_*` wins when both set |

### Redis

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `REDIS_URL` | OPT | Cache, queues, distributed lock | `redis://:password@127.0.0.1:6379` | `setup-redis.sh` | Unset = everything in-process (§5). **Must be identical on web and worker** |
| `REDIS_PREFIX` | OPT | Key namespace (default `ghr:`) | `ghrprod:` | you | A shared prefix between environments is silent cross-contamination |

### Schedulers / workers

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `RUN_SCHEDULERS` | **critical** | Whether this process owns background jobs | `false` web / `true` worker | PM2 sets it | **Load-bearing.** Wrong on a web process = duplicate client emails (§8) |
| `WEB_INSTANCES` | OPT | Web process count (default 4) | `4` | you | Changes the connection arithmetic (§7) |
| `WEB_DB_POOL` / `WORKER_DB_POOL` | OPT | Prisma pool per process (20 / 10) | `20` / `10` | you | See §4 Step 1 arithmetic |
| `LEAD_WELCOME_DISABLED`, `LEAD_GREETINGS_DISABLED`, `LEAD_TASK_REMINDERS_DISABLED`, `EVENT_REMINDER_DISABLED`, `REMINDER_SWEEP_DISABLED`, `REVIEW_SLA_DISABLED`, `META_SYNC_DISABLED`, `IMAP_POLL_DISABLED` | OPT | Per-job kill switches | `1` to disable | — | Useful for a staged first day |
| `LEAD_RETENTION_DAYS` | OPT | Permanent deletion of soft-deleted leads | `90` | policy | **Destructive.** See §8 |

### URLs / domains

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `FRONTEND_URL` | **BOOT** | Builds OAuth returns and links inside notification emails | `https://yourdomain.ca` | you | Must be HTTPS, not localhost, **no trailing slash** |
| `CORS_ORIGINS` | **BOOT** | Allowed browser origins (comma-separated) | `https://yourdomain.ca` | you | Falls back to `FRONTEND_URL`. No trailing slash, no localhost, HTTPS only |

### File uploads / storage

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `STORAGE_ROOT` | **YES** | Uploads, exports, recordings, logos, photos | `/var/lib/crm/storage` | you | **Boot refuses if it does not exist.** Must be outside the deploy directory (§16) |
| `RECORDING_STORAGE`, `RECORDING_STORAGE_DIR` | OPT | Call recordings | — | you | — |

### Logging

| Variable | Required? | Purpose | Example | Where obtained | Production warning |
|---|---|---|---|---|---|
| `LOG_LEVEL` | OPT | `debug`/`log`/`warn`/`error` (default `log`) | `log` | you | `debug` is very noisy at 500 users |
| `LOG_FORMAT` | OPT | `json`/`pretty` (defaults to json in production) | `json` | you | — |

### Other integrations

| Variable | Required? | Purpose | Example | Production warning |
|---|---|---|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` / `TWILIO_MESSAGING_SERVICE_SID` | OPT | SMS + click-to-call | — | Absent → `sms:` deep links |
| `TWILIO_PUBLIC_URL` | YES if Twilio used | Status callbacks + signature rebuild | `https://api.yourdomain.ca` | **Not boot-checked. Currently a dead tunnel — §0 RISK 1** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | OPT | Web push | — | Absent → push channel unavailable |
| `MLS_API_URL` / `MLS_ACCESS_TOKEN` | OPT | MLS feed | — | Absent → MLS screens empty |
| `RATE_LIMIT_PER_MINUTE` (600), `RATE_LIMIT_ANON_PER_MINUTE` (1200), `AUTH_RATE_LIMIT_MAX` (120)/`_WINDOW_SECONDS` (300), `AUTH_ACCOUNT_LIMIT_MAX` (8)/`_WINDOW_SECONDS` (900), `BROADCAST_RATE_LIMIT_MAX` (3), `SETTINGS_WRITE_RATE_LIMIT_MAX` (30), `META_SYNC_RATE_LIMIT_MAX` (6) | OPT | Throttling | defaults shown | Defaults are production-sane; raising the auth ones weakens brute-force defence |

### Variables that must match between web and worker

`DATABASE_URL` (except the pool suffix), `APP_KEY`, `SESSION_SECRET`, `REDIS_URL`, `REDIS_PREFIX`,
`TZ`, `STORAGE_ROOT`, `FRONTEND_URL`. A mismatch in `APP_KEY` or `SESSION_SECRET` produces
undecryptable credentials or sessions that work on some requests and not others.

---

## 4. Database deployment

### Step 1 — Confirm PostgreSQL

```bash
psql -V                                             # ≥ 14, 16 recommended
psql "$DATABASE_URL" -c 'SELECT current_database(), current_user, version();'
psql "$DATABASE_URL" -c 'SHOW max_connections;'
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity;"
```

**The arithmetic you must do before deploying.** From `server/ecosystem.config.cjs`:

```
WEB_INSTANCES (4) × WEB_DB_POOL (20)  =  80
crm-worker × WORKER_DB_POOL (10)      =  10
                                        ---
application total                        90
+ session pool (main.ts opens its own pg Pool per process, 5 × default 10)  ≈ 50
+ psql, backups, monitoring                                                 ≈ 10
                                                                            ---
                                                              realistic peak ≈ 150
```

**`max_connections` must be ≥ 200.** The PostgreSQL default of 100 is not enough — and exceeding it
fails at connect time rather than degrading, so the symptom is a hard error under load, not
slowness.

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 200;"
sudo -u postgres psql -c "ALTER SYSTEM SET shared_buffers = '2GB';"   # ~25% of RAM
sudo systemctl restart postgresql                                      # REQUIRES A RESTART
psql "$DATABASE_URL" -c 'SHOW max_connections;'                        # expect 200
```

**If it fails:** the restart drops every connection. Do it in the maintenance window, before the
application starts.

### Step 2 — Backup, before any migration

```bash
export STAMP=$(date +%Y%m%d-%H%M%S)
export BACKUP_ROOT=/var/backups/crm
sudo mkdir -p "$BACKUP_ROOT" && sudo chown "$USER" "$BACKUP_ROOT"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
        --file="$BACKUP_ROOT/pre-deploy-$STAMP.dump"

# Verify the file is a real, restorable dump — not an empty or truncated one.
pg_restore --list "$BACKUP_ROOT/pre-deploy-$STAMP.dump" | head -20
ls -lh "$BACKUP_ROOT/pre-deploy-$STAMP.dump"
```

**Expected:** `pg_restore --list` prints a table of contents; the file is megabytes, not bytes.
**If `pg_restore --list` errors, the backup is not valid. Do not proceed.**

The repository also has `npm --prefix server run backup` and `backup:verify`, which are
cross-platform and used by `docs/DISASTER-RECOVERY.md`.

### Step 3 — Migration status

```bash
cd /var/www/crm/server
npx prisma migrate status              # or: npm run prisma:status
ls -d prisma/migrations/*/ | wc -l     # expect 72 migration directories
                                       # (00000000000000_init + 71 dated) plus migration_lock.toml
node scripts/migration-preflight.cjs   # READ-ONLY; safe against production
```

**Expected:** either "Database schema is up to date" or a list of pending migrations.
`migration-preflight.cjs` runs only `SELECT`s and reports RED (migration will stop) / AMBER
(migration proceeds but leaves something behind).

**If it reports drift:** stop. Drift means the production schema was changed outside Prisma.
Resolving it is a separate exercise — do not let a migration "fix" it.

### Step 4 — Apply migrations

```bash
cd /var/www/crm/server
npx prisma migrate deploy     # or: npm run prisma:deploy
```

`migrate deploy` applies pending migrations and nothing else. It never resets, never prompts, never
generates.

**Commands that must NEVER be run against production:**

| Command | What it does |
|---|---|
| `prisma migrate dev` | May **drop and recreate the database** to resolve drift. The repo guards it with `scripts/guard-migrate-dev.cjs`, but do not rely on that |
| `prisma migrate reset` | **Deletes all data**, unconditionally |
| `prisma db push` | Applies schema without a migration record; causes permanent drift |
| `prisma db seed` | Overwrites data |
| `node scripts/seed-test-env.cjs` | Creates `@test.local` accounts with a published password |

### Step 5 — Indexes

**Audited: no migration in this repository uses `CREATE INDEX CONCURRENTLY`.** Three migrations
discuss it in their headers and explain why they deliberately do not — Prisma wraps each migration
file in a transaction, and `CONCURRENTLY` cannot run inside one:

| Migration | Index | Why plain `CREATE INDEX` is safe |
|---|---|---|
| `20260801230000_leads_owner_index` | `leads.owner_user_id` | Measured at 512 rows; build is milliseconds |
| `20260805200000_inbox_list_index` | two composite indexes on `inbound_emails (…, received_at DESC)` | Measured at 2,265 rows |
| `20260808140000_tenant_removal_replacement_constraints` | replacement unique constraints | Additive only; nothing dropped |

**Locking implication:** a plain `CREATE INDEX` takes a `SHARE` lock, blocking writes to that table
for the duration. At the current table sizes this is sub-second. **If production has grown far
beyond development** — verify first:

```bash
psql "$DATABASE_URL" -c "SELECT relname, n_live_tup FROM pg_stat_user_tables
                         WHERE relname IN ('leads','inbound_emails') ORDER BY n_live_tup DESC;"
```

If either exceeds ~500,000 rows, take the migration in a maintenance window, or create the index by
hand with `CONCURRENTLY` outside Prisma and then mark the migration applied.

**Verify afterwards:**
```bash
psql "$DATABASE_URL" -c "\di leads*"
psql "$DATABASE_URL" -c "\di inbound_emails*"
psql "$DATABASE_URL" -c "SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;"
```
The last query must return **no rows** — an invalid index is a failed concurrent build.

### Step 6 — Database verification

```bash
npx prisma migrate status                                                   # up to date
psql "$DATABASE_URL" -c "\dt" | wc -l                                       # tables present
psql "$DATABASE_URL" -c "SELECT count(*) FROM users WHERE status='Active';" # real users
psql "$DATABASE_URL" -c "SELECT count(*) FROM leads WHERE deleted_at IS NULL;"
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE contype='f' LIMIT 5;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM user_sessions;"               # session store exists
psql "$DATABASE_URL" -c "SELECT count(*) FROM email_templates WHERE module='CRM';"
node scripts/db-state.cjs                                                    # repo's own summary
```

---

## 5. Redis

**Not mandatory.** The application runs correctly without it. `docs/REDIS-SETUP.md` records that
Redis **is installed in production as of 2026-08-08 but has never been verified.**

### What is affected without Redis

| Capability | Without Redis | With Redis |
|---|---|---|
| CRM dashboard cache | no-op; 12 aggregates recomputed per request | 20-second per-user entries |
| Background queues | in-process; **jobs lost on restart**, not shared across processes | BullMQ, durable, shared |
| Scheduler single-execution | rests **entirely** on `RUN_SCHEDULERS=false` being correct on all 4 web processes | a real distributed lock |

That third row is the important one: `clusterTick` deliberately **runs its tick when no lock is
available** (fail-open). Without Redis, PM2's `RUN_SCHEDULERS=false` is the only thing preventing
four processes from sending the same client email four times.

### Setup

```bash
sudo bash server/scripts/setup-redis.sh          # idempotent; refuses below Redis 6.2
sudo bash server/scripts/setup-redis.sh --verify-only
```

The script generates the password on the machine from `/dev/urandom`, so it is never typed or
pasted. Then:

```bash
# /etc/redis/redis.conf must contain:
bind 127.0.0.1 ::1        # never 0.0.0.0
requirepass <generated>
maxmemory-policy noeviction   # NOT allkeys-lru — eviction silently drops queue jobs

sudo systemctl enable --now redis-server
redis-cli -a "$PASS" PING          # PONG
```

Set in `.env`: `REDIS_URL=redis://:<password>@127.0.0.1:6379` and a production-unique
`REDIS_PREFIX`.

### Application verification — do not skip

```bash
cd /var/www/crm/server && node scripts/verify-redis.cjs
```

Checks prefix isolation, cache round-trip and expiry, **lock atomicity across two connections**, and
`noeviction`. Exits non-zero so it can gate a deployment step. All four failure modes are silent in
normal use — that is why this exists.

---

## 6. Build

Both halves are built on the server. Neither build needs a database.

### Backend

```bash
cd /var/www/crm/server
npm ci                       # exact versions from package-lock.json — not `npm install`
npx prisma generate          # regenerate the client for this platform
npm run build                # prebuild cleans dist/, nest build, postbuild verifies
```

**Expected output:** `build-guard: dist/main.js present (46 entries in dist/)`.
The `postbuild` guard fails the build if `dist/main.js` is missing, so a silent partial build cannot
reach PM2.

**Environment during build:** none required. `DATABASE_URL` is only needed by `prisma generate` if
you use `--schema` overrides; the checked-in schema is self-contained.

**Verify:** `ls -la dist/main.js && node -e "require('./dist/main.js')" 2>&1 | head -3`
(the second will try to boot — Ctrl-C; it proves the bundle loads.)

### Frontend

```bash
cd /var/www/crm/client
npm ci
VITE_API_URL=https://api.yourdomain.ca npm run build
```

`VITE_API_URL` is **baked into the bundle at build time** — it cannot be changed afterwards without
rebuilding. This is the only client-side environment variable (`client/src` reads
`import.meta.env.VITE_API_URL` and nothing else).

**Expected output:** `✓ built in ~6s`, files under `client/dist/`.
**Verify:** `ls client/dist/index.html && grep -ro "api.yourdomain.ca" client/dist/assets | head -1`

**If the API is served from the same origin** (e.g. `https://yourdomain.ca/api`), set
`VITE_API_URL=https://yourdomain.ca` and let nginx route `/api/`.

---

## 7. PM2 / process architecture

Read from `server/ecosystem.config.cjs`. **Confirmed still current.**

| | `crm-web` | `crm-worker` |
|---|---|---|
| Mode | `cluster` | `fork` |
| Instances | `WEB_INSTANCES` (default **4**) | **1**, always |
| Port | 8000 (shared by all instances) | 8001 (nothing routes to it) |
| `RUN_SCHEDULERS` | **`false`** | **`true`** |
| Prisma pool | 20 per process | 10 |
| `max_memory_restart` | 1 GB | 1 GB |
| `max_restarts` / `min_uptime` | 10 / 30s | 10 / 30s |
| `kill_timeout` | 15s | 15s |
| `TZ` | `America/Toronto` | same |

**Why four web processes:** `bcryptjs` is pure JavaScript with no threadpool, so every password
verification runs on the event loop — measured at 226 ms of CPU per login, ~4.3 logins/second per
process. Four processes gives ~17/s, turning a 500-agent 9 a.m. rush from ~117 s into ~30 s. This is
documented with measurements in the config file itself.

**Why the worker is a separate named app rather than "instance 0":** a cluster instance is
replaceable. PM2 restarts one on crash or reload, and during that window either two processes hold
the scheduler role or none does. A named single-instance app has one identity.

**Why one machine:** uploads, exports, recordings, user photos and the brand logo are written to the
local filesystem under `STORAGE_ROOT`. Processes on separate hosts would each see only their own
files — an upload succeeds and the download 404s, with nothing reporting it.

### Safe startup — this matters (§0 RISK 3)

```bash
cd /var/www/crm/server
set -a && . ./.env && set +a          # export .env into the shell FIRST
pm2 start ecosystem.config.cjs
```

Without the `set -a` line, `withPool()` in the config sees no `DATABASE_URL`, sets it to the empty
string in the child process, and `dotenv` will not replace an already-present key. The boot fails
with `DATABASE_URL is not set` even though `.env` contains it.

**Verify the pool suffix actually applied:**
```bash
pm2 env 0 | grep DATABASE_URL     # must end in ?...connection_limit=20&pool_timeout=30
```

### Operating commands

```bash
pm2 status                        # both apps 'online', restarts 0
pm2 logs crm-web --lines 100
pm2 logs crm-worker --lines 100   # where every sweep reports
pm2 reload crm-web                # zero-downtime, web only — never reload the worker mid-sweep
pm2 save                          # persist the process list
pm2 startup systemd               # prints a command; run it with sudo
sudo reboot                       # then: pm2 status — both must be back
```

**Reboot persistence test is mandatory.** `pm2 save` after `pm2 startup`, then actually reboot and
confirm. A deployment that does not survive a reboot is not deployed.

---

## 8. Scheduled jobs and automatic processes

Every job below runs **only** where `schedulersEnabled()` is true — that is, `RUN_SCHEDULERS=true`,
which in production is the `crm-worker` process alone. Each is additionally wrapped in `clusterTick`,
which takes a Redis lock when Redis is available and **runs anyway when it is not** (fail-open).

| Job | Purpose | Schedule | Process | Prod enabled? | Risk if duplicated |
|---|---|---|---|---|---|
| `lead-welcome` | New-lead welcome email | every **5 min**, first pass 60 s | worker | Yes, but the `welcome` trigger **defaults off** | Duplicate client welcome emails |
| `lead-greetings` | Birthday + anniversary greetings | hourly, first pass 90 s | worker | Yes; both triggers **default off** | Duplicate greetings to clients |
| `lead-task-due` | Follow-up / task due reminders | every **30 min**, first pass 45 s | worker | Yes | Duplicate agent notifications |
| `lead-retention` | **Permanent deletion** of soft-deleted leads | daily | worker | Only if `LEAD_RETENTION_DAYS` set | **Irreversible data loss** |
| `imap-sync` | Pull inbound mail | every `IMAP_POLL_SECONDS` (60) | worker | Yes | Duplicate stored messages (deduped on account+UID) |
| `mail-retention` | Delete/strip stored mail | daily | worker | Only if `MAIL_RETENTION_DAYS` set | **Irreversible mail loss** |
| `meta-sync` | Poll Meta lead forms | every `META_SYNC_SECONDS` (900) | worker | If Meta configured | Duplicate leads |
| `google-calendar-retry` | Retry failed Google pushes | every 5 min | worker | If Google configured | Duplicate calendar events |
| `event-reminders` | Appointment reminders | every 10 min | worker | Yes | Duplicate reminder emails |
| `reminder-sweep` | Listing/lawyer reminders (Desk) | hourly | worker | Yes | Duplicate reminders |
| `review-sla` | Document review SLA reminders (Desk) | hourly | worker | Yes | Duplicate reminders |
| `export-sweeper` | Delete expired generated exports | every 15 min | worker | Yes | Harmless |
| `campaign-resume` | Resume interrupted campaigns | on tick | worker | Yes | **Duplicate campaign sends** |
| `queue:*` | BullMQ workers (with Redis) / in-process | continuous | worker | Yes | Duplicate job execution |

### How to avoid running a scheduler twice

Three independent defences, in order of reliability:

1. **`RUN_SCHEDULERS=false` on every web process.** Set by `ecosystem.config.cjs`. This is the
   load-bearing one without Redis.
2. **`schedulersEnabled()` refuses to run under a process manager unless told explicitly.** It reads
   `NODE_APP_INSTANCE`/`INSTANCE_ID` (PM2 sets these) and stays quiet unless `RUN_SCHEDULERS` is an
   explicit `true`.
3. **`clusterTick` Redis lock** — a real distributed lock, but only when `REDIS_URL` is set.

**Verify on the day:**

```bash
pm2 env 0 | grep RUN_SCHEDULERS         # crm-web  → false
pm2 env 4 | grep RUN_SCHEDULERS         # crm-worker → true  (index from `pm2 status`)
curl -s localhost:8001/api/health/workers | jq   # the worker's registered jobs
curl -s localhost:8000/api/health/workers | jq   # should show NO scheduled workers
pm2 logs crm-web --lines 200 | grep -ci "not scheduled"   # web logs "not scheduled" lines
```

**Staged first day (recommended):** start with the destructive and client-facing jobs disabled, then
enable them once the deployment is proven:

```bash
LEAD_RETENTION_DAYS=          # leave unset — no permanent deletion
MAIL_RETENTION_DAYS=          # leave unset
LEAD_WELCOME_DISABLED=1       # enable after the mail path is verified
LEAD_GREETINGS_DISABLED=1
```

---

## 9. nginx

The application's internal port is **8000** (`crm-web`). Verify before assuming:
`pm2 env 0 | grep '^PORT'`.

```nginx
# /etc/nginx/sites-available/crm
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.ca www.yourdomain.ca;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourdomain.ca www.yourdomain.ca;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.ca/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.ca/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Must exceed the app's own 12 MB body limit (main.ts useBodyParser) and the
    # 20 MB document upload interceptor. 25m gives both headroom.
    client_max_body_size 25m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy no-referrer always;
    # HSTS is also set by helmet in the app; harmless to repeat at the edge.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               application/xml image/svg+xml;
    gzip_min_length 1024;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";

        # Report generation, exports and large imports are slow by nature.
        proxy_connect_timeout 60s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
        proxy_buffering       off;      # so streamed downloads start immediately
    }

    # Served OUTSIDE the /api prefix by the application — see main.ts setGlobalPrefix exclude.
    location = /sanctum/csrf-cookie {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    }

    root /var/www/crm/client/dist;
    index index.html;

    # SPA: every unknown path is a client route, not a 404.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite emits content-hashed filenames, so these are safe to cache hard.
    location ~* \.(js|css|woff2?|png|jpe?g|svg|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }
}
```

**`X-Forwarded-Proto` and `X-Forwarded-For` are not optional.** `main.ts` sets `trust proxy 1`;
without these headers secure cookies break and every request appears to come from nginx, collapsing
rate limiting into a single shared bucket.

**No WebSocket endpoints exist** in this application. The `Upgrade`/`Connection` headers above are
harmless and future-proof.

```bash
sudo ln -s /etc/nginx/sites-available/crm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 10. SSL / HTTPS

```bash
dig +short yourdomain.ca                   # must be this server's IP, propagated
sudo certbot --nginx -d yourdomain.ca -d www.yourdomain.ca
sudo certbot renew --dry-run               # must report success
systemctl list-timers | grep certbot       # renewal timer active

curl -sI https://yourdomain.ca | head -1               # HTTP/2 200
curl -sI http://yourdomain.ca  | head -3               # 301 to https
curl -s  https://yourdomain.ca/api/health | jq         # {"status":"ok",...}
```

**Integrations that require HTTPS callbacks:** Google OAuth (refuses non-HTTPS redirect URIs except
`localhost`), Meta OAuth **and** webhooks (refuses outright), Twilio status callbacks, and campaign
open-tracking pixels (mail clients block insecure images). Boot validation enforces HTTPS on
`FRONTEND_URL`, `CORS_ORIGINS`, `META_PUBLIC_URL` and `CAMPAIGN_PUBLIC_URL`.

---

## 11. Domains and callback URLs

| Integration | Production URL/callback | Configured externally at | Configured in app |
|---|---|---|---|
| Google OAuth (Calendar) | `https://api.yourdomain.ca/api/google/callback` | Google Cloud → Credentials → Authorized redirect URIs | `GOOGLE_REDIRECT_URI` |
| Google OAuth (Gmail) | same path, separate client | Google Cloud (second OAuth client) | `GOOGLE_MAIL_CLIENT_ID/SECRET` |
| Google return to SPA | `https://yourdomain.ca/desk/account?...` | — | derived from `FRONTEND_URL` |
| Meta OAuth | `https://api.yourdomain.ca/api/meta/callback` | Meta app → Facebook Login → Valid OAuth Redirect URIs | `META_PUBLIC_URL` |
| Meta webhook | `https://api.yourdomain.ca/api/meta/webhook` | Meta app → Webhooks → leadgen | `META_PUBLIC_URL` + `META_WEBHOOK_VERIFY_TOKEN` |
| Campaign pixel / unsubscribe | `https://api.yourdomain.ca/api/campaigns/...` | — | `CAMPAIGN_PUBLIC_URL` |
| Twilio status callback | `https://api.yourdomain.ca/api/sms/twilio/status` | Twilio console | `TWILIO_PUBLIC_URL` |
| Frontend | `https://yourdomain.ca` | — | `FRONTEND_URL`, `CORS_ORIGINS`, `VITE_API_URL` (build-time) |
| API | `https://api.yourdomain.ca` | — | nginx `proxy_pass` → `127.0.0.1:8000` |

### Mismatches found in the current working `.env` — all must change

| Variable | Current value | Problem |
|---|---|---|
| `FRONTEND_URL` | `http://localhost:5173` | Dev value. **Boot refuses in production** |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Dev value. **Boot refuses** |
| `GOOGLE_REDIRECT_URI` | `http://localhost:8000/api/google/callback` | Dev value. Not boot-checked — OAuth fails at Google with `redirect_uri_mismatch` |
| `META_PUBLIC_URL` | `https://apply-scouts-flaring.ngrok-free.dev` | Ephemeral tunnel. **Boot refuses** (§0 BLOCKER 2) |
| `TWILIO_PUBLIC_URL` | `https://beans-betty-marker-contracting.trycloudflare.com` | Ephemeral tunnel. **Not boot-checked — fails silently** (§0 RISK 1) |
| `COOKIE_SECURE` | `false` | **Boot refuses** |
| `NODE_ENV` | `development` | Disables every guard above **and diverts mail** |
| `CAMPAIGN_PUBLIC_URL` | *(empty)* | Open tracking records nothing. Acceptable, but decide deliberately |

---

## 12. Google integration

1. **Google Cloud project** — one project, two OAuth clients (Calendar and Gmail may share one, but
   the code supports separate credentials; setting only one half of the mail pair **refuses the flow
   after consent**, which is the worst place to fail).
2. **OAuth consent screen** — published. `calendar.events` is a *sensitive* scope and
   `https://mail.google.com/` is a *restricted* scope; until the screen is verified, only listed test
   users can connect.
3. **Scopes** (from `server/src/google/google.constants.ts`):
   - Calendar: `openid`, `userinfo.email`, `https://www.googleapis.com/auth/calendar.events`
   - Gmail: `openid`, `userinfo.email`, `https://mail.google.com/`
4. **Authorized redirect URI:** `https://api.yourdomain.ca/api/google/callback` — must match
   `GOOGLE_REDIRECT_URI` **exactly**, including scheme and absence of a trailing slash.
5. **Authorized JavaScript origins:** not required — this is a server-side code flow, not an
   implicit browser flow.

### CRM vs Transaction Desk separation — do not break this

`google_connections.scope` is `'crm'` or `'desk'`. A connection made from CRM Settings is a CRM
connection and appears only there; the same is true for the Desk. **One Google account can be
connected on both sides independently.** This separation was introduced deliberately (it fixed a bug
where linking a CRM email account opened the Desk's integrations screen). Verify it survived:

```bash
psql "$DATABASE_URL" -c "SELECT scope, count(*) FROM google_connections GROUP BY scope;"
```

### Connection test

1. Sign in as a Super Admin → CRM → Settings → Integrations → Connect Google Calendar.
2. Consent screen appears on `accounts.google.com`, returns to `https://yourdomain.ca/...?connected`.
3. `psql -c "SELECT scope, google_email, calendar_id FROM google_connections;"` shows the row.
4. Create an appointment in the app → confirm it appears in Google Calendar within one sync cycle.
5. `pm2 logs crm-worker | grep -i google` — no repeated auth failures.

---

## 13. Meta / Facebook integration

**Boot validation applies only when `META_APP_ID` and `META_APP_SECRET` are both set.** If the
brokerage is not running Facebook lead ads, leave both unset and skip this section entirely.

| Item | Value | Where |
|---|---|---|
| App ID | numeric | Meta app dashboard → Settings → Basic |
| App secret | hex | same |
| OAuth redirect | `https://api.yourdomain.ca/api/meta/callback` | Facebook Login → Settings → Valid OAuth Redirect URIs |
| Webhook URL | `https://api.yourdomain.ca/api/meta/webhook` | Webhooks → leadgen → Callback URL |
| Verify token | your random string | Webhooks → Verify Token **and** `META_WEBHOOK_VERIFY_TOKEN` |
| Permissions | `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `business_management` | App Review |
| Graph version | `META_GRAPH_API_VERSION` | pin it; unpinned versions get deprecated |

**Current misconfiguration:** `META_PUBLIC_URL` is an ngrok tunnel (§0 BLOCKER 2). The webhook and
the OAuth redirect both derive from it, so **both are pointing at a hostname that no longer answers.**
Register the production API origin in the Meta app and set the variable to the same string.

**Webhook signature note:** `main.ts` enables `rawBody` because Meta's HMAC is computed over the
exact bytes. Do not add any middleware that re-serialises the body ahead of the webhook route.

### End-to-end verification

1. Meta app dashboard → Webhooks → **Verify and Save**. The handshake must succeed — if it fails,
   `META_WEBHOOK_VERIFY_TOKEN` does not match.
2. Connect a Page: CRM → Meta → Connect, complete OAuth, select the Page and form.
3. Use Meta's **Lead Ads Testing Tool** to submit a test lead.
4. `pm2 logs crm-worker --lines 100 | grep -i meta` — webhook received, no signature error.
5. `psql -c "SELECT id, name, email, source, created_at FROM leads ORDER BY id DESC LIMIT 5;"` — the
   test lead is present with the Meta source.
6. Confirm automation: the assigned agent receives the "Facebook lead received" notification, and —
   **if the welcome trigger has been switched on** — the lead receives the welcome email within 5
   minutes (§15).
7. `node scripts/verify-meta.cjs` — the repository's own end-to-end check.

---

## 14. Email and inbox

**SMTP and IMAP credentials live in the database**, not in the environment. They are added through
the UI, encrypted at rest with `APP_KEY`. This is why a wrong `APP_KEY` breaks mail silently.

### Separation — CRM and Transaction Desk

`mail_accounts.scope` is `'crm'` or `'desk'`. Accounts added under CRM Settings never appear on the
Desk side. The inbox filters by the account's scope, so the two never show each other's mail. CRM
automatic emails resolve their sender through `senderFor(userId, 'crm')` — **a Transaction Desk
mailbox can never send a CRM email.** Verify:

```bash
psql "$DATABASE_URL" -c "SELECT scope, user_id IS NULL AS brokerage, count(*)
                         FROM mail_accounts GROUP BY 1,2 ORDER BY 1;"
```

### Sender resolution

1. The acting agent's own **primary** CRM account (`is_default = true`, `scope = 'crm'`)
2. then any active CRM account of theirs
3. then the brokerage's shared CRM account
4. if none: **refused with a readable message**, never sent from an arbitrary mailbox

### Mail redirect — check this before going live (§0 RISK 2)

```bash
grep -E '^MAIL_REDIRECT_TO=' server/.env          # must be absent or empty
pm2 logs crm-worker --lines 200 | grep -i diverted # must return nothing
```

Outside production, mail is diverted to an RFC-2606 `.invalid` sink **by default**. In production
the only thing that diverts mail is `MAIL_REDIRECT_TO`, and it overrides everything.

### Ports and encryption

| Protocol | Port | Encryption |
|---|---|---|
| SMTP submission | 587 | STARTTLS (`tls`) |
| SMTP implicit | 465 | `ssl` |
| IMAP | 993 | implicit TLS (`ssl`) |

### Test procedures

| Test | Steps | Expected |
|---|---|---|
| Manual email | Lead → Communication → Send Email | Arrives; row in the lead's history with status `sent` |
| CRM automated email | §15 | Arrives, from the right sender, logged |
| Campaign email | Campaigns → create → send to a test audience | Arrives; opens recorded if `CAMPAIGN_PUBLIC_URL` is set |
| Inbox receive | Send mail to a connected IMAP account, wait one poll (60 s) | Appears in CRM Inbox; `pm2 logs crm-worker \| grep imap` |
| Inbox "Sync now" | Inbox → Sync now | Works even with `IMAP_POLL_DISABLED=1` |

---

## 15. CRM templates and automatic emails

CRM automatic emails resolve their subject and body from **CRM → Settings → Templates → CRM**
(`email_templates`, keyed by `event_key`, grouped by `module = 'CRM'`). A missing row **seeds itself
from the code registry on first send**, so an upgraded brokerage sends the same wording as before
and then has an editable row.

**This is a different system from Campaigns → Templates** (`campaign_templates`). Do not conflate
them. Campaign templates are a content library for bulk sends; CRM templates are the wording of
transactional emails.

### Currently registered CRM events

**Lead-facing** (sent to a client, through `CrmAdvancedEmailService.dispatch` — master switch,
per-user trigger, "must be a lead" rule, suppression/unsubscribe checks, `crm_email_log` entry):

| Event key | Template name | Trigger key | Default |
|---|---|---|---|
| `crm.lead_welcome` | New Lead Welcome Email | `welcome` | **off** |
| `crm.birthday_greeting` | Birthday Greeting | `birthday` | **off** |
| `crm.anniversary_greeting` | Anniversary Greeting | `anniversary` | **off** |
| `crm.seasonal_wishes` | Seasonal Wishes | `seasonal` | on |
| `crm.wedding_congratulations` | Wedding Congratulations | `wedding` | on (being retired) |

**Staff-facing** (sent to an agent, through `NotificationDispatcher` with the template as an email
override):

`crm.lead_new`, `crm.lead_assigned`, `crm.lead_task_due`, `crm.meta_lead_received`,
`crm.campaign_completed`, `crm.campaign_failed`.

```bash
psql "$DATABASE_URL" -c "SELECT event_key, name, is_active FROM email_templates
                         WHERE module='CRM' ORDER BY event_key;"
```

### Switching the welcome email on

It ships **off** so an upgrade does not start emailing arriving leads. To enable:
Triggers → CRM Triggers → *New Lead Welcome Email*. The sweep runs every 5 minutes and welcomes
leads created in the last 24 hours, once per email address, ever.

### Verification checklist

| Check | How |
|---|---|
| Edited template is what actually sends | Edit the subject, create a test lead, compare the received mail |
| Correct sender | Agent-owned lead → agent's CRM address; unowned lead → brokerage address |
| Disabled template prevents the send | Set `is_active=false`, create a lead, confirm nothing sends and the reason is logged |
| Missing template re-seeds | `DELETE FROM email_templates WHERE event_key='crm.birthday_greeting';` then trigger a send — the row returns with the shipped wording |
| Email log written | `SELECT kind, recipient, success, error FROM crm_email_log ORDER BY id DESC LIMIT 10;` |
| Lead history written | `SELECT * FROM lead_emails ORDER BY id DESC LIMIT 5;` |
| Unsubscribe honoured | Set a lead `unsubscribed=true`, confirm no send and a refusal row in `crm_email_log` |
| Suppression honoured | Add the address to `email_suppressions`, confirm refusal |
| Campaign templates untouched | `SELECT count(*) FROM campaign_templates;` — unrelated and unchanged |

### Outstanding — not a blocker for this deployment

The CRM greeting-preference migration has **not** had its production dry-run:

```bash
cd /var/www/crm/server
node scripts/migrate-crm-greeting-prefs.cjs        # DRY RUN by default; writes nothing
```

It reports what it would move from `crm_trigger_settings` into `notification_preferences`. On a
conflict it writes nothing at all and exits 2. Current live behaviour reads preferences from where
they are now, so **deployment is safe without this.** Do not run it with a write flag without the
development team's sign-off.

---

## 16. File uploads and storage

**Everything is on the local filesystem under `STORAGE_ROOT`.**

| Path | Contents |
|---|---|
| `$STORAGE_ROOT/` | uploaded documents, brand logo, user photos |
| `$STORAGE_ROOT/exports/` | generated exports (swept every 15 min) |
| `$RECORDING_STORAGE_DIR` | call recordings, if configured |

**Default is `<repo>/storage/app`** — i.e. *inside the deployment directory*. That is the single
most important thing to change:

> **RECOMMENDED BEFORE DEPLOYMENT.** Set `STORAGE_ROOT` to a path **outside** the application
> directory, e.g. `/var/lib/crm/storage`. Left at the default, any deployment strategy that replaces
> the checkout — a fresh `git clone`, a symlinked release directory, `rm -rf` and re-copy — **deletes
> every uploaded document in production.**

```bash
sudo mkdir -p /var/lib/crm/storage/exports
sudo chown -R crmapp:crmapp /var/lib/crm/storage
sudo chmod 750 /var/lib/crm/storage
# .env:
STORAGE_ROOT=/var/lib/crm/storage
```

The application **refuses to start** if `STORAGE_ROOT` does not exist, and logs the resolved path at
boot (`Files are stored in …`) so it is never guesswork. A *wrong* root is worse than a missing one:
writes succeed into the new place while every existing file appears to have vanished.

### Size limits — three layers, must be consistent

| Layer | Limit | Where |
|---|---|---|
| nginx | `client_max_body_size 25m` | §9 |
| Express body parser | 12 MB JSON / urlencoded | `main.ts` |
| Document upload interceptor | 20 MB per file | `documents.controller.ts` |
| Transaction import | 8 MB | `transaction-import.controller.ts` |

nginx must be the **largest**, or it rejects with a bare 413 before the application's readable
message is ever reached.

### Backup

Uploaded files are **not** in the database. `pg_dump` does not capture them. See §22.

---

## 17. Security checklist

| Check | Command / action | Expected |
|---|---|---|
| `APP_KEY` strong and carried forward | §0 BLOCKER 1 | decodes to 32 bytes |
| `SESSION_SECRET` strong | `grep SESSION_SECRET .env \| wc -c` | ≥ 32 chars, not `insecure-dev-secret` |
| Secure cookies | `COOKIE_SECURE=true` | boot enforces |
| Cookie domain | leading dot if cross-subdomain | boot enforces |
| CORS | `CORS_ORIGINS` = production origin only | boot enforces HTTPS, rejects localhost |
| CSRF | `curl -X POST https://yourdomain.ca/api/leads` without token | 403 |
| Global rate limit | 600 req/min/user (`RATE_LIMIT_PER_MINUTE`) | default is production-sane |
| Login throttling | 8 attempts / 15 min **per account**, 120 / 5 min per IP | `AUTH_ACCOUNT_LIMIT_MAX` |
| Password hashing | bcrypt cost 12 | `BCRYPT_ROUNDS` |
| **No test accounts** | `psql -c "SELECT email FROM users WHERE email LIKE '%@test.local';"` | **zero rows** |
| No default passwords | — | `TestPass123!` must not authenticate anywhere |
| No secrets in git | `git log -p --all -- server/.env \| head` | `.env` is gitignored; confirm no secret was ever committed |
| Registration restricted | attempt self-registration | no public sign-up route exists |
| PostgreSQL not public | `ss -tlnp \| grep 5432` | bound to `127.0.0.1` |
| Redis not public | `ss -tlnp \| grep 6379` | bound to `127.0.0.1`; `requirepass` set |
| Worker port not public | `ss -tlnp \| grep 8001` | localhost only |
| nginx headers | `curl -sI https://yourdomain.ca` | HSTS, nosniff, frame options |
| SMTP/IMAP secrets | stored encrypted with `APP_KEY` | never in `.env`, never in a response body |
| OAuth secrets | `.env` only, `chmod 600` | `ls -l server/.env` → `-rw-------` |
| Meta secrets | as above | — |
| Log redaction | `pm2 logs \| grep -i password` | nothing — the logger redacts anything matching secret-like names |

**Environment-dependent security:** every check in `validate-config.ts` runs **only when
`NODE_ENV=production`.** If that variable is wrong, none of the above is enforced *and* mail is
diverted to a sink. It is the single highest-leverage value in the file.

---

## 18. Logging

| Source | Command |
|---|---|
| Application (both apps) | `pm2 logs` |
| Web only | `pm2 logs crm-web --lines 200` |
| Worker / all schedulers | `pm2 logs crm-worker --lines 200` |
| PM2 log files | `ls -la ~/.pm2/logs/` |
| nginx access | `sudo tail -f /var/log/nginx/access.log` |
| nginx error | `sudo tail -f /var/log/nginx/error.log` |
| Scheduler errors | `pm2 logs crm-worker \| grep -iE "failed\|error\|warn"` |
| Email failures | `psql -c "SELECT * FROM crm_email_log WHERE success=false ORDER BY id DESC LIMIT 20;"` |
| Meta webhook failures | `pm2 logs crm-worker \| grep -i meta` |
| Google sync failures | `pm2 logs crm-worker \| grep -i google` |
| Database errors | `sudo tail -f /var/log/postgresql/postgresql-16-main.log` |
| Redis | `sudo journalctl -u redis-server -f` |
| Worker health (JSON) | `curl -s localhost:8001/api/health/workers \| jq` |
| Metrics | `curl -s localhost:8000/api/health/metrics \| jq` |

Logs are **JSON in production** (`LOG_FORMAT` defaults to json when `NODE_ENV=production`), so
`| jq` works. Anything whose field name suggests a secret (password, token, cookie, api-key,
client-secret, refresh) is replaced before it is printed.

### Log rotation — required

PM2 does not rotate by default. Without this, `~/.pm2/logs` fills the disk and the application stops.

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

nginx rotation is handled by the distribution's `/etc/logrotate.d/nginx`. Confirm it exists.

---

## 19. Deployment sequence

Each step: **action → expected → verify → on failure.**

| # | Step | Command | Expected | Verify | If it fails |
|---|---|---|---|---|---|
| 1 | Server access | `ssh user@host` | shell | `sudo -n true` | Stop |
| 2 | DNS | `dig +short yourdomain.ca` | server IP | also the API host | Wait for propagation |
| 3 | Prerequisites | install Node 22, PostgreSQL 16, nginx, certbot, PM2 | versions print | §2 rows 4–13 | Fix before continuing |
| 4 | App directory | `sudo mkdir -p /var/www/crm && sudo chown $USER /var/www/crm` | exists | `ls -ld` | Permissions |
| 5 | **Storage directory outside the app** | `sudo mkdir -p /var/lib/crm/storage/exports` | exists | `ls -ld` | §16 |
| 6 | Get the code | `git clone <repo> /var/www/crm && git checkout <tag>` | working tree | `git rev-parse HEAD` — **record this** | — |
| 7 | Write `.env` | from §3; `chmod 600 server/.env` | file exists | `grep -c '^' server/.env` | — |
| 8 | Verify secrets | §0 BLOCKER 1, §17 | `APP_KEY` = 32 bytes | no dev URLs remain | **Stop** |
| 9 | PostgreSQL config | §4 Step 1 | `max_connections` ≥ 200 | `SHOW max_connections` | Restart required |
| 10 | **Backup** | §4 Step 2 | valid dump | `pg_restore --list` | **Stop** |
| 11 | Migration status | `npx prisma migrate status` | known state | `migration-preflight.cjs` | Investigate drift |
| 12 | Apply migrations | `npx prisma migrate deploy` | "applied" | re-run status | Restore from step 10 |
| 13 | Verify indexes | §4 Step 5 | no invalid indexes | `pg_index WHERE NOT indisvalid` | Rebuild by hand |
| 14 | Redis | §5 | `PONG` | `node scripts/verify-redis.cjs` | Continue without it, or fix |
| 15 | Backend deps + build | `npm ci && npx prisma generate && npm run build` | `dist/main.js present` | `ls dist/main.js` | Read the build error |
| 16 | Frontend build | `VITE_API_URL=… npm run build` | `client/dist/` | `grep -ro api.yourdomain.ca dist/assets` | Rebuild with the right URL |
| 17 | PM2 start | `set -a && . ./.env && set +a && pm2 start ecosystem.config.cjs` | 5 processes online | `pm2 status` | §0 RISK 3 |
| 18 | Scheduler ownership | §8 | web `false`, worker `true` | `pm2 env <id> \| grep RUN_SCHEDULERS` | **Stop** — duplicate email risk |
| 19 | Local API check | `curl -s localhost:8000/api/health` | `{"status":"ok"}` | also `/api/health/ready` | `pm2 logs crm-web` |
| 20 | nginx | §9, `nginx -t && systemctl reload nginx` | `syntax is ok` | `curl -sI http://yourdomain.ca` | Read `nginx -t` |
| 21 | SSL | §10 | certificate issued | `curl -sI https://…` → 200 | Check DNS + port 80 |
| 22 | Google callbacks | §12 | consent completes | row in `google_connections` | `redirect_uri_mismatch` = exact-string problem |
| 23 | Meta webhook | §13 | handshake verified | test lead arrives | Check verify token |
| 24 | Email | §14 | test send arrives | `crm_email_log` | Check `MAIL_REDIRECT_TO` |
| 25 | Smoke test | §20 | all pass | — | Triage before opening up |
| 26 | Logs | §18 | no repeated errors | `pm2 logs --lines 200` | Investigate |
| 27 | `pm2 save` | `pm2 save` | list saved | `~/.pm2/dump.pm2` | — |
| 28 | Reboot persistence | `pm2 startup systemd` → run printed cmd → `sudo reboot` | processes return | `pm2 status` | Re-run startup |
| 29 | Final acceptance | §25 sign-off | all ticked | — | — |

---

## 20. Production smoke test

### Authentication
- [ ] Login with a real production account
- [ ] Logout, confirm the session is gone
- [ ] Session persists across a `pm2 reload crm-web` (sessions are in PostgreSQL — nobody should be signed out)
- [ ] Agent sees only their own leads; Super Admin sees all
- [ ] Two-step verification: CRM → Settings → Two-Step Verification loads for an agent
- [ ] Wrong password 8 times locks the account for 15 minutes

### CRM
- [ ] Dashboard loads, figures are non-zero and plausible
- [ ] Leads list loads and pages
- [ ] Create a lead; update it; assign it to an agent
- [ ] Search and filter
- [ ] Import a small CSV
- [ ] Calendar renders; create an appointment
- [ ] Inbox loads; "Sync now" works
- [ ] Campaigns list; create a draft
- [ ] Meta screen loads (connected or not)
- [ ] Triggers → CRM Triggers loads and saves
- [ ] CRM Settings loads
- [ ] Settings → Templates → CRM lists the 11 CRM templates
- [ ] Audit Trail loads and filters

### Automatic functionality
- [ ] CRM automated template email — create a lead with the welcome trigger on, confirm within 5 min
- [ ] Follow-up/task reminder — create a task due today, confirm within 30 min
- [ ] Meta lead — §13 end-to-end
- [ ] Scheduled campaign — schedule one a few minutes out, confirm it sends
- [ ] Calendar sync — create an appointment, confirm it reaches Google
- [ ] Email sync — send mail to a connected account, confirm it appears
- [ ] Lead retention — **only if `LEAD_RETENTION_DAYS` is set.** This permanently deletes. Test on a
      throwaway lead or not at all

### Transaction Desk — confirm not broken, change nothing
- [ ] Transactions list loads
- [ ] Open a deal; documents list
- [ ] Invoices list
- [ ] Reports run
- [ ] Desk Settings → Templates still shows Desk modules and **no** CRM rows

---

## 21. Performance verification

| Check | Command | Warning threshold |
|---|---|---|
| PostgreSQL connections | `psql -c "SELECT count(*) FROM pg_stat_activity;"` | > 150 of 200 |
| Connections by app | `psql -c "SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1;"` | any single app > 25 |
| Prisma pool applied | `pm2 env 0 \| grep connection_limit` | must be present |
| Redis | `redis-cli -a "$PASS" INFO stats \| grep keyspace` | rising hits |
| CPU | `top -bn1 \| head -5` | sustained > 80% |
| RAM | `free -h` | < 15% free |
| Disk | `df -h /var` | > 80% used |
| Storage growth | `du -sh $STORAGE_ROOT` | track weekly |
| API response | `curl -w '%{time_total}\n' -so /dev/null https://yourdomain.ca/api/health` | > 0.5 s |
| Leads list | time the request with a real session | > 2 s |
| Dashboard | same | > 3 s (Redis cache makes repeat loads ~20 ms) |
| Login concurrency | `node scripts/measure-login-throughput.cjs` | < 15 logins/s across 4 processes |
| Agent endpoints | `node scripts/measure-agent-endpoints.cjs` | regressions vs. the recorded baseline |
| Load sweep | `node scripts/load-test.cjs` | see `docs/PERFORMANCE-AUDIT.md` |
| PM2 health | `pm2 status` | any restart count > 0 |
| nginx | `curl -w '%{time_total}\n' -so /dev/null https://yourdomain.ca` | > 1 s |

> **Not yet done:** the 500-user load sweep and soak test have never been run against production
> hardware. `docs/PERFORMANCE-AUDIT.md` has the procedure. Treat the numbers above as thresholds to
> watch, not as measurements from this environment.

---

## 22. Backup and recovery

### Database
```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
        --file=/var/backups/crm/db-$(date +%F-%H%M).dump
pg_restore --list /var/backups/crm/db-*.dump | head          # verify
```
Nightly via cron, plus `npm --prefix server run backup` (cross-platform, used by
`docs/DISASTER-RECOVERY.md`) and `backup:verify`.

### Uploaded files — **not in the database dump**
```bash
tar czf /var/backups/crm/storage-$(date +%F).tar.gz -C /var/lib/crm storage
```

### Configuration
```bash
cp /var/www/crm/server/.env /root/secure/env-$(date +%F).bak && chmod 600 /root/secure/env-*.bak
sudo cp /etc/nginx/sites-available/crm /var/backups/crm/nginx-$(date +%F).conf
pm2 save && cp ~/.pm2/dump.pm2 /var/backups/crm/pm2-$(date +%F).json
```

`.env` holds `APP_KEY`. **A database backup without the matching `APP_KEY` is only partly
restorable** — the rows survive, but every encrypted credential in them is unreadable. Store it
separately and securely, not beside the dumps.

### Restore test — do this before you need it
```bash
createdb crm_restore_test
pg_restore --dbname=crm_restore_test --no-owner /var/backups/crm/db-latest.dump
psql crm_restore_test -c "SELECT count(*) FROM users;"
psql crm_restore_test -c "SELECT count(*) FROM leads;"
dropdb crm_restore_test
```

### Retention
Keep 14 daily, 8 weekly, 12 monthly. `BACKUP_KEEP` governs the repo's own script.

---

## 23. Rollback plan

**Record before you start:** `git rev-parse HEAD`, the backup filename, and `pm2 save` output.

| Layer | Rollback |
|---|---|
| Application code | `git checkout <previous-tag> && npm ci && npm run build && pm2 reload crm-web && pm2 restart crm-worker` |
| Frontend | rebuild from the previous tag with the same `VITE_API_URL` |
| PM2 | `pm2 resurrect` from the saved dump, or `pm2 delete all && pm2 start ecosystem.config.cjs` |
| nginx | restore the backed-up site file, `nginx -t && systemctl reload nginx` |
| Environment | restore `.env` from `/root/secure/` |
| Database | **see below** |

### Database rollback — read carefully

**Prisma migrations in this repository have no `down` scripts. There is no automatic reverse.**

The only reliable rollback is a restore from the pre-deployment dump (§4 Step 2), which **loses
every change made since the backup**. In practice:

1. Stop the application: `pm2 stop all`
2. `dropdb crm_production && createdb crm_production`
3. `pg_restore --dbname=crm_production --no-owner /var/backups/crm/pre-deploy-<stamp>.dump`
4. Deploy the previous code tag
5. `pm2 start ecosystem.config.cjs`

**Migrations that cannot be safely reversed automatically:**

| Migration | Why |
|---|---|
| `20260808150000_tenant_removal_drop_company_id` | **Drops a column.** The data is gone; only a restore recovers it |
| `20260808140000_tenant_removal_replacement_constraints` | Additive — *is* safely reversible by dropping the new indexes |
| Any migration adding a `NOT NULL` column with a backfill | The backfilled values are not recoverable |

Because of the column drop, **rolling back across the tenant-removal migrations requires a restore.**
Plan the maintenance window accordingly, and consider a short read-only period so the gap between
backup and cutover is minimal.

---

## 24. Post-deployment monitoring

### First 15 minutes
```bash
pm2 status                                       # 5 online, 0 restarts
pm2 logs --lines 100 | grep -iE "error|fatal"    # nothing repeating
curl -s https://yourdomain.ca/api/health | jq
sudo tail -50 /var/log/nginx/error.log
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity;"
```
Watch for: boot loops, `DATABASE_URL is not set`, mail-diverted warnings, connection exhaustion.

### First hour
```bash
curl -s localhost:8001/api/health/workers | jq   # every scheduler reporting
pm2 logs crm-worker --lines 300 | grep -i "sweep\|welcome\|greeting"
psql -c "SELECT kind, success, count(*) FROM crm_email_log
         WHERE created_at > now() - interval '1 hour' GROUP BY 1,2;"
pm2 logs crm-web --lines 300 | grep -c "not scheduled"   # proves web is NOT scheduling
sudo grep -c ' 5[0-9][0-9] ' /var/log/nginx/access.log
free -h && df -h /var
```
Watch for: **scheduler duplication** (the same sweep logged by more than one process), failed
emails, Meta webhook rejections, Google auth failures, Redis errors.

### First day
```bash
psql -c "SELECT count(*) FROM leads WHERE created_at > now() - interval '1 day';"
psql -c "SELECT success, count(*) FROM crm_email_log
         WHERE created_at > now() - interval '1 day' GROUP BY 1;"
psql -c "SELECT count(*) FROM user_sessions;"
pm2 status                                        # restart counts still 0
node scripts/monitor.mjs                          # the repo's own health summary
```
Confirm the nightly backup ran and is valid. Confirm log rotation is active. Confirm no duplicate
client emails were sent — the single most important signal that scheduler ownership is correct.

---

## 25. Final handover sign-off

| Item | Required | Verified | Result/Notes |
|---|---|---|---|
| `APP_KEY` carried forward, 32 bytes | **Yes** | ☐ | §0 BLOCKER 1 |
| Production environment variables complete | Yes | ☐ | §3 — not `.env.example` |
| No development/tunnel URLs remain | **Yes** | ☐ | §11 — 8 values must change |
| `MAIL_REDIRECT_TO` empty | **Yes** | ☐ | §0 RISK 2 |
| `STORAGE_ROOT` outside the app directory | **Yes** | ☐ | §16 |
| Database backup taken and verified | Yes | ☐ | §4 Step 2 |
| Migrations applied | Yes | ☐ | `prisma migrate deploy` |
| Database indexes verified | Yes | ☐ | no invalid indexes |
| PostgreSQL capacity verified | Yes | ☐ | `max_connections` ≥ 200 |
| Redis working and **verified** | No (optional) | ☐ | `verify-redis.cjs` |
| PM2 web processes healthy | Yes | ☐ | 4 online |
| Worker healthy | Yes | ☐ | 1 online |
| Scheduler ownership verified | **Yes** | ☐ | §8 — web `false`, worker `true` |
| nginx working | Yes | ☐ | §9 |
| SSL working + auto-renewal | Yes | ☐ | §10 |
| Google OAuth working | If used | ☐ | §12 |
| CRM/Desk Google separation intact | Yes | ☐ | §12 |
| Meta webhook working | If used | ☐ | §13 |
| SMTP/IMAP working | Yes | ☐ | §14 |
| CRM/Desk mail separation intact | Yes | ☐ | §14 |
| CRM automated emails working | Yes | ☐ | §15 |
| Campaign emails working | Yes | ☐ | §14 |
| File uploads working and persistent | Yes | ☐ | §16 |
| No `@test.local` accounts | **Yes** | ☐ | §17 |
| Logs checked, rotation configured | Yes | ☐ | §18 |
| Smoke test passed | Yes | ☐ | §20 |
| Reboot persistence verified | Yes | ☐ | §7 |
| Backup + restore test done | Yes | ☐ | §22 |
| Rollback plan understood | Yes | ☐ | §23 — no automatic down-migrations |

---

**Signed off by:** ____________________  **Date:** ____________

**Deployed commit:** ____________________  **Backup file:** ____________________
