# VPS Deployment

How to host Transaction Desk on a Linux VPS, from a bare server to a working HTTPS site.

Written for a first deployment onto a fresh machine. It assumes you can use `ssh` and `sudo`, and
that you have a domain pointed at the server. It does not assume you have seen this codebase.

Related:
[`OPERATIONS.md`](OPERATIONS.md) (running it day to day) ·
[`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) (backup and restore) ·
[`MLS_AND_ENV.md`](MLS_AND_ENV.md) (feed configuration) ·
[`UAT.md`](UAT.md) (acceptance testing)

> **The existing operations docs are written for the Windows machine this app runs on today.**
> Their scheduled-task scripts (`*.ps1`) do not run on Linux. This document gives the systemd and
> cron equivalents. The Node scripts themselves (`backup.mjs`, `restore.mjs`, `monitor.mjs`) are
> cross-platform and are used unchanged.

---

## 1. The stack

Verified against the working tree on 2026-08-01 — installed versions, not just what the manifests
ask for. Server builds, client builds, and the full test suite (44 suites, 554 tests) passes.

### Application

| Layer | Technology | Version |
|---|---|---|
| Frontend | React + TypeScript SPA, built by Vite | React **19.2.7**, Vite **7.3.5** |
| Routing | React Router | 7.18.2 |
| HTTP client | Axios | 1.7.9 |
| Backend | **NestJS** on Express | **10.4.22** |
| ORM | **Prisma** | 6.19.3 |
| Database | **PostgreSQL** | 14+ (16 recommended) |
| Runtime | **Node.js** | `>=20.19` required; **22 LTS recommended** |
| Language | TypeScript | 5.9.3 (both halves) |

### Notable runtime dependencies

| Concern | Package |
|---|---|
| Sessions | `express-session` + `connect-pg-simple` (stored in Postgres, table `user_sessions`) |
| Passwords | `bcryptjs`, cost 12 |
| Security headers | `helmet` |
| Rate limiting | `@nestjs/throttler`, keyed by signed-in user |
| Validation | `class-validator` / `class-transformer` |
| Email | `nodemailer` (send), `imapflow` + `mailparser` (inbound mirror) |
| Documents | `pdfmake`, `exceljs`, `archiver` |
| Telephony | Twilio Voice SDK (client), Twilio REST (SMS) |
| Push | `web-push` (VAPID) |
| Calendar | `node-ical` |

### History — there is no PHP left

This project began as **Laravel 12 + MySQL with a React SPA**. It was migrated to the current stack
on 2026-07-20 (commit `cb09150`), which deleted the entire PHP application — `app/`, `bootstrap/`,
`config/`, `database/`, `routes/`, `resources/`, `public/`, `vendor/`, `artisan`, `composer.*`.
**Zero PHP files are tracked in git.** You do not need PHP, Composer, Apache or MySQL on the VPS.

Three things survive the migration and will confuse you if nobody says so:

1. **`storage/` is still live and must be preserved.** It is the uploaded-file store — documents,
   FINTRAC identification, the brand logo, user photos, exports, recycle bin — and the NestJS
   backend reads and writes it. The Laravel directory layout was kept deliberately.
2. **`storage/framework/` and `storage/logs/laravel.log` are dead** — compiled Blade caches and a
   37 MB PHP log, untracked leftovers. Do not copy them to the VPS.
3. **`server/src/common/laravel-*.ts` is intentional TypeScript.** It reproduces Laravel's
   encryption format and its `422 {message, errors}` validation shape so existing encrypted
   credentials still decrypt and the SPA's error handling still works. Leave it alone.

Also stale and **not to be used on the VPS**: `start-app.ps1`, `serve-dev.ps1` (both still invoke
`php artisan serve`), the root `README.md` (stock Laravel), and `DOCUMENTATION.md` (describes the
old MySQL/Sanctum architecture).

---

## 2. Architecture on the server

**Single origin.** The SPA and the API answer on one host: the built client at `/`, the API proxied
at `/api`. Nginx terminates TLS; Node listens on localhost only.

```
                    ┌──────────────────────────────────────────┐
   Browser ──443──► │ nginx                                     │
                    │   /       → /srv/transaction-desk/client  │  static, built SPA
                    │   /api/   → 127.0.0.1:8000                │  reverse proxy
                    │   /sanctum/csrf-cookie → 127.0.0.1:8000   │  ← not under /api
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │ node (systemd)  transaction-desk.service  │
                    │   NestJS 10, listening 127.0.0.1:8000     │
                    └──────┬─────────────────────────┬─────────┘
                           │                         │
                  ┌────────▼────────┐      ┌─────────▼──────────────┐
                  │ PostgreSQL      │      │ STORAGE_ROOT           │
                  │ (local socket)  │      │ /srv/…/storage/app     │
                  └─────────────────┘      └────────────────────────┘
```

**Why single origin and not `api.example.com`** — two reasons, both from `server/.env.example`:

1. The OAuth redirect URIs and webhooks already registered with Google, Meta and Twilio point at
   `https://<host>/api/...`. Splitting the API means re-registering every one, and any you miss
   breaks only in production, only for that integration.
2. The session cookie becomes same-site by construction. No `COOKIE_DOMAIN`, no `SameSite=None`, no
   cross-site CORS — which removes the entire class of fault that shows up as *"login succeeds then
   bounces straight back."*

### Sizing

| | Minimum | Comfortable |
|---|---|---|
| vCPU | 2 | 4 |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB+ SSD |

Disk is the one to watch. The inbound mail mirror (`inbound_emails`) was **77 MB of an 80 MB
database and had doubled within a week** — it grows with mail volume, not with brokerage activity,
and backups multiply it. See *Retention* in `OPERATIONS.md` before assuming a number.

**One application instance only.** Uploads go to local disk and the background schedulers are
in-process timers, so this does not scale out horizontally without shared storage. See §9.

---

## 3. Prepare the server

Ubuntu 22.04 / 24.04 LTS shown. Adjust package names for other distributions.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx postgresql postgresql-contrib ufw
```

**Node 22 LTS** (the distro package is usually too old — `engines` requires `>=20.19`):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # expect v22.x
```

**Timezone.** Set it on the host as well as in the service — see §6 for why this is not cosmetic.

```bash
sudo timedatectl set-timezone America/Toronto
```

**Service account and directories.** A dedicated unprivileged user; never run this as root.

```bash
sudo adduser --system --group --home /srv/transaction-desk transdesk
sudo mkdir -p /srv/transaction-desk/storage/app
sudo chown -R transdesk:transdesk /srv/transaction-desk
```

**Firewall.** Postgres and Node stay closed to the world; only SSH and HTTPS are open.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 4. PostgreSQL

```bash
sudo -u postgres psql
```

```sql
CREATE USER transdesk WITH PASSWORD 'use-a-long-generated-password';
CREATE DATABASE myapp OWNER transdesk;
\q
```

Confirm it works before going further — a connection problem found now is five minutes, found at
first boot it looks like an application fault:

```bash
psql "postgresql://transdesk:PASSWORD@127.0.0.1:5432/myapp" -c 'select version();'
```

You do **not** need to create the `user_sessions` table. `connect-pg-simple` is configured with
`createTableIfMissing: true` and creates it on first boot.

---

## 5. Get the code and install

```bash
sudo -u transdesk -H bash
cd /srv/transaction-desk
git clone <your-repo-url> app
cd app/server
npm ci
```

Do **not** copy `node_modules` from the Windows machine — several dependencies compile native
binaries per platform.

---

## 6. Configure the API

Create `/srv/transaction-desk/app/server/.env`. Every value below is either required in production
or guarded by the startup check in [`validate-config.ts`](../server/src/config/validate-config.ts).

```ini
NODE_ENV=production
PORT=8000
TZ=America/Toronto

DATABASE_URL="postgresql://transdesk:PASSWORD@127.0.0.1:5432/myapp?schema=public"

# Carry the EXISTING key forward from the current deployment — see the warning below.
APP_KEY=base64:<the key already in use>

# openssl rand -base64 48
SESSION_SECRET=<long random string>
SESSION_COOKIE_NAME=laravel_session
SESSION_LIFETIME_MINUTES=120

COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=

FRONTEND_URL=https://your-domain.ca
CORS_ORIGINS=https://your-domain.ca

# Absolute. Must already exist — production will not create it.
STORAGE_ROOT=/srv/transaction-desk/storage/app

BCRYPT_ROUNDS=12
RUN_SCHEDULERS=true
```

```bash
chmod 600 /srv/transaction-desk/app/server/.env
```

Then add whichever integrations you use — Twilio, Meta, Google Calendar, Anthropic ID extraction,
VAPID web push, campaign tracking. Every one is documented inline in
[`server/.env.example`](../server/.env.example); copy the blocks you need. All are optional and each
degrades gracefully when blank.

For anything with a public callback, the value is your real HTTPS origin:

```ini
CAMPAIGN_PUBLIC_URL=https://your-domain.ca
TWILIO_PUBLIC_URL=https://your-domain.ca
META_PUBLIC_URL=https://your-domain.ca
GOOGLE_PUBLIC_URL=https://your-domain.ca
```

### The four settings that cause silent damage

**`APP_KEY` — carry the existing one forward.** It decrypts the IMAP passwords and Google refresh
tokens already in the database. A new key does not error; it makes every stored credential
undecryptable, and every mail and calendar integration must be reconnected by hand. A *blank* key
silently becomes an all-zero key, which works fine until the day somebody sets a real one. Only
generate a new key (`openssl rand -base64 32`) for a genuinely empty database.

**`TZ` — required, and set it in two places.** Parts of the application build calendar dates from
the server's *local* clock: Inventory's "today", all-day calendar events, Meta's week-start figure.
A Linux host defaults to UTC, where 10:30pm in Toronto is already tomorrow — so anything entered in
the evening is recorded a day late. The server refuses to start in production without it. Set it in
`.env` **and** in the systemd unit (§7), so the process genuinely starts in that zone rather than
having it applied after boot.

**`STORAGE_ROOT` — absolute, and pointing at the directory that already holds the files.** Left
blank it resolves to `<cwd>/../storage/app`, which silently moves if the working directory changes.
Production deliberately **refuses to start** if the directory is missing rather than creating an
empty one — because a wrong-but-writable path is worse than a missing one: uploads succeed into the
new place while every existing document appears to have vanished.

**`CORS_ORIGINS` / `FRONTEND_URL` — https, no trailing slash.** Browsers send the origin without a
trailing slash, so `https://your-domain.ca/` never matches anything. `FRONTEND_URL` additionally
builds the links inside notification emails and the OAuth returns, so a leftover localhost value
sends recipients to their own machine. Both are checked at boot.

The server prints **every** configuration problem at once and exits. A deploy that stops here is the
cheap outcome — fix what it names, do not disable the check.

---

## 7. Build and run the API

```bash
cd /srv/transaction-desk/app/server
npm run prisma:generate
npm run prisma:status     # read-only: what is pending
npm run prisma:deploy     # apply — forward-only, cannot reset
npm run build
```

> **Never run `prisma migrate dev` against this database.** It resets when it finds drift, and a
> production database picks up drift easily — a hand-applied fix, a restored backup.
> `npm run prisma:migrate` is guarded and refuses non-local databases, but the habit is the real
> safeguard.

### systemd unit

`/etc/systemd/system/transaction-desk.service`:

```ini
[Unit]
Description=Transaction Desk API (NestJS)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=transdesk
Group=transdesk

# Must be the server/ directory: @nestjs/config reads .env relative to the
# working directory, and there is no envFilePath override in app.module.ts.
WorkingDirectory=/srv/transaction-desk/app/server

Environment=NODE_ENV=production
Environment=TZ=America/Toronto

ExecStart=/usr/bin/node --enable-source-maps dist/main.js

Restart=always
RestartSec=5

# Give in-flight requests time to finish; the app installs shutdown handlers that
# close IMAP sockets and disconnect Prisma rather than being killed mid-request.
KillSignal=SIGTERM
TimeoutStopSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=transaction-desk

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/srv/transaction-desk/storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now transaction-desk
sudo systemctl status transaction-desk
sudo journalctl -u transaction-desk -f
```

On a healthy boot the log names the resolved storage path (`Files are stored in …`), maps every
route, and ends with `Transaction Desk API listening on http://localhost:8000`. **Read the storage
line** — it is printed unconditionally precisely so the location is never guesswork.

---

## 8. Build and serve the SPA

```bash
cd /srv/transaction-desk/app/client
npm ci
npm run build          # runs typecheck, then vite build → client/dist
```

`client/.env.production` is committed and sets `VITE_API_URL=` **empty on purpose**. Do not "fix"
it. An empty base makes every request relative, so the bundle carries no hostname, the same artifact
works on any domain, and the worst deployment failure this app has — a live site quietly calling
`http://localhost:8000` — becomes impossible rather than merely unlikely. Set it only if you ever
move the API to a different origin, and then it is scheme + host with no trailing slash.

### nginx

`/etc/nginx/sites-available/transaction-desk`:

```nginx
server {
    listen 80;
    server_name your-domain.ca;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.ca;

    ssl_certificate     /etc/letsencrypt/live/your-domain.ca/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.ca/privkey.pem;

    root /srv/transaction-desk/app/client/dist;
    index index.html;

    # The API accepts a 12 MB JSON body: documents and campaign attachments arrive
    # base64-encoded, so a 5 MB file is ~6.7 MB on the wire. Below this, nginx answers
    # 413 and the size limits enforced in application code are never reached.
    client_max_body_size 20m;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # The app sets `trust proxy 1`. Without these the real client address is lost:
        # every request looks like it came from nginx, and rate limiting degrades into
        # one shared bucket for the whole site.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Report generation and bulk exports run long.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # Served at the root, deliberately outside the /api prefix.
    location = /sanctum/csrf-cookie {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SPA history fallback — must come last.
    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|woff2?|png|jpe?g|svg|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/transaction-desk /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**TLS:**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.ca
```

Certbot installs a renewal timer automatically. Confirm it: `systemctl list-timers | grep certbot`.

> **`trust proxy` is set to `1` — exactly one hop.** That is correct for nginx directly in front. If
> you later put Cloudflare or another proxy ahead of nginx there are two hops, and the address the
> app derives will be wrong, which quietly breaks per-IP rate limiting. Handle it at that point;
> do not add layers without revisiting this.

---

## 9. Do not run two instances

`RUN_SCHEDULERS` defaults to true and the background workers — the IMAP poller, the Meta sync, the
export sweeper, the lawyer-detail reminders — are **in-process timers, not distributed jobs**. Every
process that runs them runs them. Two instances means two IMAP syncs racing on one mailbox and two
copies of every reminder email reaching a real client.

This deployment cannot meaningfully scale out anyway, because uploads are written to local disk. If
you ever add a second process (pm2 cluster, another container), start it with `RUN_SCHEDULERS=false`
and keep exactly one owner. A non-owner still serves every route normally.

---

## 10. First-run verification

Health endpoints, and what each actually answers — asking the wrong one is how an outage gets
reported as healthy:

```bash
curl -s https://your-domain.ca/api/health          # process alive; touches nothing
curl -s https://your-domain.ca/api/health/ready    # real DB round trip + storage write + permission tables
curl -s https://your-domain.ca/api/health/metrics  # throughput, p95, error rate
curl -s https://your-domain.ca/api/health/workers  # timers, export queue, per-mailbox sync age
```

**Point any uptime monitor or load balancer at `/ready`, not `/health`.** A process that cannot
reach its database is alive and useless.

Then check by hand:

- [ ] `/api/health/ready` passes every check.
- [ ] The site loads over HTTPS and the browser shows no mixed-content warnings.
- [ ] Sign in. Then **reload the page** — if you are signed out, the session cookie is being
      rejected; re-read `COOKIE_SECURE` / `CORS_ORIGINS` in §6.
- [ ] Sign in **as an agent too**, not only as an administrator. Most authorization mistakes are
      invisible to an administrator, who can see everything anyway.
- [ ] Open a transaction that has documents and download one — this proves `STORAGE_ROOT` resolves
      to the real files, which nothing else tests.
- [ ] Upload a document, then confirm the file appears under `STORAGE_ROOT`.
- [ ] Restart the service (`systemctl restart transaction-desk`) and confirm you are **still signed
      in** — sessions live in Postgres and must survive it.
- [ ] Create a calendar event in the evening and confirm the date is right — this is the `TZ` check.

---

## 11. Migrating data from the existing Windows machine

Both halves move together. Restore only the database and every document row resolves to a file that
is not there — the API answers, the list renders, and every download 404s.

**On the current machine:**

```powershell
cd server
npm run backup
npm run backup:verify
```

That writes a set to `../backups/YYYYMMDD-HHMMSS/` containing `database.dump`, the `storage/` tree,
and a `manifest.json` recording the SHA-256 and **which migration the schema was at**.

**Copy it to the VPS**, then:

```bash
# 1. Database
pg_restore --no-owner --no-privileges \
  -d "postgresql://transdesk:PASSWORD@127.0.0.1:5432/myapp" database.dump

# 2. Files — into the directory STORAGE_ROOT points at
rsync -a storage/app/ /srv/transaction-desk/storage/app/
sudo chown -R transdesk:transdesk /srv/transaction-desk/storage

# 3. Bring the schema level with the code
cd /srv/transaction-desk/app/server && npm run prisma:deploy
```

Carry the **same `APP_KEY`** across, or the migrated IMAP passwords and Google tokens are lost.

Do not copy: `node_modules/`, `storage/framework/`, `storage/logs/laravel.log`, `run.err.log`
(stale, references an old `C:\xampp\htdocs\myapp` path), or the `.ps1` launchers.

Full procedure and restore verification: [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md).

---

## 12. Backups on Linux

`backup.mjs` and `restore.mjs` are cross-platform and find `pg_dump` at `/usr/bin/pg_dump`
automatically. Only the Windows *scheduling* wrappers (`backup-nightly.ps1`, `schedule-backup.ps1`)
do not apply — use cron:

```bash
sudo -u transdesk crontab -e
```

```cron
# Nightly backup at 01:30, keeping 30 sets
30 1 * * * cd /srv/transaction-desk/app/server && /usr/bin/npm run backup -- --out /srv/backups --keep 30 >> /srv/backups/backup.log 2>&1

# Weekly restore-verify, Sunday 03:00. A backup nobody has restored is a hope.
0 3 * * 0 cd /srv/transaction-desk/app/server && /usr/bin/npm run backup:verify >> /srv/backups/verify.log 2>&1
```

```bash
sudo mkdir -p /srv/backups && sudo chown transdesk:transdesk /srv/backups
```

**Get the sets off the machine.** A backup on the same disk as the database survives a mistake, not
a fire. Add object-storage sync or an off-site rsync — this is not optional, and nothing in the
application does it for you.

---

## 13. Monitoring on Linux

`server/scripts/monitor.mjs` runs ten checks and alerts on state change. On Linux, replace
`schedule-monitor.ps1` with cron, and override the two Windows defaults:

```cron
*/5 * * * * cd /srv/transaction-desk/app/server && /usr/bin/node scripts/monitor.mjs --url http://127.0.0.1:8000 --backup /srv/backups >> /srv/backups/monitor.log 2>&1
```

> **`monitor.mjs` does not read `server/.env`.** `ALERT_*` settings placed there are silently
> ignored — an easy afternoon to lose. They must be real environment variables. Put them in the
> crontab environment or a wrapper script.

```ini
ALERT_WEBHOOK_URL=...          # Slack/Teams incoming webhook
ALERT_SMTP_HOST=...            # or email
ALERT_EMAIL_TO=...
ALERT_HEARTBEAT_URL=...        # external dead-man's-switch
```

Set `ALERT_HEARTBEAT_URL`. Nothing running on this machine can report that this machine is off.

Application logs go to the journal:

```bash
journalctl -u transaction-desk -f
journalctl -u transaction-desk --since "1 hour ago" | grep ERROR
```

---

## 14. Deploying an update

The full procedure, including what to check afterwards, is in
[`OPERATIONS.md` → Deploying](OPERATIONS.md#deploying). **Never deploy on a Friday, and never during
month-end** — month-end is when commissions are reconciled.

```bash
sudo -u transdesk -H bash
cd /srv/transaction-desk/app

# 1. Fresh backup FIRST — not last night's.
cd server && npm run backup && npm run backup:verify && cd ..

# 2. Note the current release, so "roll back" means something specific.
git rev-parse --short HEAD

# 3. Code
git pull

# 4. API
cd server && npm ci && npm run prisma:generate && npm run prisma:deploy && npm run build

# 5. SPA
cd ../client && npm ci && npm run build

# 6. Restart
exit
sudo systemctl restart transaction-desk
```

Then: `curl /api/health/ready`, sign in as an administrator **and** an agent, and watch the 5xx rate
and p95 for fifteen minutes.

**Rolling back:** check out the previous commit and rebuild. If the release included a migration,
restoring the database *is* the rollback — which is why the backup is step 1.

---

## 15. Troubleshooting

| Symptom | Cause |
|---|---|
| Service exits at boot with a numbered list | The production config check. It names every problem at once — fix what it names, do not disable it. |
| `STORAGE_ROOT "…" does not exist` | Correct behaviour. Production will not create it. Point it at the directory that already holds the files. |
| Login succeeds, next request is anonymous | `COOKIE_SECURE=false` over HTTPS, or a `CORS_ORIGINS` mismatch (trailing slash, `http`, wrong host). |
| Login bounces straight back | `COOKIE_SAMESITE=none` without `COOKIE_SECURE=true` — browsers reject the pair and drop the cookie. |
| Documents listed but every download 404s | Database restored without `storage/`, or `STORAGE_ROOT` points somewhere new. |
| Stored IMAP/Google credentials unreadable | `APP_KEY` changed. Restore the original key; there is no recovery without it. |
| Dates one day late on evening entries | `TZ` unset or not applied — set it in the systemd unit, not only `.env`. |
| 413 on upload | `client_max_body_size` below the app's 12 MB body limit. |
| Rate limits trip for a whole office | Proxy headers missing from the nginx block, so every request looks like it came from nginx. |
| `.env` ignored entirely | systemd `WorkingDirectory` is not the `server/` directory — `@nestjs/config` reads `.env` relative to cwd. |
| Meta leads stopped arriving | `META_PUBLIC_URL` unreachable or the webhook subscription lapsed. The poller is the backstop; see `OPERATIONS.md`. |
| Twilio status never updates | `TWILIO_PUBLIC_URL` unset — signature verification rebuilds the URL from it and rejects everything without it. |

---

## 16. Before you go live

- [ ] `APP_KEY` carried forward from the existing deployment.
- [ ] `SESSION_SECRET` freshly generated, 32+ characters, not the development value.
- [ ] Database password strong; Postgres not listening on a public interface.
- [ ] `ufw` enabled; only SSH and HTTPS open.
- [ ] SSH key-only authentication; root login disabled.
- [ ] TLS valid, renewal timer confirmed.
- [ ] `.env` is `chmod 600` and owned by the service user.
- [ ] Backups running **and** landing off-machine.
- [ ] A restore has actually been performed into a scratch database.
- [ ] Monitoring registered with a real alert channel and a heartbeat URL.
- [ ] OAuth redirect URIs and webhooks re-registered at the new domain with Google, Meta and Twilio.
- [ ] `unattended-upgrades` enabled for security patches.

**Read `OPERATIONS.md` → Known operational risks before onboarding anyone.** Two tenant-isolation
defects (`AUD-001`, `AUD-002`) are open. They do not affect a single-brokerage deployment, but a
second company record must not be created until they are closed.
