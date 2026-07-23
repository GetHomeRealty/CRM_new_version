# MLS + Environment Setup (this app)

> **Scope note.** The three docs shared as `ENV_KEYS_AND_SETUP.md`, `HOW_TO_GET_LIVE_API_KEYS.md`
> and `PRODUCTION_DEPLOYMENT_GUIDE.md` describe the **previous Next.js / Vercel / MongoDB /
> NextAuth** version of Get Home Realty. **This app (`myapp`) does not use that stack** — it's
> **NestJS + Prisma + PostgreSQL** (API in `server/`) and a **Vite + React SPA** (`client/`), with
> **Sanctum-cookie** auth, self-hosted (not Vercel). So `MONGODB_URI`, `NEXTAUTH_SECRET`,
> `JWT_SECRET`, all `NEXT_PUBLIC_*`, Vercel crons, and Puppeteer-on-Lambda **do not apply here**.
> The one thing that carries over verbatim is the **MLS (AMPRE) feed**, documented below.

## This app's environment (`server/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection (Prisma) |
| `PORT` | API port (default 8000) |
| `SESSION_SECRET`, `SESSION_COOKIE_NAME`, `COOKIE_*` | Sanctum-style cookie session |
| `FRONTEND_URL`, `CORS_ORIGINS` | SPA origin + CORS allow-list |
| `APP_KEY` | Laravel-compatible key for encrypted columns (SMTP passwords, OAuth tokens) |
| `CAMPAIGN_PUBLIC_URL` | Public URL for campaign open-pixel + unsubscribe tracking |
| **`MLS_API_URL`** | **MLS/RESO OData endpoint — see below** |
| **`MLS_ACCESS_TOKEN`** | **MLS bearer token — see below** |

Mail accounts (SMTP/IMAP) are **not** env vars here — they're stored per-user in the database
(`mail_accounts`) and managed in the app's Settings, unlike the legacy `SMTP_*`/`EMAIL_*` scheme.

## MLS feed (AMPRE / TRREB)

The **MLS** and **Favorites** modules proxy an external **RESO Web API (OData)** feed. Provider is
**AMPRE**, operated for **TRREB** (Toronto Regional Real Estate Board).

- `MLS_API_URL` — the Property OData resource. Default: `https://query.ampre.ca/odata/Property`
  (already set in `.env`).
- `MLS_ACCESS_TOKEN` — a **JWT** (`eyJ...`) issued to a licensed brokerage / data vendor by
  contract with the board. This is **not** self-service signup: request vendor API access from
  TRREB/AMPRE's data team. Tokens can expire — track and renew.

### Activate
1. Paste the JWT into `MLS_ACCESS_TOKEN` in `server/.env`.
2. Restart the API (`node dist/main.js`, or rebuild first if code changed).
3. `GET /api/mls/status` returns `{ "configured": true }`; the MLS screen and Favorites light up.

Until the token is present the module is **config-gated**: `GET /api/mls/status` →
`{ "configured": false }`, search/detail return **503**, and the MLS screen shows a
"not configured" banner. It never crashes the API on a missing/expired token.

### Security notes (how this port differs from the source)
- The token stays **server-side**; the browser only calls our `/api/mls` proxy.
- Every MLS route is behind **`@Screen('mls','view')`** — the source Next.js route was unauthenticated.
- OData `$filter` values are escaped/whitelisted server-side.
