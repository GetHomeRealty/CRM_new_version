# Transaction Desk

Get Home Realty's back-office system for managing real-estate transactions, commissions, legal
documents, invoices and team collaboration.

```
client/    React 19 + TypeScript SPA (Vite)
server/    NestJS 10 API (TypeScript, Prisma, PostgreSQL)
storage/   Uploaded files — documents, identification, logos, photos, exports
docs/      Operations, deployment, disaster recovery, audits
```

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React **19**, TypeScript 5.9, Vite 7, React Router 7, Axios |
| Backend | **NestJS 10** on Express, TypeScript 5.9 |
| Database | **PostgreSQL** via **Prisma 6** |
| Sessions | `express-session` + `connect-pg-simple` (stored in Postgres) |
| Runtime | **Node.js ≥ 20.19** (22 LTS recommended) |
| Tests | Jest + supertest — 44 suites, 554 tests |

Integrations: Twilio (SMS + Voice), Meta lead ads, Google Calendar, IMAP/SMTP mail, web push.
All are optional and degrade gracefully when unconfigured.

---

## Quick start

Requires Node ≥ 20.19 and a running PostgreSQL instance.

```bash
# API
cd server
npm ci
cp .env.example .env          # set DATABASE_URL, APP_KEY, SESSION_SECRET, TZ
npm run prisma:generate
npm run prisma:deploy
npm run start:dev             # http://localhost:8000

# SPA (second terminal)
cd client
npm ci
npm run dev                   # http://localhost:5173
```

Open **http://localhost:5173**.

On Windows, `start-app.ps1` launches both halves at once and `stop-app.ps1` stops them.

The first registered account becomes the bootstrap **Super Admin** — `POST /api/register` stays
open only until that account exists.

---

## Common commands

```bash
# server/
npm run start:dev        # watch mode
npm run build            # compile to dist/
npm run typecheck        # tsc --noEmit
npm test                 # full Jest suite
npm run prisma:status    # pending migrations (read-only)
npm run prisma:deploy    # apply migrations — use this, never `migrate dev`, in production
npm run backup           # database dump + storage tree
npm run backup:verify    # restore the newest set into a scratch database

# client/
npm run dev              # Vite dev server
npm run build            # typecheck, then production build to dist/
```

---

## Health

| Endpoint | Answers |
|---|---|
| `/api/health` | Is the process alive? Touches nothing. |
| `/api/health/ready` | Can it serve? Real database round trip, storage write, permission tables. |
| `/api/health/metrics` | Throughput, latency percentiles, error rate. |
| `/api/health/workers` | Background timers, export queue, per-mailbox sync age. |

Point uptime monitoring at `/ready`, not `/health` — a process that cannot reach its database is
alive and useless.

---

## Documentation

| | |
|---|---|
| [`DOCUMENTATION.md`](DOCUMENTATION.md) | Architecture, domain model, commission model, API reference |
| [`docs/VPS-DEPLOYMENT.md`](docs/VPS-DEPLOYMENT.md) | Hosting on a Linux VPS, start to finish |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Running it day to day, monitoring, deploys |
| [`docs/DISASTER-RECOVERY.md`](docs/DISASTER-RECOVERY.md) | Backup and restore |
| [`docs/MLS_AND_ENV.md`](docs/MLS_AND_ENV.md) | MLS feed and environment variables |
| [`docs/PERFORMANCE-AUDIT.md`](docs/PERFORMANCE-AUDIT.md) | Measured performance and reliability |
| [`docs/UAT.md`](docs/UAT.md) | Acceptance testing |

---

## Conventions

- **Backend-authoritative.** Commission math, invoice totals, trade numbers, document validation
  and permissions are computed server-side. The SPA renders state; it is never the source of truth
  for money or access.
- **Migrations are forward-only.** `prisma migrate deploy`. Never `migrate dev` against a database
  you care about — it resets on drift.
- **Validation whitelists.** `ValidationPipe` runs with `whitelist: true`, so a field with no DTO
  rule is stripped silently. Adding a persisted field means adding its rule.

---

## History

This project was originally built on **Laravel 12 (PHP) + MySQL** with a React SPA. It was migrated
to the current stack on 2026-07-20; the PHP application was removed in that commit and no PHP
remains.

Two things survive the migration and are intentional:

- **`storage/`** keeps the Laravel directory layout because it holds live uploaded files. The
  NestJS backend reads and writes it, and `STORAGE_ROOT` points at `storage/app`.
- **`server/src/common/laravel-*.ts`** is TypeScript that reproduces Laravel's encryption format and
  its `422 {message, errors}` validation shape, so credentials encrypted by the old stack still
  decrypt and the SPA's error handling is unchanged.
